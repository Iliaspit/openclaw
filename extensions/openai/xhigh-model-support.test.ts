import { describe, expect, it } from "vitest";
import { supportsOpenAiFamilyXHighModelId } from "./xhigh-model-support.js";

describe("supportsOpenAiFamilyXHighModelId", () => {
  it("allows gpt-5 family and codex ids", () => {
    expect(supportsOpenAiFamilyXHighModelId("gpt-5.4")).toBe(true);
    expect(supportsOpenAiFamilyXHighModelId("gpt-5.9-codex-preview")).toBe(true);
    expect(supportsOpenAiFamilyXHighModelId("gpt-5.3-codex-spark")).toBe(true);
    expect(supportsOpenAiFamilyXHighModelId("o4-mini")).toBe(true);
    expect(supportsOpenAiFamilyXHighModelId("o3-pro")).toBe(true);
    expect(supportsOpenAiFamilyXHighModelId("o1-preview")).toBe(true);
  });

  it("rejects non-reasoning-era ids", () => {
    expect(supportsOpenAiFamilyXHighModelId("gpt-4o")).toBe(false);
    expect(supportsOpenAiFamilyXHighModelId("gpt-3.5-turbo")).toBe(false);
    expect(supportsOpenAiFamilyXHighModelId("")).toBe(false);
  });
});
