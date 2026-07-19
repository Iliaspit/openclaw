import { describe, expect, it } from "vitest";
import {
  resolveSessionsSendRouteRegistryRecord,
  shouldRejectSessionSendVisibility,
} from "./sessions-send-tool.js";

describe("guarded sessions_send visibility", () => {
  it("lets protected route authority supersede generic cross-agent visibility", () => {
    expect(
      shouldRejectSessionSendVisibility({
        accessAllowed: false,
        controlledChild: false,
        guardedRoute: true,
      }),
    ).toBe(false);
  });

  it("retains generic visibility denial for unguarded sends", () => {
    expect(
      shouldRejectSessionSendVisibility({
        accessAllowed: false,
        controlledChild: false,
        guardedRoute: false,
      }),
    ).toBe(true);
  });
});

describe("guarded sessions_send restart recovery", () => {
  it("restores child ownership from protected route authority after registry loss", () => {
    expect(
      resolveSessionsSendRouteRegistryRecord({
        childSessionKey: "agent:tester:subagent:child-1",
        guardedRoute: true,
      }),
    ).toEqual({ childSessionKey: "agent:tester:subagent:child-1" });
  });

  it("does not trust an untracked child for an unguarded route", () => {
    expect(
      resolveSessionsSendRouteRegistryRecord({
        childSessionKey: "agent:tester:subagent:child-1",
        guardedRoute: false,
      }),
    ).toBeUndefined();
  });
});
