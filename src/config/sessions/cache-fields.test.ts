import { describe, expect, it } from "vitest";
import type { SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

describe("SessionEntry cache fields", () => {
  it("supports cacheRead and cacheWrite fields", () => {
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1500,
      cacheWrite: 300,
    };

    expect(entry.cacheRead).toBe(1500);
    expect(entry.cacheWrite).toBe(300);
  });

  it("merges cache fields properly", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1000,
      cacheWrite: 200,
      totalTokens: 5000,
    };

    const patch: Partial<SessionEntry> = {
      cacheRead: 1500,
      cacheWrite: 300,
    };

    const merged = mergeSessionEntry(existing, patch);

    expect(merged.cacheRead).toBe(1500);
    expect(merged.cacheWrite).toBe(300);
    expect(merged.totalTokens).toBe(5000); // Preserved from existing
  });

  it("handles undefined cache fields", () => {
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      totalTokens: 5000,
    };

    expect(entry.cacheRead).toBeUndefined();
    expect(entry.cacheWrite).toBeUndefined();
  });

  it("allows cache fields to be cleared with undefined", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1000,
      cacheWrite: 200,
    };

    const patch: Partial<SessionEntry> = {
      cacheRead: undefined,
      cacheWrite: undefined,
    };

    const merged = mergeSessionEntry(existing, patch);

    expect(merged.cacheRead).toBeUndefined();
    expect(merged.cacheWrite).toBeUndefined();
  });

  it("preserves context high-water context tokens when an equal patch is stale", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      contextHighWaterTokens: 100_000,
      contextHighWaterContextTokens: 200_000,
    };

    const patch: Partial<SessionEntry> = {
      contextHighWaterTokens: 100_000,
      contextHighWaterContextTokens: 128_000,
    };

    const merged = mergeSessionEntry(existing, patch);

    expect(merged.contextHighWaterTokens).toBe(100_000);
    expect(merged.contextHighWaterContextTokens).toBe(200_000);
  });

  it("uses patch context tokens only when the patch high-water is strictly newer", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      contextHighWaterTokens: 100_000,
      contextHighWaterContextTokens: 200_000,
    };

    const patch: Partial<SessionEntry> = {
      contextHighWaterTokens: 125_000,
      contextHighWaterContextTokens: 128_000,
    };

    const merged = mergeSessionEntry(existing, patch);

    expect(merged.contextHighWaterTokens).toBe(125_000);
    expect(merged.contextHighWaterContextTokens).toBe(128_000);
  });
});
