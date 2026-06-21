// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CurlProbeResult } from "../adapters/http/probe";
import { runCurlProbe } from "../adapters/http/probe";
import type { AgentDefinition } from "../agent/defs";
import { getCredential, normalizeCredentialValue, saveCredential } from "../credentials/store";
import type { WebSearchConfig, WebSearchProvider } from "../inference/web-search";
import { BRAVE_API_KEY_ENV, FIRECRAWL_API_KEY_ENV } from "../inference/web-search";
import { ROOT } from "../runner";
import { classifyValidationFailure } from "../validation";
import { getTransportRecoveryMessage } from "../validation-recovery";
import {
  BACK_TO_SELECTION,
  type BackToSelection,
  isBackToSelection,
} from "./credential-navigation";
import { exitOnboardFromPrompt, isAffirmativeAnswer } from "./prompt-helpers";
import type { ValidationFailureLike } from "./types";
import { agentSupportsWebSearch } from "./web-search-support";
import { verifyWebSearchInsideSandbox as verifyWebSearchInsideSandboxWithDeps } from "./web-search-verify";

const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";
const FIRECRAWL_SEARCH_HELP_URL = "https://www.firecrawl.dev/app/api-keys";
const WEB_SEARCH_CURL_CONFIG_PREFIX = "nemoclaw-websearch-probe";
const WEB_SEARCH_API_KEY_LINE_BREAK_MESSAGE = "Web search API key must not contain line breaks.";

// Attribution header sent on the Firecrawl onboarding validation ping so the
// Firecrawl side can attribute key-validation traffic to NemoClaw onboarding.
const NEMOCLAW_ONBOARDING_CLIENT_SOURCE = "nemoclaw-onboarding";

interface WebSearchProviderSpec {
  id: WebSearchProvider;
  label: string;
  envKey: string;
  helpUrl: string;
}

const WEB_SEARCH_PROVIDER_SPECS: Record<WebSearchProvider, WebSearchProviderSpec> = {
  brave: {
    id: "brave",
    label: "Brave Search",
    envKey: BRAVE_API_KEY_ENV,
    helpUrl: BRAVE_SEARCH_HELP_URL,
  },
  firecrawl: {
    id: "firecrawl",
    label: "Firecrawl Search",
    envKey: FIRECRAWL_API_KEY_ENV,
    helpUrl: FIRECRAWL_SEARCH_HELP_URL,
  },
};

export function getWebSearchProviderSpec(provider: WebSearchProvider): WebSearchProviderSpec {
  const spec = WEB_SEARCH_PROVIDER_SPECS[provider];
  if (!spec) {
    throw new Error(`Unknown web search provider: ${provider}`);
  }
  return spec;
}

export interface WebSearchFlowDeps {
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
  note(message: string): void;
  isNonInteractive(): boolean;
  cliName(): string;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
}

export interface WebSearchFlowHelpers {
  validateBraveSearchApiKey(apiKey: string): CurlProbeResult;
  validateWebSearchApiKey(provider: WebSearchProvider, apiKey: string): CurlProbeResult;
  promptWebSearchProviderRecovery(
    spec: WebSearchProviderSpec,
    validation: ValidationFailureLike,
  ): Promise<"retry" | "skip">;
  promptWebSearchApiKey(spec: WebSearchProviderSpec): Promise<string | BackToSelection>;
  ensureValidatedBraveSearchCredential(
    nonInteractive?: boolean,
  ): Promise<string | BackToSelection | null>;
  ensureValidatedWebSearchCredential(
    spec: WebSearchProviderSpec,
    nonInteractive?: boolean,
  ): Promise<string | BackToSelection | null>;
  configureWebSearch(
    existingConfig?: WebSearchConfig | null,
    agent?: AgentDefinition | null,
    dockerfilePathOverride?: string | null,
  ): Promise<WebSearchConfig | null>;
  verifyWebSearchInsideSandbox(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
  ): void;
}

