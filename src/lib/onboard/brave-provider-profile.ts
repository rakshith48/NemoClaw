// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { compactText } from "../core/url-utils";

export const BRAVE_PROVIDER_PROFILE_ID = "brave";
export const FIRECRAWL_PROVIDER_PROFILE_ID = "firecrawl";

// OpenShell provider-profile ids that back the selectable web-search providers.
// Each maps to a YAML profile under nemoclaw-blueprint/provider-profiles/ that
// teaches the L7 proxy how to inject the provider's auth header.
const WEB_SEARCH_PROVIDER_PROFILE_IDS = [
  BRAVE_PROVIDER_PROFILE_ID,
  FIRECRAWL_PROVIDER_PROFILE_ID,
] as const;

/**
 * Single source of truth for "the user opted in to Brave Search at runtime."
 * Returning true on a config whose `fetchEnabled` is false would cause
 * `createSandbox` to push a Brave provider/token and trip the BRAVE_API_KEY-
 * required abort even when the feature is off, while the downstream
 * finalization/verifier paths already gate on `fetchEnabled`. Keep every gate
 * routed through this helper so they stay aligned.
 */
export function shouldEnableBraveWebSearch(
  webSearchConfig: { fetchEnabled?: boolean | null } | null | undefined,
): boolean {
  return Boolean(webSearchConfig?.fetchEnabled);
}

export type BraveProviderProfileDeps = {
  root: string;
  runOpenshell: (
    args: string[],
    // The runner accepts a wider options shape; we only set ignoreError +
    // stdio here, so erase the type at the boundary to keep this module
    // free of the runner.ts internals.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: any,
  ) => { status: number | null; stderr?: string | Buffer | null; stdout?: string | Buffer | null };
  redact: (input: string) => string;
  log?: (message?: string) => void;
  exit?: (code?: number) => never;
};

type TokenDefShape = { providerType?: string; token: string | null };

function bufferOrStringToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as Buffer).toString === "function")
    return (value as Buffer).toString();
  return "";
}

export function braveProviderProfilePath(root: string): string {
  return webSearchProviderProfilePath(root, BRAVE_PROVIDER_PROFILE_ID);
}

export function webSearchProviderProfilePath(root: string, providerProfileId: string): string {
  return path.join(root, "nemoclaw-blueprint", "provider-profiles", `${providerProfileId}.yaml`);
}

const WEB_SEARCH_PROVIDER_LABELS: Record<string, string> = {
  [BRAVE_PROVIDER_PROFILE_ID]: "Brave Search",
  [FIRECRAWL_PROVIDER_PROFILE_ID]: "Firecrawl Search",
};

/**
 * Register the web-search provider profiles (Brave, Firecrawl) with OpenShell
 * so providers created with `--type <provider>` drive the L7 proxy's auth
 * header rewrite (X-Subscription-Token for Brave, Authorization: Bearer for
 * Firecrawl). Only the profiles actually referenced by a usable token def are
 * imported. Idempotent: tolerates OpenShell reporting an already-registered
 * profile.
 */
export function ensureWebSearchProviderProfiles(
  tokenDefs: readonly TokenDefShape[],
  deps: BraveProviderProfileDeps,
): void {
  const errorLog = deps.log ?? console.error;
  const exit = deps.exit ?? ((code?: number) => process.exit(code));

  for (const providerProfileId of WEB_SEARCH_PROVIDER_PROFILE_IDS) {
    const needs = tokenDefs.some(
      ({ providerType, token }) => providerType === providerProfileId && Boolean(token),
    );
    if (!needs) continue;

    const result = deps.runOpenshell(
      ["provider", "profile", "import", "--file", webSearchProviderProfilePath(deps.root, providerProfileId)],
      { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status === 0) continue;

    // OpenShell reports re-imports of an already-registered custom profile as
    // a non-zero exit. Tolerate that so re-onboard / recreate keeps working.
    const rawDiagnostic = `${bufferOrStringToText(result.stderr)} ${bufferOrStringToText(result.stdout)}`;
    if (/already exists/i.test(rawDiagnostic)) continue;

    const label = WEB_SEARCH_PROVIDER_LABELS[providerProfileId] ?? providerProfileId;
    const diagnostic = compactText(deps.redact(rawDiagnostic));
    errorLog(`\n  ✗ Failed to register the ${label} provider profile with OpenShell.`);
    if (diagnostic) errorLog(`    ${diagnostic.slice(0, 500)}`);
    errorLog("    Update OpenShell with scripts/install-openshell.sh and re-run onboarding.");
    exit(result.status || 1);
  }
}

/**
 * Back-compat shim: callers that only registered Brave now register all
 * referenced web-search provider profiles. Retained so existing import sites
 * keep working without a churny rename.
 */
export function ensureBraveProviderProfile(
  tokenDefs: readonly TokenDefShape[],
  deps: BraveProviderProfileDeps,
): void {
  ensureWebSearchProviderProfiles(tokenDefs, deps);
}
