import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegationRuntime } from "../delegation/runtime.js";
import { createDelegationGuardTestConfig } from "../delegation/test-helpers.js";
import {
  appendGuardedVerifierImageMountArgs,
  assertGuardedVerifierGatewayWorkspaceMount,
} from "./docker.js";
import {
  assertGuardedVerifierExecutionCurrent,
  resolveGuardedVerifierSandboxConfig,
} from "./guarded-verifier-runtime.js";
import type { SandboxConfig } from "./types.js";

const SESSION_KEY = "agent:tester:subagent:guarded-verifier";
const SOURCE_REVISION = "a".repeat(40);
const IMAGE_ID = `sha256:${"9".repeat(64)}`;
const FINGERPRINT = {
  contractVersion: "openclaw-delegation-v1" as const,
  candidateId: "candidate_verifier",
  candidateDigest: "b".repeat(64),
  contextDigest: "c".repeat(64),
  scopeDigest: "d".repeat(64),
  worktreeIdentity: "e".repeat(64),
  head: "f".repeat(40),
  epoch: 14,
  pathCount: 1,
  dirtyCount: 0,
  validatorId: "validator",
  validatorVersion: "1",
  validatorDigest: "1".repeat(64),
  policyDigest: "2".repeat(64),
  truncated: false as const,
};

