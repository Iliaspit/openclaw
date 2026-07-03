import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isCatalogToolEnabledForOpenClawTools } from "./openclaw-tools.registration.js";

describe("openclaw-tools catalog gating", () => {
  it("keeps catalog disabled by default", () => {
    expect(
      isCatalogToolEnabledForOpenClawTools({
        config: {} as OpenClawConfig,
      }),
    ).toBe(false);
  });

  it("registers catalog when explicitly enabled", () => {
    expect(
      isCatalogToolEnabledForOpenClawTools({
        config: {
          tools: {
            catalog: { enabled: true },
          },
        } as OpenClawConfig,
      }),
    ).toBe(true);
  });
});