export function createWebSearchFlowHelpers(deps: WebSearchFlowDeps): WebSearchFlowHelpers {
  function escapeCurlConfigValue(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Header lines are written to a 0600 curl --config file so the API key never
  // appears in argv (visible via /proc) or process listings.
  function writeWebSearchCurlConfig(headerLines: string[]): {
    configPath: string;
    cleanup: () => void;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${WEB_SEARCH_CURL_CONFIG_PREFIX}-`));
    const configPath = path.join(dir, "curl.conf");
    const body = [...headerLines, ""].join("\n");
    try {
      fs.writeFileSync(configPath, body, { mode: 0o600 });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return {
      configPath,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  function invalidWebSearchApiKey(message: string): CurlProbeResult {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      body: "",
      stderr: "",
      message,
    };
  }

  function braveConfigLines(apiKey: string): string[] {
    const tokenHeader = escapeCurlConfigValue(`X-Subscription-Token: ${apiKey}`);
    return [
      'header = "Accept: application/json"',
      'header = "Accept-Encoding: gzip"',
      `header = "${tokenHeader}"`,
    ];
  }

  function braveSearchArgs(configPath: string): string[] {
    return [
      "-sS",
      "--compressed",
      "--config",
      configPath,
      "--get",
      "--data-urlencode",
      "q=ping",
      "--data-urlencode",
      "count=1",
      "https://api.search.brave.com/res/v1/web/search",
    ];
  }

  function validateBraveSearchApiKey(apiKey: string): CurlProbeResult {
    if (/[\r\n]/.test(apiKey)) {
      return invalidWebSearchApiKey(WEB_SEARCH_API_KEY_LINE_BREAK_MESSAGE);
    }
    const { configPath, cleanup } = writeWebSearchCurlConfig(braveConfigLines(apiKey));
    try {
      return runCurlProbe(braveSearchArgs(configPath), { trustedConfigFiles: [configPath] });
    } finally {
      cleanup();
    }
  }

  function firecrawlConfigLines(apiKey: string): string[] {
    const authHeader = escapeCurlConfigValue(`Authorization: Bearer ${apiKey}`);
    return [
      'header = "Accept: application/json"',
      'header = "Content-Type: application/json"',
      `header = "${authHeader}"`,
      `header = "X-Client-Source: ${NEMOCLAW_ONBOARDING_CLIENT_SOURCE}"`,
    ];
  }

  function firecrawlSearchArgs(configPath: string): string[] {
    // Validation ping against Firecrawl's v2 search endpoint. A minimal
    // {query, limit} body keeps credit consumption to a single result.
    return [
      "-sS",
      "--compressed",
      "-X",
      "POST",
      "--config",
      configPath,
      "-d",
      JSON.stringify({ query: "ping", limit: 1 }),
      "https://api.firecrawl.dev/v2/search",
    ];
  }

  function validateFirecrawlSearchApiKey(apiKey: string): CurlProbeResult {
    if (/[\r\n]/.test(apiKey)) {
      return invalidWebSearchApiKey(WEB_SEARCH_API_KEY_LINE_BREAK_MESSAGE);
    }
    const { configPath, cleanup } = writeWebSearchCurlConfig(firecrawlConfigLines(apiKey));
    try {
      return runCurlProbe(firecrawlSearchArgs(configPath), { trustedConfigFiles: [configPath] });
    } finally {
      cleanup();
    }
  }

  function validateWebSearchApiKey(provider: WebSearchProvider, apiKey: string): CurlProbeResult {
    return provider === "firecrawl"
      ? validateFirecrawlSearchApiKey(apiKey)
      : validateBraveSearchApiKey(apiKey);
  }

  async function promptWebSearchProviderRecovery(
    spec: WebSearchProviderSpec,
    validation: ValidationFailureLike,
  ): Promise<"retry" | "skip"> {
    const recovery = classifyValidationFailure(validation);

    if (recovery.kind === "credential") {
      console.log(`  ${spec.label} rejected that API key.`);
    } else if (recovery.kind === "transport") {
      console.log(getTransportRecoveryMessage(validation));
    } else {
      console.log(`  ${spec.label} validation did not succeed.`);
    }

    const answer = (await deps.prompt("  Type 'retry', 'skip', or 'exit' [retry]: "))
      .trim()
      .toLowerCase();
    if (answer === "skip") return "skip";
    if (answer === "exit" || answer === "quit") {
      exitOnboardFromPrompt();
    }
    return "retry";
  }

  async function promptWebSearchApiKey(
    spec: WebSearchProviderSpec,
  ): Promise<string | BackToSelection> {
    console.log("");
    console.log(`  Get your ${spec.label} API key from: ${spec.helpUrl}`);
    console.log("");

    while (true) {
      const value = await deps.prompt(`  ${spec.label} API key: `, { secret: true });
      const intent = normalizeCredentialValue(value).toLowerCase();
      if (intent === "back") return BACK_TO_SELECTION;
      if (intent === "exit" || intent === "quit") {
        exitOnboardFromPrompt();
      }
      if (intent === "?" || intent === "help") {
        console.log("  Type back to choose again, or exit to quit.");
        continue;
      }
      const key = normalizeCredentialValue(value);
      if (!key) {
        console.error(`  ${spec.label} API key is required.`);
        continue;
      }
      return key;
    }
  }

  async function ensureValidatedWebSearchCredential(
    spec: WebSearchProviderSpec,
    nonInteractive = deps.isNonInteractive(),
  ): Promise<string | BackToSelection | null> {
    const savedApiKey = getCredential(spec.envKey);
    let apiKey: string | null = savedApiKey || normalizeCredentialValue(process.env[spec.envKey]);
    let usingSavedKey = Boolean(savedApiKey);

    while (true) {
      if (!apiKey) {
        if (nonInteractive) {
          throw new Error(
            `${spec.label} requires ${spec.envKey} or a saved ${spec.label} credential in non-interactive mode.`,
          );
        }
        const promptedApiKey = await promptWebSearchApiKey(spec);
        if (isBackToSelection(promptedApiKey)) {
          return promptedApiKey;
        }
        apiKey = promptedApiKey;
        usingSavedKey = false;
      }

      const validation = validateWebSearchApiKey(spec.id, apiKey);
      if (validation.ok) {
        saveCredential(spec.envKey, apiKey);
        process.env[spec.envKey] = apiKey;
        return apiKey;
      }

      const prefix = usingSavedKey
        ? `  Saved ${spec.label} API key validation failed.`
        : `  ${spec.label} API key validation failed.`;
      console.error(prefix);
      if (validation.message) {
        console.error(`  ${validation.message}`);
      }

      if (nonInteractive) {
        throw new Error(
          validation.message ||
            `${spec.label} API key validation failed in non-interactive mode.`,
        );
      }

      const action = await promptWebSearchProviderRecovery(spec, validation);
      if (action === "skip") {
        console.log(`  Skipping ${spec.label} setup.`);
        console.log("");
        return null;
      }

      apiKey = null;
      usingSavedKey = false;
    }
  }

  async function ensureValidatedBraveSearchCredential(
    nonInteractive = deps.isNonInteractive(),
  ): Promise<string | BackToSelection | null> {
    return ensureValidatedWebSearchCredential(getWebSearchProviderSpec("brave"), nonInteractive);
  }

  // Brave wins when both keys are present — preserves OpenClaw's auto-detect
  // precedence (Brave is ahead of Firecrawl in its provider order) and avoids
  // silently flipping a user's runtime provider on upgrade. Firecrawl is only
  // auto-selected in non-interactive mode when it's the only key set.
  function resolveNonInteractiveWebSearchProvider(): WebSearchProvider | null {
    const braveKey =
      getCredential(BRAVE_API_KEY_ENV) || normalizeCredentialValue(process.env[BRAVE_API_KEY_ENV]);
    const firecrawlKey =
      getCredential(FIRECRAWL_API_KEY_ENV) ||
      normalizeCredentialValue(process.env[FIRECRAWL_API_KEY_ENV]);
    if (braveKey) return "brave";
    if (firecrawlKey) return "firecrawl";
    return null;
  }

  // Firecrawl supports a keyless starter tier for `web_fetch` (page extraction)
  // only; web_search and firecrawl_scrape require an API key. Let the user opt
  // into keyless fetch instead of entering a key. Returns "keyed" to continue
  // to API-key collection, "keyless" for the no-key web_fetch path, or
  // BACK_TO_SELECTION to return to the provider picker.
  async function promptFirecrawlKeyMode(): Promise<"keyed" | "keyless" | BackToSelection> {
    console.log("");
    console.log("  Firecrawl offers a keyless starter tier for web fetch (page extraction).");
    console.log("  Web search and firecrawl_scrape require an API key.");
    console.log("    [1] I have a Firecrawl API key (enables web search + web fetch)");
    console.log("    [2] Keyless — web fetch only, no API key");
    while (true) {
      const raw = (await deps.prompt("  Choose [1-2]: ")).trim().toLowerCase();
      if (raw === "" || raw === "1" || raw === "key" || raw === "keyed") return "keyed";
      if (raw === "2" || raw === "keyless") return "keyless";
      if (raw === "back") return BACK_TO_SELECTION;
      if (raw === "exit" || raw === "quit") {
        exitOnboardFromPrompt();
      }
      console.log("  Enter 1 or 2 (or 'back').");
    }
  }

  async function promptWebSearchProvider(): Promise<WebSearchProvider | null> {
    console.log("");
    console.log("  Enable web search for your agent?");
    console.log("    [1] No web search (default)");
    console.log("    [2] Brave Search");
    console.log("    [3] Firecrawl Search");
    while (true) {
      const raw = (await deps.prompt("  Choose [1-3]: ")).trim();
      if (raw === "" || raw === "1" || /^n(o)?$/i.test(raw)) return null;
      if (raw === "2" || /^brave$/i.test(raw)) return "brave";
      if (raw === "3" || /^firecrawl$/i.test(raw)) return "firecrawl";
      console.log("  Enter 1, 2, or 3.");
    }
  }

  async function configureWebSearch(
    existingConfig: WebSearchConfig | null = null,
    agent: AgentDefinition | null = null,
    dockerfilePathOverride: string | null = null,
  ): Promise<WebSearchConfig | null> {
    if (!agentSupportsWebSearch(agent, dockerfilePathOverride, ROOT)) {
      deps.note(
        `  Web search is not yet supported by ${agent?.displayName ?? "this agent"}. Skipping.`,
      );
      return null;
    }

    if (existingConfig) {
      const provider =
        existingConfig.provider === "firecrawl" || existingConfig.provider === "brave"
          ? existingConfig.provider
          : "brave";
      const keyless = provider === "firecrawl" && existingConfig.keyless === true;
      return { fetchEnabled: true, provider, ...(keyless ? { keyless: true } : {}) };
    }

    if (deps.isNonInteractive()) {
      const provider = resolveNonInteractiveWebSearchProvider();
      if (!provider) {
        return null;
      }
      const spec = getWebSearchProviderSpec(provider);
      const apiKey =
        getCredential(spec.envKey) || normalizeCredentialValue(process.env[spec.envKey]);
      deps.note(`  [non-interactive] ${spec.label} requested.`);
      const validation = validateWebSearchApiKey(spec.id, apiKey);
      if (!validation.ok) {
        console.warn(
          `  ${spec.label} API key validation failed. Web search will be disabled — re-enable later via \`${deps.cliName()} config web-search\`.`,
        );
        if (validation.message) {
          console.warn(`  ${validation.message}`);
        }
        return null;
      }
      saveCredential(spec.envKey, apiKey);
      process.env[spec.envKey] = apiKey;
      return { fetchEnabled: true, provider };
    }

    const provider = await promptWebSearchProvider();
    if (!provider) {
      return null;
    }

    const spec = getWebSearchProviderSpec(provider);

    // Firecrawl: offer the keyless web_fetch tier before collecting a key.
    if (provider === "firecrawl") {
      const mode = await promptFirecrawlKeyMode();
      if (isBackToSelection(mode)) {
        return configureWebSearch(existingConfig, agent, dockerfilePathOverride);
      }
      if (mode === "keyless") {
        console.log("  ✓ Enabled Firecrawl (keyless web fetch — no web search)");
        console.log("");
        return { fetchEnabled: true, provider, keyless: true };
      }
    }

    const apiKey = await ensureValidatedWebSearchCredential(spec);
    if (isBackToSelection(apiKey)) {
      return configureWebSearch(existingConfig, agent, dockerfilePathOverride);
    }
    if (!apiKey) {
      return null;
    }

    console.log(`  ✓ Enabled ${spec.label}`);
    console.log("");
    return { fetchEnabled: true, provider };
  }

  function verifyWebSearchInsideSandbox(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
  ): void {
    verifyWebSearchInsideSandboxWithDeps(sandboxName, agent, {
      runCaptureOpenshell: deps.runCaptureOpenshell,
      cliName: deps.cliName,
    });
  }

  return {
    validateBraveSearchApiKey,
    validateWebSearchApiKey,
    promptWebSearchProviderRecovery,
    promptWebSearchApiKey,
    ensureValidatedBraveSearchCredential,
    ensureValidatedWebSearchCredential,
    configureWebSearch,
    verifyWebSearchInsideSandbox,
  };
}
