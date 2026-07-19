import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DelegationGuardConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export const DELEGATION_TEST_WORKER_IDS = [
  "helper",
  "implementer",
  "tester",
  "reviewer",
  "qa",
] as const;

const WORKERS: DelegationGuardConfig["workers"] = [
  {
    agentId: "helper",
    role: "helper",
    requiredThinking: "xhigh",
    workspaceAccess: "ro",
  },
  {
    agentId: "implementer",
    role: "implementer",
    requiredThinking: "xhigh",
    workspaceAccess: "rw",
  },
  {
    agentId: "tester",
    role: "tester",
    requiredThinking: "medium",
    workspaceAccess: "ro",
  },
  {
    agentId: "reviewer",
    role: "reviewer",
    requiredThinking: "high",
    workspaceAccess: "ro",
  },
  {
    agentId: "qa",
    role: "qa",
    requiredThinking: "medium",
    workspaceAccess: "ro",
  },
];

function sandbox(workspaceAccess: "ro" | "rw") {
  return {
    mode: "all" as const,
    backend: "docker",
    scope: "session" as const,
    workspaceAccess,
  };
}

export function installDelegationTestValidator(rootDir: string): {
  entrypoint: string;
  sha256: string;
} {
  const protectedDir = path.join(rootDir, "protected");
  const entrypoint = path.join(protectedDir, "validator.mjs");
  const source = Buffer.from("process.stdout.write('{}\\n');\n", "utf8");
  mkdirSync(protectedDir, { recursive: true, mode: 0o700 });
  writeFileSync(entrypoint, source, { mode: 0o400 });
  chmodSync(entrypoint, 0o400);
  return {
    entrypoint,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

export function createDelegationGuardTestConfig(params?: {
  rootDir?: string;
  validator?: { entrypoint: string; sha256: string };
  enabled?: boolean;
  mode?: "audit" | "enforce";
}): OpenClawConfig {
  const rootDir = params?.rootDir ?? "/tmp/openclaw-delegation-test";
  const validator = params?.validator ?? {
    entrypoint: "/opt/openclaw/protected/delegation-validator.mjs",
    sha256: "a".repeat(64),
  };
  const controllers: DelegationGuardConfig["controllers"] = [
    { agentId: "planner", requiredThinking: "xhigh" },
    { agentId: "planner2", requiredThinking: "xhigh" },
  ];
  return {
    agents: {
      delegationGuard: {
        enabled: params?.enabled ?? true,
        mode: params?.mode ?? "enforce",
        controllers,
        workers: structuredClone(WORKERS),
        validator: {
          id: "delegation-test-validator",
          version: "1.0.0",
          sha256: validator.sha256,
          entrypoint: validator.entrypoint,
          maxOutputBytes: 64 * 1024,
        },
      },
      list: [
        ...controllers.map((controller) => ({
          id: controller.agentId,
          workspace: path.join(rootDir, "workspaces", controller.agentId),
          model: { primary: "openai/gpt-5.4", fallbacks: [] },
          thinkingDefault: "xhigh" as const,
          runtime: { type: "embedded" as const },
          sandbox: sandbox("ro"),
          subagents: { allowAgents: [...DELEGATION_TEST_WORKER_IDS] },
        })),
        ...WORKERS.map((worker) => ({
          id: worker.agentId,
          workspace: path.join(rootDir, "workspaces", worker.agentId),
          model: { primary: "openai/gpt-5.4", fallbacks: [] },
          thinkingDefault: worker.requiredThinking,
          runtime: { type: "embedded" as const },
          sandbox: sandbox(worker.workspaceAccess),
        })),
        {
          id: "outsider",
          workspace: path.join(rootDir, "workspaces", "outsider"),
          model: "openai/gpt-5.4",
        },
      ],
    },
  };
}
