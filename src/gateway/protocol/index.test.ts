import type { ErrorObject } from "ajv";
import { describe, expect, it } from "vitest";
import { TALK_TEST_PROVIDER_ID } from "../../test-utils/talk-test-provider.js";
import {
  formatValidationErrors,
  validateQueueHealthResult,
  validateTalkConfigResult,
} from "./index.js";

const makeError = (overrides: Partial<ErrorObject>): ErrorObject => ({
  keyword: "type",
  instancePath: "",
  schemaPath: "#/",
  params: {},
  message: "validation error",
  ...overrides,
});

describe("formatValidationErrors", () => {
  it("returns unknown validation error when missing errors", () => {
    expect(formatValidationErrors(undefined)).toBe("unknown validation error");
    expect(formatValidationErrors(null)).toBe("unknown validation error");
  });

  it("returns unknown validation error when errors list is empty", () => {
    expect(formatValidationErrors([])).toBe("unknown validation error");
  });

  it("formats additionalProperties at root", () => {
    const err = makeError({
      keyword: "additionalProperties",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at root: unexpected property 'token'");
  });

  it("formats additionalProperties with instancePath", () => {
    const err = makeError({
      keyword: "additionalProperties",
      instancePath: "/auth",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at /auth: unexpected property 'token'");
  });

  it("formats message with path for other errors", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err])).toBe("at /auth: must have required property 'token'");
  });

  it("de-dupes repeated entries", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err, err])).toBe(
      "at /auth: must have required property 'token'",
    );
  });
});

describe("validateTalkConfigResult", () => {
  it("accepts Talk SecretRef payloads", () => {
    expect(
      validateTalkConfigResult({
        config: {
          talk: {
            provider: TALK_TEST_PROVIDER_ID,
            providers: {
              [TALK_TEST_PROVIDER_ID]: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "ELEVENLABS_API_KEY",
                },
              },
            },
            resolved: {
              provider: TALK_TEST_PROVIDER_ID,
              config: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "ELEVENLABS_API_KEY",
                },
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects normalized talk payloads without talk.resolved", () => {
    expect(
      validateTalkConfigResult({
        config: {
          talk: {
            provider: TALK_TEST_PROVIDER_ID,
            providers: {
              [TALK_TEST_PROVIDER_ID]: {
                voiceId: "voice-normalized",
              },
            },
          },
        },
      }),
    ).toBe(false);
  });
});

describe("validateQueueHealthResult", () => {
  const queueHealthResult = {
    ts: 123,
    gatewayDraining: false,
    totalQueued: 1,
    totalActive: 1,
    totalDepth: 2,
    totalRuntimeIssues: 1,
    runtimeIssues: [
      {
        runId: "run-planner-abandoned",
        code: "agent_lifecycle_abandoned",
        severity: "warning",
        message: "Agent ended without a visible reply after replay-invalid work.",
        observedAt: 100,
        lastUpdatedAt: 120,
        count: 1,
        sessionKey: "main",
        lane: "session:main",
        livenessState: "abandoned",
      },
    ],
    lanes: [
      {
        lane: "session:main",
        health: "degraded",
        queued: 1,
        active: 1,
        depth: 2,
        maxConcurrent: 1,
        isOverloaded: true,
        draining: false,
        oldestQueuedAt: 100,
        oldestQueuedMs: 25,
        oldestActiveStartedAt: 90,
        oldestActiveMs: 35,
        lastWaitMs: 20,
        lastDequeuedAt: 95,
        lastTaskDurationMs: null,
        lastCompletedAt: null,
        lastErrorAt: null,
        lastClearedAt: null,
        runtimeIssues: [
          {
            runId: "run-planner-abandoned",
            code: "agent_lifecycle_abandoned",
            severity: "warning",
            message: "Agent ended without a visible reply after replay-invalid work.",
            observedAt: 100,
            lastUpdatedAt: 120,
            count: 1,
            sessionKey: "main",
            lane: "session:main",
            livenessState: "abandoned",
          },
        ],
      },
    ],
  };

  it("accepts additive queue health runtime and overload fields", () => {
    expect(validateQueueHealthResult(queueHealthResult)).toBe(true);
  });

  it("rejects rich runtime issue payload fields", () => {
    expect(
      validateQueueHealthResult({
        ...queueHealthResult,
        runtimeIssues: [
          {
            ...queueHealthResult.runtimeIssues[0],
            prompt: "do not expose transcript text here",
          },
        ],
      }),
    ).toBe(false);
  });
});
