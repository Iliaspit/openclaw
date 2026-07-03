import { describe, expect, it, vi } from "vitest";
import { resolveSessionsYieldAbortedResponse } from "./attempt.sessions-yield.js";

describe("resolveSessionsYieldAbortedResponse", () => {
  it("defers the sessions_yield abort until the next stream call", async () => {
    const controller = new AbortController();
    const abortForYield = vi.fn(() => {
      controller.abort("sessions_yield");
    });

    const response = resolveSessionsYieldAbortedResponse({
      yieldDetected: true,
      abortSignal: controller.signal as AbortSignal & { reason?: unknown },
      abortForYield,
      model: { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.4" },
    });

    expect(abortForYield).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(response).not.toBeNull();
    await expect(response?.result()).resolves.toMatchObject({ stopReason: "aborted" });
  });

  it("does nothing when no yield was requested", () => {
    const controller = new AbortController();
    const abortForYield = vi.fn();

    const response = resolveSessionsYieldAbortedResponse({
      yieldDetected: false,
      abortSignal: controller.signal as AbortSignal & { reason?: unknown },
      abortForYield,
      model: {},
    });

    expect(response).toBeNull();
    expect(abortForYield).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });

  it("does not overwrite an unrelated abort reason", () => {
    const controller = new AbortController();
    controller.abort(new Error("timeout"));
    const abortForYield = vi.fn();

    const response = resolveSessionsYieldAbortedResponse({
      yieldDetected: true,
      abortSignal: controller.signal as AbortSignal & { reason?: unknown },
      abortForYield,
      model: {},
    });

    expect(response).toBeNull();
    expect(abortForYield).not.toHaveBeenCalled();
  });
});
