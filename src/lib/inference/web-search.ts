// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type WebSearchProvider = "brave" | "firecrawl";

export interface WebSearchConfig {
  fetchEnabled: boolean;
  provider: WebSearchProvider;
  // Firecrawl-only: the user opted into Firecrawl's keyless starter tier, which
  // OpenClaw supports for `web_fetch` only (web_search and firecrawl_scrape
  // require an API key). When true, no API key is collected, no web-search
  // provider is configured, and only the keyless `web_fetch` fallback is wired
  // up. Ignored for providers other than `firecrawl`.
  keyless?: boolean;
}

export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";
export const FIRECRAWL_API_KEY_ENV = "FIRECRAWL_API_KEY";

export function webSearchEnvFor(provider: WebSearchProvider): string {
  return provider === "firecrawl" ? FIRECRAWL_API_KEY_ENV : BRAVE_API_KEY_ENV;
}
