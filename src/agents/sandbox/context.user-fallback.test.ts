import { describe, expect, it } from "vitest";
import { createDelegationGuardTestConfig } from "../delegation/test-helpers.js";
import { resolveSandboxDockerUser, resolveSandboxPrimaryWorkspaceDir } from "./context.js";
import type { SandboxDockerConfig } from "./types.js";

const baseDocker: SandboxDockerConfig = {
  image: "ghcr.io/example/sandbox:latest",
  containerPrefix: "openclaw-sandbox-",
  workdir: "/workspace",
  readOnlyRoot: true,
  tmpfs: ["/tmp"],
  network: "none",
  capDrop: ["ALL"],
};

describe("resolveSandboxDockerUser", () => {
  it("keeps configured docker.user", async () => {
    const resolved = await resolveSandboxDockerUser({
      docker: { ...baseDocker, user: "2000:2000" },
      workspaceDir: "/tmp/unused",
      stat: async () => ({ uid: 1000, gid: 1000 }),
    });
    expect(resolved.user).toBe("2000:2000");
  });

  it("falls back to workspace ownership when docker.user is unset", async () => {
    const resolved = await resolveSandboxDockerUser({
      docker: baseDocker,
      workspaceDir: "/tmp/workspace",
      stat: async () => ({ uid: 1001, gid: 1002 }),
    });
    expect(resolved.user).toBe("1001:1002");
  });

  it("leaves docker.user unset when workspace stat fails", async () => {
    const resolved = await resolveSandboxDockerUser({
      docker: baseDocker,
      workspaceDir: "/tmp/workspace",
      stat: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(resolved.user).toBeUndefined();
  });
});

describe("resolveSandboxPrimaryWorkspaceDir", () => {
  const agentWorkspaceDir = "/tmp/assigned-workspace";
  const sandboxWorkspaceDir = "/tmp/sandbox-staging";

  it("mounts a guarded read-only agent workspace as the primary workspace", () => {
    expect(
      resolveSandboxPrimaryWorkspaceDir({
        config: createDelegationGuardTestConfig(),
        agentId: "planner",
        workspaceAccess: "ro",
        agentWorkspaceDir,
        sandboxWorkspaceDir,
      }),
    ).toBe(agentWorkspaceDir);
  });

  it("preserves copied staging workspaces for unguarded read-only sessions", () => {
    expect(
      resolveSandboxPrimaryWorkspaceDir({
        config: {},
        agentId: "planner",
        workspaceAccess: "ro",
        agentWorkspaceDir,
        sandboxWorkspaceDir,
      }),
    ).toBe(sandboxWorkspaceDir);
  });

  it("preserves existing read-write and no-workspace behavior", () => {
    const config = createDelegationGuardTestConfig();
    expect(
      resolveSandboxPrimaryWorkspaceDir({
        config,
        agentId: "implementer",
        workspaceAccess: "rw",
        agentWorkspaceDir,
        sandboxWorkspaceDir,
      }),
    ).toBe(agentWorkspaceDir);
    expect(
      resolveSandboxPrimaryWorkspaceDir({
        config,
        agentId: "planner",
        workspaceAccess: "none",
        agentWorkspaceDir,
        sandboxWorkspaceDir,
      }),
    ).toBe(sandboxWorkspaceDir);
  });
});
