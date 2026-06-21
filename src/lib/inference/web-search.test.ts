// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { BRAVE_API_KEY_ENV, FIRECRAWL_API_KEY_ENV, webSearchEnvFor } from "./web-search";

describe("web-search module", () => {
  it("exports BRAVE_API_KEY_ENV constant", () => {
    expect(BRAVE_API_KEY_ENV).toBe("BRAVE_API_KEY");
  });

  it("exports FIRECRAWL_API_KEY_ENV constant", () => {
    expect(FIRECRAWL_API_KEY_ENV).toBe("FIRECRAWL_API_KEY");
  });

  it("webSearchEnvFor maps providers to env var names", () => {
    expect(webSearchEnvFor("brave")).toBe("BRAVE_API_KEY");
    expect(webSearchEnvFor("firecrawl")).toBe("FIRECRAWL_API_KEY");
  });
});
