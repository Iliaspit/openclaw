import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../../plugin-sdk/windows-spawn.js";
import { createPrimaryAndSecondaryAggregateError } from "../aggregate-error.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";
import type { EnvSanitizationOptions } from "./sanitize-env-vars.js";

type ExecDockerRawOptions = {
  allowFailure?: boolean;
  input?: Buffer | string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ExecDockerRawResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

type ExecDockerRawError = Error & {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
};

function createAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

type DockerSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_DOCKER_SPAWN_RUNTIME: DockerSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

export function resolveDockerSpawnInvocation(
  args: string[],
  runtime: DockerSpawnRuntime = DEFAULT_DOCKER_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  const program = resolveWindowsSpawnProgram({
    command: "docker",
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "docker",
    allowShellFallback: false,
  });
  const resolved = materializeWindowsSpawnProgram(program, args);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

export function execDockerRaw(
  args: string[],
  opts?: ExecDockerRawOptions,
): Promise<ExecDockerRawResult> {
  return new Promise<ExecDockerRawResult>((resolve, reject) => {
    const spawnInvocation = resolveDockerSpawnInvocation(args);
    const child = spawn(spawnInvocation.command, spawnInvocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: spawnInvocation.shell,
      windowsHide: spawnInvocation.windowsHide,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;

    const signal = opts?.signal;
    const handleAbort = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
    };
    const timeout = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    timeout?.unref();
    if (signal) {
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort);
      }
    }

    child.stdout?.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (opts?.maxOutputBytes && outputBytes > opts.maxOutputBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stderr?.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (opts?.maxOutputBytes && outputBytes > opts.maxOutputBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stderrChunks.push(buffer);
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        const friendly = Object.assign(
          new Error(
            'Sandbox mode requires Docker, but the "docker" command was not found in PATH. Install Docker (and ensure "docker" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing.',
          ),
          { code: "INVALID_CONFIG", cause: error },
        );
        reject(friendly);
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (aborted || signal?.aborted) {
        reject(createAbortError());
        return;
      }
      if (timedOut) {
        reject(new Error("Docker command exceeded its wall-clock deadline."));
        return;
      }
      if (outputExceeded) {
        reject(new Error("Docker command exceeded its output byte limit."));
        return;
      }
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        const message = stderr.length > 0 ? stderr.toString("utf8").trim() : "";
        const error: ExecDockerRawError = Object.assign(
          new Error(message || `docker ${args.join(" ")} failed`),
          {
            code: exitCode,
            stdout,
            stderr,
          },
        );
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });

    const stdin = child.stdin;
    if (stdin) {
      if (opts?.input !== undefined) {
        stdin.end(opts.input);
      } else {
        stdin.end();
      }
    }
  });
}

