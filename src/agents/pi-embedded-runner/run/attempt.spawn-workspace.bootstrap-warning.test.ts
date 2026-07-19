import { describe, expect, it } from "vitest";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  prependBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import { composeSystemPromptWithHookContext } from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt bootstrap warning prompt assembly", () => {
  it("keeps bootstrap warnings in the sent prompt after hook prepend context", () => {
    const analysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles: [
          {
            name: "TOOLS.md",
            path: "/tmp/openclaw-warning-workspace/TOOLS.md",
            content: "A".repeat(200),
            missing: false,
          },
        ],
        injectedFiles: [{ path: "TOOLS.md", content: "A".repeat(20) }],
      }),
      bootstrapMaxChars: 50,
      bootstrapTotalMaxChars: 50,
    });
    const warning = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    const promptWithWarning = prependBootstrapPromptWarning("hello", warning.lines);
    const systemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: promptWithWarning,
      prependSystemContext: "hook context",
    });

    expect(systemPrompt).toContain("hook context");
    expect(systemPrompt).toContain("[Bootstrap context budget warning]");
    expect(systemPrompt).toContain("- TOOLS.md: 200 raw -> 20 injected");
    expect(systemPrompt).toContain("hello");
  });
});