const authorizationDeps = {
  canonicalWorkspace: async () => "/repo",
  assertAssignmentScopeCurrent: async () => {},
  requireCurrentCandidate: async () => ({
    candidateId: "candidate_verifier",
    fingerprint: FINGERPRINT,
  }),
  sourceRevision: () => SOURCE_REVISION,
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_VERIFIER_IMAGE_ID", IMAGE_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function sandbox(): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "session",
    workspaceAccess: "ro",
    workspaceRoot: "/sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      network: "none",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      enableNoVnc: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

function runtime(
  overrides: Record<string, unknown> = {},
  options: { terminal?: boolean } = {},
): DelegationRuntime {
  const config = createDelegationGuardTestConfig();
  const guard = config.agents?.delegationGuard;
  if (!guard) {
    throw new Error("delegation guard test config is missing");
  }
  const assignment = {
    assignmentId: "assignment_verifier",
    workerAgentId: "tester",
    role: "tester",
    workspaceAccess: "ro",
    candidateId: "candidate_verifier",
    waveId: "wave_verifier",
    epoch: 14,
    ...overrides,
  };
  return {
    guard,
    policyDigest: "a".repeat(64),
    ledger: {
      resolveAssignmentForChildSession: (sessionKey: string) =>
        sessionKey === SESSION_KEY ? assignment : undefined,
      currentEpoch: () => 14,
      assertAssignmentOpenForExecution: () => {
        if (options.terminal) {
          throw new Error("Delegation assignment is already terminal");
        }
      },
      captureProtectedEvidenceForAssignment: () => ({
        assignment,
        candidate: { candidateId: "candidate_verifier", fingerprint: FINGERPRINT },
      }),
      getSliceScope: () => ({ repositoryRoot: "/repo", epoch: 14 }),
    },
  } as unknown as DelegationRuntime;
}

describe("guarded verifier sandbox runtime", () => {
  it("selects the dedicated image only for an exact active verifier assignment", async () => {
    const config = createDelegationGuardTestConfig();
    expect(
      await resolveGuardedVerifierSandboxConfig({
        config,
        agentId: "tester",
        sessionKey: SESSION_KEY,
        sandbox: sandbox(),
        runtime: runtime(),
        workspaceDir: "/repo",
        deps: authorizationDeps,
      }),
    ).toMatchObject({
      guardedVerifierRuntime: true,
      docker: {
        image: IMAGE_ID,
        network: "none",
        readOnlyRoot: true,
        capDrop: ["ALL"],
        binds: undefined,
        dns: undefined,
        extraHosts: undefined,
        setupCommand: undefined,
        user: "1000:1000",
      },
      browser: { enabled: false, autoStart: false, allowHostControl: false },
    });

    expect(
      await resolveGuardedVerifierSandboxConfig({
        config,
        agentId: "helper",
        sessionKey: "agent:helper:subagent:ordinary",
        sandbox: sandbox(),
      }),
    ).toEqual(sandbox());
  });

  it("preserves ordinary tester sandboxes in audit mode without a protected assignment", async () => {
    const config = createDelegationGuardTestConfig();
    config.agents!.delegationGuard!.mode = "audit";
    await expect(
      resolveGuardedVerifierSandboxConfig({
        config,
        agentId: "tester",
        sessionKey: SESSION_KEY,
        sandbox: sandbox(),
      }),
    ).resolves.toEqual(sandbox());
  });

  it.each([
    { label: "unbound", sessionKey: "agent:tester:subagent:unknown", runtime: runtime() },
    {
      label: "wrong worker",
      sessionKey: SESSION_KEY,
      runtime: runtime({ workerAgentId: "reviewer" }),
    },
    { label: "wrong role", sessionKey: SESSION_KEY, runtime: runtime({ role: "reviewer" }) },
    {
      label: "writable assignment",
      sessionKey: SESSION_KEY,
      runtime: runtime({ workspaceAccess: "rw" }),
    },
    { label: "stale epoch", sessionKey: SESSION_KEY, runtime: runtime({ epoch: 13 }) },
    {
      label: "missing candidate",
      sessionKey: SESSION_KEY,
      runtime: runtime({ candidateId: undefined }),
    },
    { label: "missing wave", sessionKey: SESSION_KEY, runtime: runtime({ waveId: undefined }) },
  ])("fails closed for a $label verifier identity", async ({ sessionKey, runtime }) => {
    await expect(
      resolveGuardedVerifierSandboxConfig({
        config: createDelegationGuardTestConfig(),
        agentId: "tester",
        sessionKey,
        sandbox: sandbox(),
        runtime,
        workspaceDir: "/repo",
        deps: authorizationDeps,
      }),
    ).rejects.toThrow("current bound read-only frozen-wave assignment");
  });

  it("rejects terminal assignments and missing initialized ledgers", async () => {
    await expect(
      resolveGuardedVerifierSandboxConfig({
        config: createDelegationGuardTestConfig(),
        agentId: "tester",
        sessionKey: SESSION_KEY,
        sandbox: sandbox(),
        runtime: runtime({}, { terminal: true }),
        workspaceDir: "/repo",
        deps: authorizationDeps,
      }),
    ).rejects.toThrow("already terminal");
    await expect(
      resolveGuardedVerifierSandboxConfig({
        config: createDelegationGuardTestConfig(),
        agentId: "tester",
        sessionKey: SESSION_KEY,
        sandbox: sandbox(),
        workspaceDir: "/repo",
        deps: authorizationDeps,
      }),
    ).rejects.toThrow("initialized enforcing ledger");
  });

  it("rejects stale candidate fingerprints and mismatched protected workspaces", async () => {
    await expect(
      resolveGuardedVerifierSandboxConfig({
        config: createDelegationGuardTestConfig(),
        agentId: "tester",
        sessionKey: SESSION_KEY,
        sandbox: sandbox(),
        runtime: runtime(),
        workspaceDir: "/other",
        deps: { ...authorizationDeps, canonicalWorkspace: async () => "/other" },
      }),
    ).rejects.toThrow("protected assignment slice");
    await expect(
      resolveGuardedVerifierSandboxConfig({
        config: createDelegationGuardTestConfig(),
        agentId: "tester",
        sessionKey: SESSION_KEY,
        sandbox: sandbox(),
        runtime: runtime(),
        workspaceDir: "/repo",
        deps: {
          ...authorizationDeps,
          requireCurrentCandidate: async () => ({
            candidateId: "candidate_verifier",
            fingerprint: { ...FINGERPRINT, candidateDigest: "9".repeat(64) },
          }),
        },
      }),
    ).rejects.toThrow("identity changed during authorization");
  });

  it("revalidates the complete protected identity immediately before execution", async () => {
    const config = createDelegationGuardTestConfig();
    const resolved = await resolveGuardedVerifierSandboxConfig({
      config,
      agentId: "tester",
      sessionKey: SESSION_KEY,
      sandbox: sandbox(),
      runtime: runtime(),
      workspaceDir: "/repo",
      deps: authorizationDeps,
    });
    const expectedAuthorization = resolved.guardedVerifierAuthorization;
    if (!expectedAuthorization) {
      throw new Error("guarded verifier authorization missing");
    }
    await expect(
      assertGuardedVerifierExecutionCurrent({
        config,
        agentId: "tester",
        sessionKey: SESSION_KEY,
        workspaceDir: "/repo",
        runtime: runtime(),
        expectedAuthorization,
        deps: {
          ...authorizationDeps,
          requireCurrentCandidate: async () => ({
            candidateId: "candidate_verifier",
            fingerprint: {
              ...FINGERPRINT,
              head: "9".repeat(40),
            },
          }),
        },
      }),
    ).rejects.toThrow("changed before execution");
  });

  it.each([
    { label: "non-Docker backend", mutate: (value: SandboxConfig) => (value.backend = "ssh") },
    { label: "non-session scope", mutate: (value: SandboxConfig) => (value.scope = "agent") },
    {
      label: "writable workspace",
      mutate: (value: SandboxConfig) => (value.workspaceAccess = "rw"),
    },
    {
      label: "custom bind",
      mutate: (value: SandboxConfig) => (value.docker.binds = ["/tmp/source:/extra:ro"]),
    },
  ])("rejects a $label protected verifier profile", async ({ mutate }) => {
    const configured = sandbox();
    mutate(configured);
    await expect(
      resolveGuardedVerifierSandboxConfig({
        config: createDelegationGuardTestConfig(),
        agentId: "tester",
        sessionKey: SESSION_KEY,
        sandbox: configured,
        runtime: runtime(),
        workspaceDir: "/repo",
        deps: authorizationDeps,
      }),
    ).rejects.toThrow("not eligible for toolchain mounting");
  });

  it("emits exact immutable OCI subpath mounts without a Docker socket", () => {
    const mounts = [
      {
        imageId: IMAGE_ID,
        target: "/workspace/node_modules",
        subpath: "opt/openclaw-verifier/dependencies",
        readOnly: true as const,
      },
      {
        imageId: IMAGE_ID,
        target: "/home/node/.cache/ms-playwright",
        subpath: "opt/openclaw-verifier/browsers",
        readOnly: true as const,
      },
    ];
    const args: string[] = [];
    appendGuardedVerifierImageMountArgs(args, mounts);
    expect(args).toEqual([
      "--mount",
      `type=image,src=${IMAGE_ID},dst=/workspace/node_modules,readonly,image-subpath=opt/openclaw-verifier/dependencies`,
      "--mount",
      `type=image,src=${IMAGE_ID},dst=/home/node/.cache/ms-playwright,readonly,image-subpath=opt/openclaw-verifier/browsers`,
    ]);
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("type=bind");
  });

  it("requires one exact read-only Gateway workspace bind", () => {
    expect(
      assertGuardedVerifierGatewayWorkspaceMount({
        mounts: [{ Type: "bind", Source: "/host/repo", Destination: "/repo", RW: false }],
        workspaceDir: "/repo",
      }),
    ).toBe("/host/repo");
    expect(() =>
      assertGuardedVerifierGatewayWorkspaceMount({
        mounts: [{ Type: "bind", Source: "/host/repo", Destination: "/repo", RW: true }],
        workspaceDir: "/repo",
      }),
    ).toThrow("read-only bind");
  });
});