import { formatCliCommand } from "../../cli/command-format.js";
import { markOpenClawExecEnv } from "../../infra/openclaw-exec-env.js";
import { defaultRuntime } from "../../runtime.js";
import { canonicalDelegationJson } from "../delegation/identity.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { DEFAULT_SANDBOX_IMAGE, GUARDED_VERIFIER_BROWSER_CACHE } from "./constants.js";
import { captureGuardedVerifierRepositoryIdentity } from "./guarded-verifier-provenance.js";
import { readRegistry, removeRegistryEntryExact, updateRegistry } from "./registry.js";
import { resolveSandboxAgentId, resolveSandboxScopeKey, slugifySessionKey } from "./shared.js";
import type {
  GuardedVerifierAuthorization,
  SandboxConfig,
  SandboxDockerConfig,
  SandboxWorkspaceAccess,
} from "./types.js";
import { validateSandboxSecurity } from "./validate-sandbox-security.js";
import { appendWorkspaceMountArgs, SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

const log = createSubsystemLogger("docker");

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const GUARDED_VERIFIER_EXECUTION_DEADLINE_MS = 60_000;
const GUARDED_VERIFIER_DEPENDENCY_ROOT = "opt/openclaw-verifier/dependencies";
const GUARDED_VERIFIER_MASKED_PATHS = [
  "/proc/acpi",
  "/proc/asound",
  "/proc/interrupts",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/sched_debug",
  "/proc/scsi",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/sys/devices/virtual/powercap",
  "/sys/firmware",
].toSorted();
const GUARDED_VERIFIER_READONLY_PATHS = [
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/sys",
  "/proc/sysrq-trigger",
].toSorted();

const DockerMountSchema = z
  .object({
    Type: z.string(),
    Name: z.string().optional(),
    Source: z.string().optional(),
    Destination: z.string().min(1),
    Driver: z.string().optional(),
    Mode: z.string().optional(),
    RW: z.boolean(),
    Propagation: z.string().optional(),
    ImageOptions: z
      .object({
        Subpath: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GuardedVerifierImageMount = {
  imageId: string;
  target: string;
  subpath: string;
  readOnly: true;
};

export type GuardedVerifierRuntimeIdentity = {
  imageId: string;
  runtimeImageId: string;
  imageRevision: string;
  packageManager: string;
  effectiveYarnVersion: string;
  containerEnvironment: string[];
  artifactDigest: string;
  dependencyManifestDigest: string;
  browserManifestDigest: string;
  repositoryIdentityDigest: string;
  browserIdentityDigest: string;
  /** Internal daemon bind source. Never serialize this into protected evidence or labels. */
  workspaceMountSource: string;
  workspaceMountSourceDigest: string;
  imageMounts: GuardedVerifierImageMount[];
};

export type EnsuredSandboxContainer = {
  containerName: string;
  containerId: string;
  guardedVerifierExecution?: {
    configHash: string;
    runtimeIdentity: GuardedVerifierRuntimeIdentity;
    authorization: GuardedVerifierAuthorization;
    workspaceDir: string;
    workspaceMountSource: string;
    workdir: string;
    tmpfs: string[];
  };
};

export function assertGuardedVerifierGatewayWorkspaceMount(params: {
  mounts: unknown;
  workspaceDir: string;
}): string {
  const mounts = z.array(DockerMountSchema).parse(params.mounts);
  const matches = mounts.filter(
    (entry) => path.resolve(entry.Destination) === path.resolve(params.workspaceDir),
  );
  const source = matches[0]?.Source?.trim() ?? "";
  if (
    matches.length !== 1 ||
    matches[0].Type !== "bind" ||
    matches[0].RW ||
    !path.isAbsolute(source)
  ) {
    throw new Error("Guarded verifier Gateway workspace must be one exact read-only bind.");
  }
  return source;
}

export function appendGuardedVerifierImageMountArgs(
  args: string[],
  mounts: GuardedVerifierImageMount[] | undefined,
): void {
  for (const mount of mounts ?? []) {
    args.push(
      "--mount",
      `type=image,src=${mount.imageId},dst=${mount.target},readonly,image-subpath=${mount.subpath}`,
    );
  }
}

const DockerSelfInspectSchema = z
  .object({
    Id: z.string().regex(/^[a-f0-9]{64}$/u),
    Image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    Config: z.object({ Hostname: z.string().min(1) }),
    State: z.object({ Running: z.boolean() }),
    Mounts: z.array(DockerMountSchema),
  })
  .passthrough();

const DockerImageInspectSchema = z
  .object({
    Id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    Config: z.object({
      User: z.string().min(1),
      Env: z.array(z.string()),
      WorkingDir: z.string(),
      Entrypoint: z.array(z.string()).nullable(),
      Cmd: z.array(z.string()).nullable(),
      Labels: z.record(z.string(), z.string().nullable()),
    }),
  })
  .passthrough();

const DockerVerifierContainerSchema = z
  .object({
    Id: z.string().regex(/^[a-f0-9]{64}$/u),
    Created: z.string(),
    Path: z.string(),
    Args: z.array(z.string()),
    ResolvConfPath: z.string(),
    HostnamePath: z.string(),
    HostsPath: z.string(),
    LogPath: z.string(),
    Name: z.string().startsWith("/"),
    RestartCount: z.number().int().nonnegative(),
    Driver: z.string(),
    Platform: z.string(),
    ImageManifestDescriptor: z
      .object({
        mediaType: z.string(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        size: z.number().int().nonnegative(),
        urls: z.array(z.string()).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
        data: z.string().optional(),
        artifactType: z.string().optional(),
        platform: z
          .object({
            architecture: z.string(),
            os: z.string(),
            "os.version": z.string().optional(),
            "os.features": z.array(z.string()).optional(),
            variant: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    MountLabel: z.string(),
    ProcessLabel: z.string(),
    ExecIDs: z.array(z.string()).nullable(),
    Image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    Config: z
      .object({
        Hostname: z.string(),
        Domainname: z.string(),
        User: z.string().min(1),
        AttachStdin: z.boolean(),
        AttachStdout: z.boolean(),
        AttachStderr: z.boolean(),
        ExposedPorts: z.record(z.string(), z.unknown()).nullable().optional(),
        Tty: z.boolean(),
        OpenStdin: z.boolean(),
        StdinOnce: z.boolean(),
        Env: z.array(z.string()),
        Cmd: z.array(z.string()).nullable(),
        Healthcheck: z.record(z.string(), z.unknown()).nullable().optional(),
        ArgsEscaped: z.boolean().optional(),
        Image: z.string().min(1),
        Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
        WorkingDir: z.string(),
        Entrypoint: z.array(z.string()).nullable(),
        NetworkDisabled: z.boolean().optional(),
        MacAddress: z.string().optional(),
        OnBuild: z.array(z.string()).nullable().optional(),
        Labels: z.record(z.string(), z.string().nullable()),
        StopSignal: z.string().nullable().optional(),
        StopTimeout: z.number().int().nullable().optional(),
        Shell: z.array(z.string()).nullable().optional(),
      })
      .strict(),
    State: z
      .object({
        Status: z.string(),
        Running: z.boolean(),
        Paused: z.boolean(),
        Restarting: z.boolean(),
        OOMKilled: z.boolean(),
        Dead: z.boolean(),
        Pid: z.number().int().nonnegative(),
        ExitCode: z.number().int(),
        Error: z.string(),
        StartedAt: z.string(),
        FinishedAt: z.string(),
        Health: z
          .object({
            Status: z.string(),
            FailingStreak: z.number().int().nonnegative(),
            Log: z.array(z.unknown()),
          })
          .strict()
          .optional(),
      })
      .strict(),
    AppArmorProfile: z.string(),
    GraphDriver: z
      .object({
        Data: z.record(z.string(), z.string()).nullable(),
        Name: z.string(),
      })
      .strict(),
    SizeRw: z.number().int().optional(),
    SizeRootFs: z.number().int().optional(),
    HostConfig: z
      .object({
        Annotations: z.record(z.string(), z.string()).nullable().optional(),
        AutoRemove: z.boolean(),
        Binds: z.array(z.string()).nullable().optional(),
        BlkioDeviceReadBps: z.array(z.unknown()).nullable(),
        BlkioDeviceReadIOps: z.array(z.unknown()).nullable(),
        BlkioDeviceWriteBps: z.array(z.unknown()).nullable(),
        BlkioDeviceWriteIOps: z.array(z.unknown()).nullable(),
        BlkioWeight: z.number().int().nonnegative(),
        BlkioWeightDevice: z.array(z.unknown()).nullable(),
        CapAdd: z.array(z.string()).nullable().optional(),
        CapDrop: z.array(z.string()).nullable().optional(),
        Cgroup: z.string(),
        CgroupnsMode: z.string(),
        CgroupParent: z.string(),
        ConsoleSize: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
        ContainerIDFile: z.string(),
        CpuCount: z.number().int().nonnegative(),
        CpuPercent: z.number().int().nonnegative(),
        CpuPeriod: z.number().int().nonnegative(),
        CpuQuota: z.number().int(),
        CpuRealtimePeriod: z.number().int().nonnegative(),
        CpuRealtimeRuntime: z.number().int(),
        CpuShares: z.number().int().nonnegative(),
        CpusetCpus: z.string(),
        CpusetMems: z.string(),
        DeviceCgroupRules: z.array(z.string()).nullable().optional(),
        DeviceRequests: z.array(z.unknown()).nullable().optional(),
        Devices: z.array(z.unknown()).nullable().optional(),
        Dns: z.array(z.string()).nullable().optional(),
        DnsOptions: z.array(z.string()).nullable().optional(),
        DnsSearch: z.array(z.string()).nullable().optional(),
        ExtraHosts: z.array(z.string()).nullable().optional(),
        GroupAdd: z.array(z.string()).nullable().optional(),
        IpcMode: z.string(),
        Isolation: z.string(),
        Init: z.boolean().nullable(),
        LogConfig: z
          .object({
            Type: z.string(),
            Config: z.record(z.string(), z.string()),
          })
          .strict(),
        Memory: z.number().int().nonnegative(),
        MemoryReservation: z.number().int().nonnegative(),
        MemorySwap: z.number().int(),
        MemorySwappiness: z.number().int().min(0).max(100).nullable(),
        NanoCpus: z.number().int().nonnegative(),
        IOMaximumBandwidth: z.number().int().nonnegative(),
        IOMaximumIOps: z.number().int().nonnegative(),
        Links: z.array(z.string()).nullable().optional(),
        LxcConf: z.array(z.unknown()).nullable().optional(),
        NetworkMode: z.string(),
        OomKillDisable: z.boolean().nullable(),
        OomScoreAdj: z.number().int(),
        PortBindings: z.record(z.string(), z.unknown()).nullable().optional(),
        PidMode: z.string(),
        PidsLimit: z.number().int().nullable(),
        Privileged: z.boolean(),
        PublishAllPorts: z.boolean(),
        ReadonlyRootfs: z.boolean(),
        Runtime: z.string(),
        Sysctls: z.record(z.string(), z.string()).nullable().optional(),
        UTSMode: z.string(),
        UseApiSocket: z.boolean().optional(),
        UsernsMode: z.string(),
        VolumeDriver: z.string(),
        VolumesFrom: z.array(z.string()).nullable().optional(),
        RestartPolicy: z.object({
          Name: z.string(),
          MaximumRetryCount: z.number().int().nonnegative(),
        }),
        SecurityOpt: z.array(z.string()).nullable().optional(),
        ShmSize: z.number().int().nonnegative(),
        StorageOpt: z.record(z.string(), z.string()).nullable().optional(),
        Tmpfs: z.record(z.string(), z.string()).nullable().optional(),
        Ulimits: z
          .array(
            z.object({
              Name: z.string(),
              Soft: z.number().int(),
              Hard: z.number().int(),
            }),
          )
          .nullable()
          .optional(),
        MaskedPaths: z.array(z.string()).nullable().optional(),
        ReadonlyPaths: z.array(z.string()).nullable().optional(),
        Mounts: z
          .array(
            z
              .object({
                Type: z.string(),
                Source: z.string(),
                Target: z.string(),
                ReadOnly: z.boolean(),
                ImageOptions: z
                  .object({
                    Subpath: z.string(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .nullable()
          .optional(),
      })
      .strict(),
    NetworkSettings: z
      .object({
        Bridge: z.string(),
        SandboxID: z.string(),
        SandboxKey: z.string(),
        Ports: z.record(z.string(), z.unknown()).nullable(),
        HairpinMode: z.boolean(),
        LinkLocalIPv6Address: z.string(),
        LinkLocalIPv6PrefixLen: z.number().int().nonnegative(),
        SecondaryIPAddresses: z.array(z.unknown()).nullable(),
        SecondaryIPv6Addresses: z.array(z.unknown()).nullable(),
        EndpointID: z.string(),
        Gateway: z.string(),
        GlobalIPv6Address: z.string(),
        GlobalIPv6PrefixLen: z.number().int().nonnegative(),
        IPAddress: z.string(),
        IPPrefixLen: z.number().int().nonnegative(),
        IPv6Gateway: z.string(),
        MacAddress: z.string(),
        Networks: z.record(
          z.string(),
          z
            .object({
              IPAMConfig: z.record(z.string(), z.unknown()).nullable(),
              Links: z.array(z.string()).nullable(),
              Aliases: z.array(z.string()).nullable(),
              MacAddress: z.string(),
              DriverOpts: z.record(z.string(), z.string()).nullable(),
              GwPriority: z.number().int().optional(),
              NetworkID: z.string(),
              EndpointID: z.string(),
              Gateway: z.string(),
              IPAddress: z.string(),
              IPPrefixLen: z.number().int().nonnegative(),
              IPv6Gateway: z.string(),
              GlobalIPv6Address: z.string(),
              GlobalIPv6PrefixLen: z.number().int().nonnegative(),
              DNSNames: z.array(z.string()).nullable().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    Mounts: z.array(DockerMountSchema),
  })
  .strict();

function canonicalizeEnvironment(entries: string[]): string[] {
  const values = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error("Guarded verifier image or container environment is malformed.");
    }
    const key = entry.slice(0, separator);
    if (values.has(key)) {
      throw new Error("Guarded verifier image or container environment has duplicate keys.");
    }
    values.set(key, entry.slice(separator + 1));
  }
  return [...values]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

function resolveGuardedVerifierContainerEnvironment(imageEnvironment: string[]): string[] {
  const environment = canonicalizeEnvironment(imageEnvironment);
  const withoutMarker = environment.filter((entry) => !entry.startsWith("OPENCLAW_CLI="));
  return [...withoutMarker, "OPENCLAW_CLI=1"].toSorted();
}

function normalizeTmpfsSize(value: string): string {
  const match = /^([0-9]+)([kmgt])?$/iu.exec(value);
  if (!match) {
    throw new Error("Guarded verifier tmpfs size is malformed.");
  }
  const base = BigInt(match[1]);
  const power = { "": 0, k: 1, m: 2, g: 3, t: 4 }[
    (match[2] ?? "").toLowerCase() as "" | "k" | "m" | "g" | "t"
  ];
  return String(base * 1024n ** BigInt(power));
}

function canonicalizeTmpfsOptions(value: string): string {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const raw of value.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator === -1) {
      if (flags.has(entry)) {
        throw new Error("Guarded verifier tmpfs options contain duplicate flags.");
      }
      flags.add(entry);
      continue;
    }
    const key = entry.slice(0, separator);
    const optionValue = entry.slice(separator + 1);
    if (values.has(key) || !optionValue) {
      throw new Error("Guarded verifier tmpfs options contain duplicate values.");
    }
    values.set(key, key === "size" ? normalizeTmpfsSize(optionValue) : optionValue);
  }
  if (
    !flags.has("rw") ||
    !flags.has("nosuid") ||
    !flags.has("nodev") ||
    !flags.has("noexec") ||
    flags.has("ro") ||
    flags.has("suid") ||
    flags.has("dev") ||
    flags.has("exec") ||
    values.get("uid") !== "1000" ||
    values.get("gid") !== "1000" ||
    values.get("mode") !== "1777" ||
    !values.has("size")
  ) {
    throw new Error("Guarded verifier tmpfs isolation options are incomplete.");
  }
  return [
    ...[...flags].toSorted(),
    ...[...values]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, optionValue]) => `${key}=${optionValue}`),
  ].join(",");
}

async function inspectDockerJson<T>(params: {
  args: string[];
  schema: z.ZodType<T>;
  maxBytes?: number;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<T> {
  if (params.signal?.aborted) {
    throw createAbortError();
  }
  const timeoutMs =
    params.deadlineAt === undefined
      ? 10_000
      : Math.min(10_000, Math.max(0, params.deadlineAt - Date.now()));
  if (timeoutMs <= 0) {
    throw new Error("Guarded verifier execution inspection exceeded its deadline.");
  }
  const result = await execDocker(params.args, {
    maxOutputBytes: params.maxBytes ?? 2 * 1024 * 1024,
    signal: params.signal,
    timeoutMs,
  });
  if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
    throw new Error("Guarded verifier execution inspection exceeded its deadline.");
  }
  return params.schema.parse(JSON.parse(result.stdout) as unknown);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function inspectGuardedVerifierRuntimeIdentity(params: {
  workspaceDir: string;
  workdir: string;
  authorization: GuardedVerifierAuthorization;
}): Promise<GuardedVerifierRuntimeIdentity> {
  const hostname = os.hostname();
  if (!/^[a-f0-9]{12,64}$/u.test(hostname)) {
    throw new Error("Guarded verifier provisioning requires a Docker gateway identity.");
  }
  const self = await inspectDockerJson({
    args: ["inspect", hostname],
    schema: z
      .array(DockerSelfInspectSchema)
      .length(1)
      .transform((entries) => entries[0]),
  });
  if (self.Config.Hostname !== hostname || !self.Id.startsWith(hostname) || !self.State.Running) {
    throw new Error("Guarded verifier provisioning did not inspect the running Gateway itself.");
  }
  const workspaceMountSource = assertGuardedVerifierGatewayWorkspaceMount({
    mounts: self.Mounts,
    workspaceDir: params.workspaceDir,
  });
  const imageId = process.env.OPENCLAW_VERIFIER_IMAGE_ID?.trim() ?? "";
  const artifactDigest = process.env.OPENCLAW_VERIFIER_ARTIFACT_DIGEST?.trim() ?? "";
  const dependencyManifestDigest = process.env.OPENCLAW_VERIFIER_DEPENDENCY_MANIFEST?.trim() ?? "";
  const browserManifestDigest = process.env.OPENCLAW_VERIFIER_BROWSER_MANIFEST?.trim() ?? "";
  const repositoryIdentityDigest = process.env.OPENCLAW_VERIFIER_REPOSITORY_IDENTITY?.trim() ?? "";
  const browserIdentityDigest = process.env.OPENCLAW_VERIFIER_BROWSER_IDENTITY?.trim() ?? "";
  const effectiveYarnVersion = process.env.OPENCLAW_VERIFIER_EFFECTIVE_YARN_VERSION?.trim() ?? "";
  if (
    !IMAGE_ID.test(imageId) ||
    !SHA256.test(artifactDigest) ||
    !SHA256.test(dependencyManifestDigest) ||
    !SHA256.test(browserManifestDigest) ||
    !SHA256.test(repositoryIdentityDigest) ||
    !SHA256.test(browserIdentityDigest) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[+-][A-Za-z0-9._-]+)?$/u.test(effectiveYarnVersion) ||
    artifactDigest !==
      sha256(
        canonicalDelegationJson({
          dependencies: dependencyManifestDigest,
          browsers: browserManifestDigest,
        }),
      )
  ) {
    throw new Error("Guarded verifier published OCI identity is missing or malformed.");
  }
  const image = await inspectDockerJson({
    args: ["image", "inspect", imageId],
    schema: z
      .array(DockerImageInspectSchema)
      .length(1)
      .transform((entries) => entries[0]),
  });
  assertGuardedVerifierImageIdentity({
    image,
    imageId,
    runtimeImageId: self.Image,
    sourceRevision: params.authorization.sourceRevision,
    repositoryHead: params.authorization.repositoryHead,
    artifactDigest,
    dependencyManifestDigest,
    browserManifestDigest,
    repositoryIdentityDigest,
    browserIdentityDigest,
    effectiveYarnVersion,
  });
  const imageRevision = image.Config.Labels["org.opencontainers.image.revision"]?.trim();
  const packageManager = image.Config.Labels["ai.openclaw.sandbox.package-manager"]?.trim();
  if (!imageRevision || !packageManager) {
    throw new Error("Guarded verifier image labels disappeared after validation.");
  }
  const liveRepository = await captureGuardedVerifierRepositoryIdentity({
    workspaceDir: params.workspaceDir,
    head: params.authorization.repositoryHead,
    effectiveYarnVersion,
  });
  if (liveRepository.identityDigest !== repositoryIdentityDigest) {
    throw new Error("Guarded verifier live repository metadata does not match the OCI artifact.");
  }
  return {
    imageId,
    runtimeImageId: self.Image,
    imageRevision,
    packageManager,
    effectiveYarnVersion,
    containerEnvironment: resolveGuardedVerifierContainerEnvironment(image.Config.Env),
    artifactDigest,
    dependencyManifestDigest,
    browserManifestDigest,
    repositoryIdentityDigest,
    browserIdentityDigest,
    workspaceMountSource,
    workspaceMountSourceDigest: sha256(workspaceMountSource),
    imageMounts: [
      {
        imageId,
        target: path.posix.join(params.workdir, "node_modules"),
        subpath: GUARDED_VERIFIER_DEPENDENCY_ROOT,
        readOnly: true,
      },
    ],
  };
}

export function assertGuardedVerifierImageIdentity(params: {
  image: unknown;
  imageId: string;
  sourceRevision: string;
  repositoryHead: string;
  artifactDigest: string;
  dependencyManifestDigest: string;
  browserManifestDigest: string;
  repositoryIdentityDigest: string;
  browserIdentityDigest: string;
  effectiveYarnVersion: string;
  runtimeImageId: string;
}): void {
  const image = DockerImageInspectSchema.parse(params.image);
  const labels = image.Config.Labels;
  const user = image.Config.User.trim();
  const environment = canonicalizeEnvironment(image.Config.Env);
  const entrypoint = image.Config.Entrypoint ?? [];
  const command = image.Config.Cmd ?? [];
  const packageManager = labels["ai.openclaw.sandbox.package-manager"]?.trim() ?? "";
  if (
    image.Id !== params.imageId ||
    labels["ai.openclaw.verifier.runtime-image"]?.trim() !== params.runtimeImageId ||
    labels["org.opencontainers.image.revision"]?.trim() !== params.sourceRevision ||
    labels["ai.openclaw.verifier.repository-head"]?.trim() !== params.repositoryHead ||
    labels["ai.openclaw.sandbox.contract"]?.trim() !== "guarded-verifier-oci-v1" ||
    labels["ai.openclaw.verifier.artifact-digest"]?.trim() !== params.artifactDigest ||
    labels["ai.openclaw.verifier.dependency-manifest"]?.trim() !==
      params.dependencyManifestDigest ||
    labels["ai.openclaw.verifier.browser-manifest"]?.trim() !== params.browserManifestDigest ||
    labels["ai.openclaw.verifier.repository-identity"]?.trim() !==
      params.repositoryIdentityDigest ||
    labels["ai.openclaw.verifier.browser-identity"]?.trim() !== params.browserIdentityDigest ||
    labels["ai.openclaw.verifier.effective-yarn-version"]?.trim() !== params.effectiveYarnVersion ||
    !/^yarn@[0-9]+\.[0-9]+\.[0-9]+(?:[+-][A-Za-z0-9._-]+)?$/u.test(packageManager) ||
    packageManager.slice("yarn@".length) !== params.effectiveYarnVersion ||
    image.Config.WorkingDir !== "/workspace" ||
    entrypoint.length !== 0 ||
    command.length !== 2 ||
    command[0] !== "sleep" ||
    command[1] !== "infinity" ||
    !environment.includes("CI=1") ||
    !environment.includes("HOME=/home/node") ||
    !environment.includes(`PLAYWRIGHT_BROWSERS_PATH=${GUARDED_VERIFIER_BROWSER_CACHE}`) ||
    user !== "1000:1000"
  ) {
    throw new Error("Guarded verifier OCI image identity or provenance is invalid.");
  }
}

export async function assertGuardedVerifierContainerRuntime(params: {
  containerId: string;
  configHash: string;
  runtimeIdentity: GuardedVerifierRuntimeIdentity;
  authorization: GuardedVerifierAuthorization;
  workspaceDir: string;
  workspaceMountSource: string;
  workdir: string;
  tmpfs: string[];
  expectedRunning?: boolean;
  inspect?: (containerId: string) => Promise<unknown>;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<void> {
  if (params.signal?.aborted) {
    throw createAbortError();
  }
  if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
    throw new Error("Guarded verifier execution inspection exceeded its deadline.");
  }
  const container = params.inspect
    ? DockerVerifierContainerSchema.parse(await params.inspect(params.containerId))
    : await inspectDockerJson({
        args: ["inspect", params.containerId],
        signal: params.signal,
        deadlineAt: params.deadlineAt,
        schema: z
          .array(DockerVerifierContainerSchema)
          .length(1)
          .transform((entries) => entries[0]),
      });
  if (params.signal?.aborted) {
    throw createAbortError();
  }
  if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
    throw new Error("Guarded verifier execution inspection exceeded its deadline.");
  }
  const labels = container.Config.Labels;
  const expectedTargets = new Set([
    params.workdir,
    ...params.runtimeIdentity.imageMounts.map((mount) => mount.target),
  ]);
  const persistentMounts = container.Mounts.filter((mount) => mount.Type !== "tmpfs");
  const actualTargets = new Set(persistentMounts.map((mount) => mount.Destination));
  const expectedTmpfs = new Map(
    params.tmpfs.map((entry) => {
      const separator = entry.indexOf(":");
      if (separator === -1) {
        throw new Error("Guarded verifier tmpfs contract is missing options.");
      }
      return [
        entry.slice(0, separator),
        canonicalizeTmpfsOptions(entry.slice(separator + 1)),
      ] as const;
    }),
  );
  const actualTmpfs = new Map(
    Object.entries(container.HostConfig.Tmpfs ?? {}).map(([target, options]) => [
      target,
      canonicalizeTmpfsOptions(options),
    ]),
  );
  const workspaceMount = persistentMounts.find((mount) => mount.Destination === params.workdir);
  const imageMountMismatch = params.runtimeIdentity.imageMounts.some(
    (expected) =>
      !persistentMounts.some(
        (actual) =>
          actual.Destination === expected.target &&
          actual.Type === "image" &&
          actual.Name === expected.imageId &&
          typeof actual.Source === "string" &&
          path.isAbsolute(actual.Source) &&
          !actual.RW,
      ) ||
      !(container.HostConfig.Mounts ?? []).some(
        (actual) =>
          actual.Type === "image" &&
          actual.Source === expected.imageId &&
          actual.Target === expected.target &&
          actual.ReadOnly &&
          actual.ImageOptions?.Subpath === expected.subpath,
      ),
  );
  const capDrop = container.HostConfig.CapDrop ?? [];
  const capAdd = container.HostConfig.CapAdd ?? [];
  const deviceRequests = container.HostConfig.DeviceRequests ?? [];
  const devices = container.HostConfig.Devices ?? [];
  const deviceCgroupRules = container.HostConfig.DeviceCgroupRules ?? [];
  const blkioWeightDevices = container.HostConfig.BlkioWeightDevice ?? [];
  const blkioReadBps = container.HostConfig.BlkioDeviceReadBps ?? [];
  const blkioWriteBps = container.HostConfig.BlkioDeviceWriteBps ?? [];
  const blkioReadIOps = container.HostConfig.BlkioDeviceReadIOps ?? [];
  const blkioWriteIOps = container.HostConfig.BlkioDeviceWriteIOps ?? [];
  const dns = container.HostConfig.Dns ?? [];
  const dnsOptions = container.HostConfig.DnsOptions ?? [];
  const dnsSearch = container.HostConfig.DnsSearch ?? [];
  const extraHosts = container.HostConfig.ExtraHosts ?? [];
  const links = container.HostConfig.Links ?? [];
  const lxcConf = container.HostConfig.LxcConf ?? [];
  const annotations = container.HostConfig.Annotations ?? {};
  const securityOptions = container.HostConfig.SecurityOpt ?? [];
  const binds = container.HostConfig.Binds ?? [];
  const groupAdd = container.HostConfig.GroupAdd ?? [];
  const sysctls = container.HostConfig.Sysctls ?? {};
  const volumesFrom = container.HostConfig.VolumesFrom ?? [];
  const maskedPaths = (container.HostConfig.MaskedPaths ?? []).toSorted();
  const readonlyPaths = (container.HostConfig.ReadonlyPaths ?? []).toSorted();
  const hostMounts = container.HostConfig.Mounts ?? [];
  const command = container.Config.Cmd ?? [];
  const entrypoint = container.Config.Entrypoint ?? [];
  const environment = canonicalizeEnvironment(container.Config.Env);
  const expectedWorkspaceBind = `${params.workspaceMountSource}:${params.workdir}:ro,z`;
  const appArmorIsEngineDefault =
    container.AppArmorProfile === "" || container.AppArmorProfile === "docker-default";
  const networkAttachments = Object.keys(container.NetworkSettings.Networks).toSorted();
  const noNetwork = container.NetworkSettings.Networks.none;
  const expectedRunning = params.expectedRunning ?? true;
  const stoppedStateIsValid =
    !expectedRunning &&
    (container.State.Status === "created" || container.State.Status === "exited") &&
    container.State.Pid === 0;
  const runningStateIsValid =
    expectedRunning && container.State.Status === "running" && container.State.Pid > 0;
  const outputAttachProfileIsValid =
    container.Config.AttachStdout === container.Config.AttachStderr;
  const oomKillProfileIsValid = container.HostConfig.OomKillDisable !== true;
  const ulimits = (container.HostConfig.Ulimits ?? [])
    .map((entry) => `${entry.Name}:${entry.Soft}:${entry.Hard}`)
    .toSorted();
  if (
    container.Id !== params.containerId ||
    container.State.Running !== expectedRunning ||
    (!stoppedStateIsValid && !runningStateIsValid) ||
    container.State.Paused ||
    container.State.Restarting ||
    container.State.OOMKilled ||
    container.State.Dead ||
    container.State.Error !== "" ||
    container.State.Health !== undefined ||
    container.Path !== "sleep" ||
    container.Args.length !== 1 ||
    container.Args[0] !== "infinity" ||
    container.RestartCount !== 0 ||
    container.Platform !== "linux" ||
    container.ExecIDs !== null ||
    container.Image !== params.runtimeIdentity.imageId ||
    container.Config.Image !== params.runtimeIdentity.imageId ||
    container.Config.User !== "1000:1000" ||
    container.Config.Hostname !== container.Id.slice(0, 12) ||
    container.Config.Domainname !== "" ||
    container.Config.AttachStdin ||
    !outputAttachProfileIsValid ||
    container.Config.WorkingDir !== params.workdir ||
    command.length !== 2 ||
    command[0] !== "sleep" ||
    command[1] !== "infinity" ||
    entrypoint.length !== 0 ||
    container.Config.OpenStdin ||
    container.Config.StdinOnce ||
    container.Config.Tty ||
    container.Config.NetworkDisabled === true ||
    container.Config.ArgsEscaped === true ||
    (container.Config.MacAddress ?? "") !== "" ||
    container.Config.Healthcheck != null ||
    (container.Config.OnBuild != null && container.Config.OnBuild.length !== 0) ||
    (container.Config.StopSignal != null && container.Config.StopSignal !== "") ||
    container.Config.StopTimeout != null ||
    (container.Config.Shell != null && container.Config.Shell.length !== 0) ||
    (container.Config.Volumes != null && Object.keys(container.Config.Volumes).length !== 0) ||
    container.HostConfig.AutoRemove ||
    Object.keys(annotations).length !== 0 ||
    container.HostConfig.ContainerIDFile !== "" ||
    container.HostConfig.ConsoleSize[0] !== 0 ||
    container.HostConfig.ConsoleSize[1] !== 0 ||
    container.HostConfig.Cgroup !== "" ||
    container.HostConfig.CgroupnsMode !== "private" ||
    container.HostConfig.CgroupParent !== "" ||
    container.HostConfig.Init !== true ||
    container.HostConfig.LogConfig.Type !== "none" ||
    Object.keys(container.HostConfig.LogConfig.Config).length !== 0 ||
    container.HostConfig.Runtime !== "runc" ||
    groupAdd.length !== 0 ||
    container.HostConfig.UsernsMode !== "" ||
    container.HostConfig.UTSMode !== "" ||
    container.HostConfig.UseApiSocket === true ||
    Object.keys(sysctls).length !== 0 ||
    volumesFrom.length !== 0 ||
    maskedPaths.length !== GUARDED_VERIFIER_MASKED_PATHS.length ||
    maskedPaths.some((entry, index) => entry !== GUARDED_VERIFIER_MASKED_PATHS[index]) ||
    readonlyPaths.length !== GUARDED_VERIFIER_READONLY_PATHS.length ||
    readonlyPaths.some((entry, index) => entry !== GUARDED_VERIFIER_READONLY_PATHS[index]) ||
    environment.length !== params.runtimeIdentity.containerEnvironment.length ||
    environment.some(
      (entry, index) => entry !== params.runtimeIdentity.containerEnvironment[index],
    ) ||
    container.HostConfig.Privileged ||
    capAdd.length !== 0 ||
    deviceRequests.length !== 0 ||
    devices.length !== 0 ||
    container.HostConfig.PidMode !== "" ||
    container.HostConfig.IpcMode !== "private" ||
    container.HostConfig.Isolation !== "" ||
    container.HostConfig.Memory !== 4 * 1024 * 1024 * 1024 ||
    container.HostConfig.MemoryReservation !== 0 ||
    container.HostConfig.MemorySwap !== 4 * 1024 * 1024 * 1024 ||
    container.HostConfig.MemorySwappiness !== null ||
    container.HostConfig.NanoCpus !== 4_000_000_000 ||
    container.HostConfig.CpuShares !== 0 ||
    container.HostConfig.CpuPeriod !== 0 ||
    container.HostConfig.CpuQuota !== 0 ||
    container.HostConfig.CpuRealtimePeriod !== 0 ||
    container.HostConfig.CpuRealtimeRuntime !== 0 ||
    container.HostConfig.CpusetCpus !== "" ||
    container.HostConfig.CpusetMems !== "" ||
    container.HostConfig.CpuCount !== 0 ||
    container.HostConfig.CpuPercent !== 0 ||
    container.HostConfig.BlkioWeight !== 0 ||
    blkioWeightDevices.length !== 0 ||
    blkioReadBps.length !== 0 ||
    blkioWriteBps.length !== 0 ||
    blkioReadIOps.length !== 0 ||
    blkioWriteIOps.length !== 0 ||
    container.HostConfig.IOMaximumIOps !== 0 ||
    container.HostConfig.IOMaximumBandwidth !== 0 ||
    deviceCgroupRules.length !== 0 ||
    links.length !== 0 ||
    lxcConf.length !== 0 ||
    container.HostConfig.NetworkMode !== "none" ||
    (container.Config.ExposedPorts != null &&
      Object.keys(container.Config.ExposedPorts).length !== 0) ||
    (container.HostConfig.PortBindings != null &&
      Object.keys(container.HostConfig.PortBindings).length !== 0) ||
    container.HostConfig.PublishAllPorts ||
    (container.NetworkSettings.Ports != null &&
      Object.keys(container.NetworkSettings.Ports).length !== 0) ||
    !oomKillProfileIsValid ||
    container.HostConfig.OomScoreAdj !== 0 ||
    container.HostConfig.PidsLimit !== 512 ||
    networkAttachments.length !== 1 ||
    networkAttachments[0] !== "none" ||
    !noNetwork ||
    noNetwork.IPAMConfig !== null ||
    noNetwork.Links !== null ||
    noNetwork.Aliases !== null ||
    noNetwork.MacAddress !== "" ||
    noNetwork.DriverOpts !== null ||
    (noNetwork.GwPriority ?? 0) !== 0 ||
    noNetwork.NetworkID !== "" ||
    noNetwork.EndpointID !== "" ||
    noNetwork.Gateway !== "" ||
    noNetwork.IPAddress !== "" ||
    noNetwork.IPPrefixLen !== 0 ||
    noNetwork.IPv6Gateway !== "" ||
    noNetwork.GlobalIPv6Address !== "" ||
    noNetwork.GlobalIPv6PrefixLen !== 0 ||
    (noNetwork.DNSNames != null && noNetwork.DNSNames.length !== 0) ||
    container.NetworkSettings.Bridge !== "" ||
    container.NetworkSettings.SandboxID !== "" ||
    container.NetworkSettings.SandboxKey !== "" ||
    container.NetworkSettings.HairpinMode ||
    container.NetworkSettings.LinkLocalIPv6Address !== "" ||
    container.NetworkSettings.LinkLocalIPv6PrefixLen !== 0 ||
    container.NetworkSettings.SecondaryIPAddresses !== null ||
    container.NetworkSettings.SecondaryIPv6Addresses !== null ||
    container.NetworkSettings.EndpointID !== "" ||
    container.NetworkSettings.Gateway !== "" ||
    container.NetworkSettings.GlobalIPv6Address !== "" ||
    container.NetworkSettings.GlobalIPv6PrefixLen !== 0 ||
    container.NetworkSettings.IPAddress !== "" ||
    container.NetworkSettings.IPPrefixLen !== 0 ||
    container.NetworkSettings.IPv6Gateway !== "" ||
    container.NetworkSettings.MacAddress !== "" ||
    !container.HostConfig.ReadonlyRootfs ||
    container.HostConfig.RestartPolicy.Name !== "no" ||
    container.HostConfig.RestartPolicy.MaximumRetryCount !== 0 ||
    container.HostConfig.ShmSize !== 64 * 1024 * 1024 ||
    (container.HostConfig.StorageOpt != null &&
      Object.keys(container.HostConfig.StorageOpt).length !== 0) ||
    container.HostConfig.VolumeDriver !== "" ||
    ulimits.length !== 2 ||
    ulimits[0] !== "nofile:65536:65536" ||
    ulimits[1] !== "nproc:4096:4096" ||
    capDrop.length !== 1 ||
    (capDrop[0] ?? "").toUpperCase() !== "ALL" ||
    dns.length !== 0 ||
    dnsOptions.length !== 0 ||
    dnsSearch.length !== 0 ||
    extraHosts.length !== 0 ||
    securityOptions.length !== 1 ||
    !/^no-new-privileges(?::true)?$/u.test(securityOptions[0] ?? "") ||
    securityOptions.some((entry) => /seccomp|apparmor/iu.test(entry)) ||
    !appArmorIsEngineDefault ||
    binds.length !== 1 ||
    binds[0] !== expectedWorkspaceBind ||
    hostMounts.length !== params.runtimeIdentity.imageMounts.length ||
    labels["openclaw.configHash"] !== params.configHash ||
    labels["openclaw.verifierImageId"] !== params.runtimeIdentity.imageId ||
    labels["openclaw.verifierArtifactDigest"] !== params.runtimeIdentity.artifactDigest ||
    labels["openclaw.verifierAssignmentId"] !== params.authorization.assignmentId ||
    labels["openclaw.verifierCandidateId"] !== params.authorization.candidateId ||
    labels["openclaw.verifierWaveId"] !== params.authorization.waveId ||
    labels["openclaw.verifierEpoch"] !== String(params.authorization.epoch) ||
    expectedTargets.size !== actualTargets.size ||
    [...expectedTargets].some((target) => !actualTargets.has(target)) ||
    expectedTmpfs.size !== actualTmpfs.size ||
    [...expectedTmpfs].some(([target, options]) => actualTmpfs.get(target) !== options) ||
    !workspaceMount ||
    workspaceMount.Type !== "bind" ||
    workspaceMount.Source !== params.workspaceMountSource ||
    (workspaceMount.Driver ?? "") !== "" ||
    workspaceMount.Mode !== "ro,z" ||
    workspaceMount.Propagation !== "rprivate" ||
    imageMountMismatch ||
    persistentMounts.some(
      (mount) =>
        mount.RW ||
        (mount.Destination !== params.workdir &&
          ((mount.Driver ?? "") !== "" ||
            (mount.Mode ?? "") !== "" ||
            !["", "rprivate"].includes(mount.Propagation ?? ""))) ||
        (mount.Destination === params.workdir && mount.Type !== "bind") ||
        (mount.Destination !== params.workdir && mount.Type !== "image"),
    )
  ) {
    throw new Error("Guarded verifier container identity or isolation profile is invalid.");
  }
}

export async function assertGuardedVerifierExecutionInputs(params: {
  containerId: string;
  configHash: string;
  runtimeIdentity: GuardedVerifierRuntimeIdentity;
  authorization: GuardedVerifierAuthorization;
  workspaceDir: string;
  workspaceMountSource: string;
  workdir: string;
  tmpfs: string[];
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<void> {
  const deadlineMs = params.deadlineMs ?? GUARDED_VERIFIER_EXECUTION_DEADLINE_MS;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > GUARDED_VERIFIER_EXECUTION_DEADLINE_MS
  ) {
    throw new Error("Guarded verifier execution inspection deadline is invalid.");
  }
  if (params.signal?.aborted) {
    throw createAbortError();
  }
  const deadlineAt = Date.now() + deadlineMs;
  const liveRepository = await captureGuardedVerifierRepositoryIdentity({
    workspaceDir: params.workspaceDir,
    head: params.authorization.repositoryHead,
    effectiveYarnVersion: params.runtimeIdentity.effectiveYarnVersion,
    control: { signal: params.signal, deadlineAt },
  });
  if (liveRepository.identityDigest !== params.runtimeIdentity.repositoryIdentityDigest) {
    throw new Error("Guarded verifier repository metadata changed before execution.");
  }
  const image = await inspectDockerJson({
    args: ["image", "inspect", params.runtimeIdentity.imageId],
    signal: params.signal,
    deadlineAt,
    schema: z
      .array(DockerImageInspectSchema)
      .length(1)
      .transform((entries) => entries[0]),
  });
  assertGuardedVerifierImageIdentity({
    image,
    imageId: params.runtimeIdentity.imageId,
    sourceRevision: params.authorization.sourceRevision,
    repositoryHead: params.authorization.repositoryHead,
    artifactDigest: params.runtimeIdentity.artifactDigest,
    dependencyManifestDigest: params.runtimeIdentity.dependencyManifestDigest,
    browserManifestDigest: params.runtimeIdentity.browserManifestDigest,
    repositoryIdentityDigest: params.runtimeIdentity.repositoryIdentityDigest,
    browserIdentityDigest: params.runtimeIdentity.browserIdentityDigest,
    effectiveYarnVersion: params.runtimeIdentity.effectiveYarnVersion,
    runtimeImageId: params.runtimeIdentity.runtimeImageId,
  });
  await assertGuardedVerifierContainerRuntime({
    containerId: params.containerId,
    configHash: params.configHash,
    runtimeIdentity: params.runtimeIdentity,
    authorization: params.authorization,
    workspaceDir: params.workspaceDir,
    workspaceMountSource: params.workspaceMountSource,
    workdir: params.workdir,
    tmpfs: params.tmpfs,
    signal: params.signal,
    deadlineAt,
  });
}

export type ExecDockerOptions = ExecDockerRawOptions;

export async function execDocker(args: string[], opts?: ExecDockerOptions) {
  const result = await execDockerRaw(args, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    code: result.code,
  };
}

export async function readDockerContainerLabel(
  containerName: string,
  label: string,
): Promise<string | null> {
  const result = await execDocker(
    ["inspect", "-f", `{{ index .Config.Labels "${label}" }}`, containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  const raw = result.stdout.trim();
  if (!raw || raw === "<no value>") {
    return null;
  }
  return raw;
}

export async function readDockerContainerEnvVar(
  containerName: string,
  envVar: string,
): Promise<string | null> {
  const result = await execDocker(
    ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", containerName],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith(`${envVar}=`)) {
      return line.slice(envVar.length + 1);
    }
  }
  return null;
}

export async function readDockerNetworkDriver(network: string): Promise<string | null> {
  const result = await execDocker(["network", "inspect", "-f", "{{.Driver}}", network], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return null;
  }
  const driver = result.stdout.trim();
  return driver || null;
}

export async function readDockerNetworkGateway(network: string): Promise<string | null> {
  const result = await execDocker(
    ["network", "inspect", "-f", "{{range .IPAM.Config}}{{println .Gateway}}{{end}}", network],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  // Filter valid, non-empty gateways (handles dual-stack / multi-subnet networks
  // and filters Docker's "<no value>" sentinel for nil IPAM entries).
  const gateways = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "<no value>");
  // Prefer IPv4: the CDP relay binds on 0.0.0.0 so an IPv6-only range would
  // reject forwarded IPv4 traffic from the bridge gateway.
  const gw = gateways.find((g) => !g.includes(":")) ?? gateways[0] ?? "";
  return gw || null;
}

export async function readDockerPort(containerName: string, port: number) {
  const result = await execDocker(["port", containerName, `${port}/tcp`], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return null;
  }
  const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
  const match = line.match(/:(\d+)\s*$/);
  if (!match) {
    return null;
  }
  const mapped = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(mapped) ? mapped : null;
}

async function dockerImageExists(image: string) {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return true;
  }
  const stderr = result.stderr.trim();
  if (stderr.includes("No such image")) {
    return false;
  }
  throw new Error(`Failed to inspect sandbox image: ${stderr}`);
}

export async function ensureDockerImage(image: string) {
  const exists = await dockerImageExists(image);
  if (exists) {
    return;
  }
  if (image === DEFAULT_SANDBOX_IMAGE) {
    await execDocker(["pull", "debian:bookworm-slim"]);
    await execDocker(["tag", "debian:bookworm-slim", DEFAULT_SANDBOX_IMAGE]);
    return;
  }
  throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
}

export type DockerContainerState =
  | { exists: true; running: boolean }
  | { exists: false; running: false };

export function isProvenDockerContainerNotFound(stderr: string): boolean {
  const normalized = stderr.trim();
  return (
    /^(?:Error:\s*)?No such (?:container|object):?\s+\S+$/iu.test(normalized) ||
    /^Error response from daemon:\s*No such (?:container|object):?\s+\S+$/iu.test(normalized)
  );
}

export async function dockerContainerState(name: string): Promise<DockerContainerState> {
  const result = await execDocker(["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
    maxOutputBytes: 1024,
    timeoutMs: 5_000,
  });
  if (result.code !== 0) {
    if (isProvenDockerContainerNotFound(result.stderr)) {
      return { exists: false, running: false };
    }
    throw new Error(`Could not establish Docker container state for ${name}.`);
  }
  const running = result.stdout.trim();
  if (running !== "true" && running !== "false") {
    throw new Error(`Docker returned malformed container state for ${name}.`);
  }
  return { exists: true, running: running === "true" };
}

function normalizeDockerLimit(value?: string | number) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatUlimitValue(
  name: string,
  value: string | number | { soft?: number; hard?: number },
) {
  if (!name.trim()) {
    return null;
  }
  if (typeof value === "number" || typeof value === "string") {
    const raw = String(value).trim();
    return raw ? `${name}=${raw}` : null;
  }
  const soft = typeof value.soft === "number" ? Math.max(0, value.soft) : undefined;
  const hard = typeof value.hard === "number" ? Math.max(0, value.hard) : undefined;
  if (soft === undefined && hard === undefined) {
    return null;
  }
  if (soft === undefined) {
    return `${name}=${hard}`;
  }
  if (hard === undefined) {
    return `${name}=${soft}`;
  }
  return `${name}=${soft}:${hard}`;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  scopeKey: string;
  createdAtMs?: number;
  labels?: Record<string, string>;
  configHash?: string;
  includeBinds?: boolean;
  bindSourceRoots?: string[];
  allowSourcesOutsideAllowedRoots?: boolean;
  allowReservedContainerTargets?: boolean;
  allowContainerNamespaceJoin?: boolean;
  envSanitizationOptions?: EnvSanitizationOptions;
}) {
  // Runtime security validation: blocks dangerous bind mounts, network modes, and profiles.
  validateSandboxSecurity({
    ...params.cfg,
    allowedSourceRoots: params.bindSourceRoots,
    allowSourcesOutsideAllowedRoots:
      params.allowSourcesOutsideAllowedRoots ??
      params.cfg.dangerouslyAllowExternalBindSources === true,
    allowReservedContainerTargets:
      params.allowReservedContainerTargets ??
      params.cfg.dangerouslyAllowReservedContainerTargets === true,
    dangerouslyAllowContainerNamespaceJoin:
      params.allowContainerNamespaceJoin ??
      params.cfg.dangerouslyAllowContainerNamespaceJoin === true,
  });

  const createdAtMs = params.createdAtMs ?? Date.now();
  const args = ["create", "--name", params.name];
  args.push("--label", "openclaw.sandbox=1");
  args.push("--label", `openclaw.sessionKey=${params.scopeKey}`);
  args.push("--label", `openclaw.createdAtMs=${createdAtMs}`);
  args.push("--label", `openclaw.mountFormatVersion=${SANDBOX_MOUNT_FORMAT_VERSION}`);
  if (params.configHash) {
    args.push("--label", `openclaw.configHash=${params.configHash}`);
  }
  for (const [key, value] of Object.entries(params.labels ?? {})) {
    if (key && value) {
      args.push("--label", `${key}=${value}`);
    }
  }
  if (params.cfg.readOnlyRoot) {
    args.push("--read-only");
  }
  for (const entry of params.cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (params.cfg.network) {
    args.push("--network", params.cfg.network);
  }
  if (params.cfg.user) {
    args.push("--user", params.cfg.user);
  }
  const envSanitization = sanitizeEnvVars(params.cfg.env ?? {}, params.envSanitizationOptions);
  if (envSanitization.blocked.length > 0) {
    log.warn(`Blocked sensitive environment variables: ${envSanitization.blocked.join(", ")}`);
  }
  if (envSanitization.warnings.length > 0) {
    log.warn(`Suspicious environment variables: ${envSanitization.warnings.join(", ")}`);
  }
  for (const [key, value] of Object.entries(markOpenClawExecEnv(envSanitization.allowed))) {
    args.push("--env", `${key}=${value}`);
  }
  for (const cap of params.cfg.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges");
  if (params.cfg.seccompProfile) {
    args.push("--security-opt", `seccomp=${params.cfg.seccompProfile}`);
  }
  if (params.cfg.apparmorProfile) {
    args.push("--security-opt", `apparmor=${params.cfg.apparmorProfile}`);
  }
  for (const entry of params.cfg.dns ?? []) {
    if (entry.trim()) {
      args.push("--dns", entry);
    }
  }
  for (const entry of params.cfg.extraHosts ?? []) {
    if (entry.trim()) {
      args.push("--add-host", entry);
    }
  }
  if (typeof params.cfg.pidsLimit === "number" && params.cfg.pidsLimit > 0) {
    args.push("--pids-limit", String(params.cfg.pidsLimit));
  }
  const memory = normalizeDockerLimit(params.cfg.memory);
  if (memory) {
    args.push("--memory", memory);
  }
  const memorySwap = normalizeDockerLimit(params.cfg.memorySwap);
  if (memorySwap) {
    args.push("--memory-swap", memorySwap);
  }
  if (typeof params.cfg.cpus === "number" && params.cfg.cpus > 0) {
    args.push("--cpus", String(params.cfg.cpus));
  }
  for (const [name, value] of Object.entries(params.cfg.ulimits ?? {})) {
    const formatted = formatUlimitValue(name, value);
    if (formatted) {
      args.push("--ulimit", formatted);
    }
  }
  if (params.includeBinds !== false && params.cfg.binds?.length) {
    for (const bind of params.cfg.binds) {
      args.push("-v", bind);
    }
  }
  return args;
}

function appendCustomBinds(args: string[], cfg: SandboxDockerConfig): void {
  if (!cfg.binds?.length) {
    return;
  }
  for (const bind of cfg.binds) {
    args.push("-v", bind);
  }
}

export async function createSandboxContainer(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  workspaceMountSource?: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  scopeKey: string;
  configHash?: string;
  imageMounts?: GuardedVerifierImageMount[];
  runtimeIdentity?: GuardedVerifierRuntimeIdentity;
  authorization?: GuardedVerifierAuthorization;
  onContainerCreated?: (containerId: string) => Promise<void>;
  onContainerRemoved?: (containerId: string) => Promise<void>;
  validateBeforeStart?: (containerId: string) => Promise<void>;
}) {
  const { name, cfg, workspaceDir, scopeKey } = params;
  const workspaceMountSource = params.workspaceMountSource ?? workspaceDir;
  await ensureDockerImage(cfg.image);
  let verifierLabels: Record<string, string> | undefined;
  if (params.runtimeIdentity) {
    if (!params.authorization) {
      throw new Error("Guarded verifier container creation requires protected authorization.");
    }
    verifierLabels = {
      "openclaw.verifierImageId": params.runtimeIdentity.imageId,
      "openclaw.verifierArtifactDigest": params.runtimeIdentity.artifactDigest,
      "openclaw.verifierAssignmentId": params.authorization.assignmentId,
      "openclaw.verifierCandidateId": params.authorization.candidateId,
      "openclaw.verifierWaveId": params.authorization.waveId,
      "openclaw.verifierEpoch": String(params.authorization.epoch),
    };
  }

  const args = buildSandboxCreateArgs({
    name,
    cfg,
    scopeKey,
    configHash: params.configHash,
    includeBinds: false,
    bindSourceRoots: [workspaceMountSource, params.agentWorkspaceDir],
    labels: verifierLabels,
  });
  if (params.runtimeIdentity) {
    args.push(
      "--ipc",
      "private",
      "--cgroupns",
      "private",
      "--runtime",
      "runc",
      "--restart",
      "no",
      "--init",
      "--log-driver",
      "none",
      "--shm-size",
      "64m",
    );
  }
  args.push("--workdir", cfg.workdir);
  appendWorkspaceMountArgs({
    args,
    workspaceDir: workspaceMountSource,
    agentWorkspaceDir: params.runtimeIdentity ? workspaceMountSource : params.agentWorkspaceDir,
    workdir: cfg.workdir,
    workspaceAccess: params.workspaceAccess,
  });
  appendGuardedVerifierImageMountArgs(args, params.imageMounts);
  appendCustomBinds(args, cfg);
  args.push(
    params.runtimeIdentity ? params.runtimeIdentity.imageId : cfg.image,
    "sleep",
    "infinity",
  );

  const created = await execDocker(args);
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("Docker create did not return one exact immutable container ID.");
  }
  try {
    await params.onContainerCreated?.(containerId);
    await params.validateBeforeStart?.(containerId);
    await execDocker(["start", containerId]);
    if (cfg.setupCommand?.trim()) {
      await execDocker(["exec", "-i", containerId, "/bin/sh", "-lc", cfg.setupCommand]);
    }
  } catch (error) {
    try {
      await execDocker(["rm", "-f", containerId]);
      await params.onContainerRemoved?.(containerId);
    } catch (cleanupCause) {
      throw createPrimaryAndSecondaryAggregateError({
        primary: error,
        secondary: cleanupCause,
        secondaryMessage: "Sandbox container cleanup after provisioning failure failed.",
        aggregateMessage: `Sandbox container ${containerId} failed provisioning and remains registered for exact cleanup.`,
      });
    }
    throw error;
  }
  return containerId;
}

async function readContainerConfigHash(containerName: string): Promise<string | null> {
  return await readDockerContainerLabel(containerName, "openclaw.configHash");
}

export async function inspectExactContainerId(containerName: string): Promise<string> {
  const result = await execDocker(["inspect", "--format", "{{.Id}}", containerName], {
    maxOutputBytes: 1024,
    timeoutMs: 5_000,
  });
  const containerId = result.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("Sandbox container inspection returned a malformed immutable identity.");
  }
  return containerId;
}

function formatSandboxRecreateHint(params: { scope: SandboxConfig["scope"]; sessionKey: string }) {
  if (params.scope === "session") {
    return formatCliCommand(`openclaw sandbox recreate --session ${params.sessionKey}`);
  }
  if (params.scope === "agent") {
    const agentId = resolveSandboxAgentId(params.sessionKey) ?? "main";
    return formatCliCommand(`openclaw sandbox recreate --agent ${agentId}`);
  }
  return formatCliCommand("openclaw sandbox recreate --all");
}

export async function ensureSandboxContainer(params: {
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
}) {
  const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  const name = `${params.cfg.docker.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const guardedAuthorization = params.cfg.guardedVerifierAuthorization;
  if (params.cfg.guardedVerifierRuntime && !guardedAuthorization) {
    throw new Error("Guarded verifier protected authorization is missing.");
  }
  const guardedVerifierRuntimeIdentity = guardedAuthorization
    ? await inspectGuardedVerifierRuntimeIdentity({
        workspaceDir: params.workspaceDir,
        workdir: params.cfg.docker.workdir,
        authorization: guardedAuthorization,
      })
    : undefined;
  const imageMounts = guardedVerifierRuntimeIdentity?.imageMounts;
  const expectedHash = computeSandboxConfigHash({
    docker: params.cfg.docker,
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    guardedVerifierAuthorization: guardedAuthorization,
    guardedVerifierRuntimeIdentity: guardedVerifierRuntimeIdentity
      ? {
          imageId: guardedVerifierRuntimeIdentity.imageId,
          runtimeImageId: guardedVerifierRuntimeIdentity.runtimeImageId,
          imageRevision: guardedVerifierRuntimeIdentity.imageRevision,
          packageManager: guardedVerifierRuntimeIdentity.packageManager,
          effectiveYarnVersion: guardedVerifierRuntimeIdentity.effectiveYarnVersion,
          containerEnvironment: guardedVerifierRuntimeIdentity.containerEnvironment,
          artifactDigest: guardedVerifierRuntimeIdentity.artifactDigest,
          dependencyManifestDigest: guardedVerifierRuntimeIdentity.dependencyManifestDigest,
          browserManifestDigest: guardedVerifierRuntimeIdentity.browserManifestDigest,
          repositoryIdentityDigest: guardedVerifierRuntimeIdentity.repositoryIdentityDigest,
          browserIdentityDigest: guardedVerifierRuntimeIdentity.browserIdentityDigest,
          workspaceMountSourceDigest: guardedVerifierRuntimeIdentity.workspaceMountSourceDigest,
        }
      : undefined,
  });
  const now = Date.now();
  const state = await dockerContainerState(containerName);
  let hasContainer = state.exists;
  let running = state.running;
  let containerId: string | undefined;
  let createdContainer = false;
  let currentHash: string | null = null;
  let hashMismatch = false;
  let registryEntry:
    | {
        lastUsedAtMs: number;
        configHash?: string;
        runtimeId?: string;
      }
    | undefined;
  const registryRecord = (runtimeId: string) => ({
    containerName,
    runtimeId,
    backendId: "docker",
    runtimeLabel: containerName,
    sessionKey: scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: guardedVerifierRuntimeIdentity?.imageId ?? params.cfg.docker.image,
    configLabelKind: "Image",
    configHash: expectedHash,
  });
  if (hasContainer) {
    containerId = await inspectExactContainerId(containerName);
    const exactState = await dockerContainerState(containerId);
    if (!exactState.exists) {
      throw new Error("Sandbox container disappeared after immutable ID capture.");
    }
    running = exactState.running;
    const registry = await readRegistry();
    registryEntry = registry.entries.find((entry) => entry.containerName === containerName);
    currentHash = await readContainerConfigHash(containerId);
    if (!currentHash) {
      currentHash = registryEntry?.configHash ?? null;
    }
    hashMismatch = !currentHash || currentHash !== expectedHash;
    if (hashMismatch) {
      if (params.cfg.guardedVerifierRuntime) {
        throw new Error(
          `Guarded verifier sandbox ${containerName} has stale runtime or OCI identity; ` +
            "remove it through the supported sandbox lifecycle before retrying.",
        );
      }
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running &&
        (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS);
      if (isHot) {
        const hint = formatSandboxRecreateHint({ scope: params.cfg.scope, sessionKey: scopeKey });
        defaultRuntime.log(
          `Sandbox config changed for ${containerName} (recently used). Recreate to apply: ${hint}`,
        );
      } else {
        await execDocker(["rm", "-f", containerId]);
        hasContainer = false;
        running = false;
        containerId = undefined;
      }
    }
  }
  if (!hasContainer) {
    containerId = await createSandboxContainer({
      name: containerName,
      cfg: params.cfg.docker,
      workspaceDir: params.workspaceDir,
      workspaceMountSource: guardedVerifierRuntimeIdentity?.workspaceMountSource,
      workspaceAccess: params.cfg.workspaceAccess,
      agentWorkspaceDir: params.agentWorkspaceDir,
      scopeKey,
      configHash: expectedHash,
      imageMounts,
      runtimeIdentity: guardedVerifierRuntimeIdentity,
      authorization: guardedAuthorization,
      onContainerCreated: guardedVerifierRuntimeIdentity
        ? async (runtimeId) => {
            await updateRegistry(registryRecord(runtimeId), {
              runtimeTransition: "new-runtime",
            });
          }
        : undefined,
      onContainerRemoved: guardedVerifierRuntimeIdentity
        ? async (runtimeId) => {
            await removeRegistryEntryExact(containerName, runtimeId);
          }
        : undefined,
      validateBeforeStart:
        guardedVerifierRuntimeIdentity && guardedAuthorization
          ? async (runtimeId) => {
              await assertGuardedVerifierContainerRuntime({
                containerId: runtimeId,
                configHash: expectedHash,
                runtimeIdentity: guardedVerifierRuntimeIdentity,
                authorization: guardedAuthorization,
                workspaceDir: params.workspaceDir,
                workspaceMountSource: guardedVerifierRuntimeIdentity.workspaceMountSource,
                workdir: params.cfg.docker.workdir,
                tmpfs: params.cfg.docker.tmpfs,
                expectedRunning: false,
              });
            }
          : undefined,
    });
    createdContainer = true;
  } else if (!running) {
    if (!containerId) {
      throw new Error("Sandbox immutable container ID is missing before start.");
    }
    if (guardedVerifierRuntimeIdentity) {
      if (!guardedAuthorization) {
        throw new Error("Guarded verifier authorization disappeared before container validation.");
      }
      await assertGuardedVerifierContainerRuntime({
        containerId,
        configHash: expectedHash,
        runtimeIdentity: guardedVerifierRuntimeIdentity,
        authorization: guardedAuthorization,
        workspaceDir: params.workspaceDir,
        workspaceMountSource: guardedVerifierRuntimeIdentity.workspaceMountSource,
        workdir: params.cfg.docker.workdir,
        tmpfs: params.cfg.docker.tmpfs,
        expectedRunning: false,
      });
    }
    await execDocker(["start", containerId]);
  }
  if (!containerId) {
    throw new Error("Sandbox immutable container ID is missing after creation.");
  }
  try {
    if (guardedVerifierRuntimeIdentity) {
      if (!guardedAuthorization) {
        throw new Error("Guarded verifier authorization disappeared before container validation.");
      }
      await assertGuardedVerifierContainerRuntime({
        containerId,
        configHash: expectedHash,
        runtimeIdentity: guardedVerifierRuntimeIdentity,
        authorization: guardedAuthorization,
        workspaceDir: params.workspaceDir,
        workspaceMountSource: guardedVerifierRuntimeIdentity.workspaceMountSource,
        workdir: params.cfg.docker.workdir,
        tmpfs: params.cfg.docker.tmpfs,
      });
    }
  } catch (error) {
    if (createdContainer) {
      try {
        await execDocker(["rm", "-f", containerId]);
        await removeRegistryEntryExact(containerName, containerId);
      } catch (cleanupCause) {
        throw createPrimaryAndSecondaryAggregateError({
          primary: error,
          secondary: cleanupCause,
          secondaryMessage: "Guarded verifier cleanup after container validation failed.",
          aggregateMessage: `Guarded verifier container ${containerId} failed validation and remains registered for exact cleanup.`,
        });
      }
    } else if (guardedVerifierRuntimeIdentity) {
      try {
        const failedState = await dockerContainerState(containerId);
        if (failedState.running) {
          await execDocker(["stop", containerId]);
        }
        const restoredState = await dockerContainerState(containerId);
        if (!restoredState.exists || restoredState.running) {
          throw new Error("Guarded verifier container could not be restored to stopped state.", {
            cause: error,
          });
        }
        if (registryEntry?.runtimeId === containerId) {
          await updateRegistry(registryRecord(containerId));
        }
      } catch (cleanupCause) {
        throw createPrimaryAndSecondaryAggregateError({
          primary: error,
          secondary: cleanupCause,
          secondaryMessage: "Guarded verifier failed to restore its stopped container state.",
          aggregateMessage: `Guarded verifier container ${containerId} failed validation and could not be stopped safely.`,
        });
      }
    }
    throw error;
  }
  try {
    await updateRegistry(
      {
        ...registryRecord(containerId),
        configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
      },
      {
        runtimeTransition: createdContainer
          ? "new-runtime"
          : registryEntry && !registryEntry.runtimeId
            ? "adopt-existing"
            : undefined,
      },
    );
  } catch (error) {
    if (createdContainer && !guardedVerifierRuntimeIdentity) {
      try {
        await execDocker(["rm", "-f", containerId]);
      } catch (cleanupCause) {
        throw createPrimaryAndSecondaryAggregateError({
          primary: error,
          secondary: cleanupCause,
          secondaryMessage: "Sandbox container cleanup after registry failure failed.",
          aggregateMessage: `Sandbox container ${containerId} could not be registered or removed exactly.`,
        });
      }
    }
    throw error;
  }
  return {
    containerName,
    containerId,
    guardedVerifierExecution:
      guardedVerifierRuntimeIdentity && guardedAuthorization
        ? {
            configHash: expectedHash,
            runtimeIdentity: guardedVerifierRuntimeIdentity,
            authorization: guardedAuthorization,
            workspaceDir: params.workspaceDir,
            workspaceMountSource: guardedVerifierRuntimeIdentity.workspaceMountSource,
            workdir: params.cfg.docker.workdir,
            tmpfs: params.cfg.docker.tmpfs,
          }
        : undefined,
  } satisfies EnsuredSandboxContainer;
}
