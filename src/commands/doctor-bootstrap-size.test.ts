import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveBootstrapContextForRun = vi.hoisted(() => vi.fn());
const resolveBootstrapMaxChars = vi.hoisted(() => vi.fn(() => 20_000));
const resolveBootstrapTotalMaxChars = vi.hoisted(() => vi.fn(() => 150_000));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
}));

vi.mock("../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun,
}));

vi.mock("../agents/pi-embedded-helpers.js", () => ({
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
}));

import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";

describe("noteBootstrapFileSize", () => {
  beforeEach(() => {
    note.mockClear();
    resolveBootstrapContextForRun.mockReset();
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
  });

  it("emits a warning when bootstrap files are truncated", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "TOOLS.md",
          path: "/tmp/workspace/TOOLS.md",
          content: "a".repeat(25_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/TOOLS.md", content: "a".repeat(20_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] ?? [];
    expect(String(title)).toBe("Bootstrap file size");
    expect(String(message)).toContain("will be truncated");
    expect(String(message)).toContain("TOOLS.md");
    expect(String(message)).toContain("max/file");
    expect(resolveBootstrapContextForRun).toHaveBeenCalledWith(
      expect.objectContaining({ allowPolicyTruncationForDiagnostics: true }),
    );
  });

  it("warns when AGENTS.md is close to the total policy budget", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(120_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(120_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] ?? [];
    expect(String(message)).toContain("near configured limits");
    expect(String(message)).toContain("80% of max/total 150,000");
    expect(String(message)).toContain("bootstrapTotalMaxChars");
    expect(String(message)).not.toContain("bootstrapMaxChars");
  });

  it("stays silent when files are comfortably within limits", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(1_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(1_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).not.toHaveBeenCalled();
  });
});
