// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCurlProbe } from "../adapters/http/probe";
import { createWebSearchFlowHelpers } from "./web-search-flow";

vi.mock("../adapters/http/probe", () => ({
  runCurlProbe: vi.fn(() => ({
    ok: true,
    httpStatus: 200,
    curlStatus: 0,
    body: "{}",
    stderr: "",
    message: "ok",
  })),
}));

vi.mock("../runner", () => ({
  ROOT: "/tmp/nemoclaw-web-search-flow-test",
}));

// Keyless test exercises configureWebSearch end-to-end; force the agent gate on.
vi.mock("./web-search-support", () => ({
  agentSupportsWebSearch: () => true,
}));

function webSearchProbeTempDirs(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith("nemoclaw-websearch-probe-"))
    .sort();
}

function helpers() {
  return createWebSearchFlowHelpers({
    prompt: async () => "",
    note: () => {},
    isNonInteractive: () => true,
    cliName: () => "nemoclaw",
    runCaptureOpenshell: () => null,
  });
}

function helpersWithPrompts(answers: string[]) {
  let i = 0;
  return createWebSearchFlowHelpers({
    prompt: async () => answers[i++] ?? "",
    note: () => {},
    isNonInteractive: () => false,
    cliName: () => "nemoclaw",
    runCaptureOpenshell: () => null,
  });
}

describe("web search flow keyless Firecrawl", () => {
  beforeEach(() => {
    vi.mocked(runCurlProbe).mockClear();
  });

  it("returns a keyless web_fetch config without collecting or validating a key", async () => {
    // Provider pick "3" = Firecrawl; key mode "2" = keyless web fetch.
    const result = await helpersWithPrompts(["3", "2"]).configureWebSearch();
    expect(result).toEqual({ fetchEnabled: true, provider: "firecrawl", keyless: true });
    // The keyless path must never reach the API-key validation probe.
    expect(runCurlProbe).not.toHaveBeenCalled();
  });
});

describe("web search flow Brave validation", () => {
  beforeEach(() => {
    vi.mocked(runCurlProbe).mockClear();
  });

  it.each([
    ["LF", "brv-good-prefix\nconfig = injected"],
    ["CR", "brv-good-prefix\rconfig = injected"],
  ])("rejects %s-bearing keys before writing a trusted curl config", (_label, apiKey) => {
    const before = webSearchProbeTempDirs();

    const result = helpers().validateBraveSearchApiKey(apiKey);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("must not contain line breaks");
    expect(runCurlProbe).not.toHaveBeenCalled();
    expect(webSearchProbeTempDirs()).toEqual(before);
  });
});

describe("web search flow Firecrawl validation", () => {
  beforeEach(() => {
    vi.mocked(runCurlProbe).mockClear();
  });

  it.each([
    ["LF", "fc-good-prefix\nconfig = injected"],
    ["CR", "fc-good-prefix\rconfig = injected"],
  ])("rejects %s-bearing keys before writing a trusted curl config", (_label, apiKey) => {
    const before = webSearchProbeTempDirs();

    const result = helpers().validateWebSearchApiKey("firecrawl", apiKey);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("must not contain line breaks");
    expect(runCurlProbe).not.toHaveBeenCalled();
    expect(webSearchProbeTempDirs()).toEqual(before);
  });

  it("probes the Firecrawl v2 search endpoint with a Bearer auth config", () => {
    const result = helpers().validateWebSearchApiKey("firecrawl", "fc-test-key");

    expect(result.ok).toBe(true);
    expect(runCurlProbe).toHaveBeenCalledTimes(1);
    const [args, options] = vi.mocked(runCurlProbe).mock.calls[0];
    expect(args).toContain("https://api.firecrawl.dev/v2/search");
    expect(args).toContain("POST");
    // The API key travels only through the 0600 --config file, never argv.
    expect(args.join(" ")).not.toContain("fc-test-key");
    expect(options?.trustedConfigFiles?.length).toBe(1);
  });

  it("routes brave through validateWebSearchApiKey to the Brave endpoint", () => {
    const result = helpers().validateWebSearchApiKey("brave", "brv-test-key");

    expect(result.ok).toBe(true);
    const [args] = vi.mocked(runCurlProbe).mock.calls[0];
    expect(args).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(args.join(" ")).not.toContain("brv-test-key");
  });
});
