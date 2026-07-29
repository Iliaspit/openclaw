import { beforeAll, describe, expect, it } from "vitest";
import type { GuardedVerifierRuntimeIdentity } from "./docker.js";
import type { GuardedVerifierAuthorization } from "./types.js";

type DockerModule = typeof import("./docker.js");
let appendGuardedVerifierImageMountArgs: DockerModule["appendGuardedVerifierImageMountArgs"];
let assertGuardedVerifierContainerRuntime: DockerModule["assertGuardedVerifierContainerRuntime"];
let assertGuardedVerifierGatewayWorkspaceMount: DockerModule["assertGuardedVerifierGatewayWorkspaceMount"];
let assertGuardedVerifierImageIdentity: DockerModule["assertGuardedVerifierImageIdentity"];

beforeAll(async () => {
  const docker = await import("./docker.js");
  appendGuardedVerifierImageMountArgs = docker.appendGuardedVerifierImageMountArgs;
  assertGuardedVerifierContainerRuntime = docker.assertGuardedVerifierContainerRuntime;
  assertGuardedVerifierGatewayWorkspaceMount = docker.assertGuardedVerifierGatewayWorkspaceMount;
  assertGuardedVerifierImageIdentity = docker.assertGuardedVerifierImageIdentity;
});

const imageId = `sha256:${"1".repeat(64)}`;
const runtimeImageId = `sha256:${"0".repeat(64)}`;
const artifactDigest = "2".repeat(64);
const dependencyManifestDigest = "3".repeat(64);
const browserManifestDigest = "4".repeat(64);
const repositoryIdentityDigest = "5".repeat(64);
const browserIdentityDigest = "6".repeat(64);

const authorization: GuardedVerifierAuthorization = {
  assignmentId: "assignment",
  candidateId: "candidate",
  waveId: "wave",
  epoch: 14,
  candidateDigest: "7".repeat(64),
  contextDigest: "8".repeat(64),
  scopeDigest: "9".repeat(64),
  worktreeIdentity: "worktree",
  repositoryHead: "a".repeat(40),
  sourceRevision: "b".repeat(40),
};

const runtimeIdentity: GuardedVerifierRuntimeIdentity = {
  imageId,
  runtimeImageId,
  imageRevision: authorization.sourceRevision,
  packageManager: "yarn@4.9.2",
  effectiveYarnVersion: "4.9.2",
  containerEnvironment: [
    "CI=1",
    "COREPACK_HOME=/opt/openclaw-verifier/corepack",
    "HOME=/home/node",
    "OPENCLAW_CLI=1",
    "PLAYWRIGHT_BROWSERS_PATH=/opt/openclaw-verifier/browsers",
  ],
  artifactDigest,
  dependencyManifestDigest,
  browserManifestDigest,
  repositoryIdentityDigest,
  browserIdentityDigest,
  workspaceMountSource: "/host/repo",
  workspaceMountSourceDigest: "d".repeat(64),
  imageMounts: [
    {
      imageId,
      target: "/workspace/node_modules",
      subpath: "opt/openclaw-verifier/dependencies",
      readOnly: true,
    },
  ],
};

function imageFixture() {
  return {
    Id: imageId,
    Config: {
      User: "1000:1000",
      Env: runtimeIdentity.containerEnvironment.filter((entry) => entry !== "OPENCLAW_CLI=1"),
      WorkingDir: "/workspace",
      Entrypoint: null,
      Cmd: ["sleep", "infinity"],
      Labels: {
        "org.opencontainers.image.revision": authorization.sourceRevision,
        "ai.openclaw.verifier.runtime-image": runtimeImageId,
        "ai.openclaw.sandbox.contract": "guarded-verifier-oci-v1",
        "ai.openclaw.sandbox.package-manager": "yarn@4.9.2",
        "ai.openclaw.verifier.repository-head": authorization.repositoryHead,
        "ai.openclaw.verifier.artifact-digest": artifactDigest,
        "ai.openclaw.verifier.dependency-manifest": dependencyManifestDigest,
        "ai.openclaw.verifier.browser-manifest": browserManifestDigest,
        "ai.openclaw.verifier.repository-identity": repositoryIdentityDigest,
        "ai.openclaw.verifier.browser-identity": browserIdentityDigest,
        "ai.openclaw.verifier.effective-yarn-version": "4.9.2",
      },
    },
  };
}

function containerFixture() {
  const containerId = "c".repeat(64);
  return {
    Id: containerId,
    Created: "2026-07-25T00:00:00.000000000Z",
    Path: "sleep",
    Args: ["infinity"],
    ResolvConfPath: `/var/lib/docker/containers/${containerId}/resolv.conf`,
    HostnamePath: `/var/lib/docker/containers/${containerId}/hostname`,
    HostsPath: `/var/lib/docker/containers/${containerId}/hosts`,
    LogPath: "",
    Name: "/openclaw-verifier-test",
    RestartCount: 0,
    Driver: "overlayfs",
    Platform: "linux",
    MountLabel: "",
    ProcessLabel: "",
    ExecIDs: null,
    Image: imageId,
    Config: {
      Hostname: containerId.slice(0, 12),
      Domainname: "",
      Image: imageId,
      User: "1000:1000",
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Env: [...runtimeIdentity.containerEnvironment],
      WorkingDir: "/workspace",
      Entrypoint: null,
      Cmd: ["sleep", "infinity"],
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      ExposedPorts: null,
      Healthcheck: null,
      ArgsEscaped: false,
      Volumes: null,
      NetworkDisabled: false,
      MacAddress: "",
      OnBuild: null,
      StopSignal: null,
      StopTimeout: null,
      Shell: null,
      Labels: {
        "openclaw.configHash": "config",
        "openclaw.verifierImageId": imageId,
        "openclaw.verifierArtifactDigest": artifactDigest,
        "openclaw.verifierAssignmentId": authorization.assignmentId,
        "openclaw.verifierCandidateId": authorization.candidateId,
        "openclaw.verifierWaveId": authorization.waveId,
        "openclaw.verifierEpoch": String(authorization.epoch),
      },
    },
    State: {
      Status: "running",
      Running: true,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Pid: 123,
      ExitCode: 0,
      Error: "",
      StartedAt: "2026-07-25T00:00:01.000000000Z",
      FinishedAt: "0001-01-01T00:00:00Z",
    },
    AppArmorProfile: "docker-default",
    GraphDriver: { Data: {}, Name: "overlayfs" },
    HostConfig: {
      Annotations: null,
      AutoRemove: false,
      Binds: ["/host/repo:/workspace:ro,z"],
      BlkioDeviceReadBps: null,
      BlkioDeviceReadIOps: null,
      BlkioDeviceWriteBps: null,
      BlkioDeviceWriteIOps: null,
      BlkioWeight: 0,
      BlkioWeightDevice: null,
      CapAdd: null,
      CapDrop: ["ALL"],
      Cgroup: "",
      CgroupnsMode: "private",
      CgroupParent: "",
      ConsoleSize: [0, 0] as [number, number],
      ContainerIDFile: "",
      CpuCount: 0,
      CpuPercent: 0,
      CpuPeriod: 0,
      CpuQuota: 0,
      CpuRealtimePeriod: 0,
      CpuRealtimeRuntime: 0,
      CpuShares: 0,
      CpusetCpus: "",
      CpusetMems: "",
      DeviceCgroupRules: null,
      GroupAdd: null,
      DeviceRequests: null,
      Devices: null,
      Dns: null,
      DnsOptions: null,
      DnsSearch: null,
      ExtraHosts: null,
      IpcMode: "private",
      Isolation: "",
      Init: true,
      Links: null,
      LxcConf: null,
      LogConfig: { Type: "none", Config: {} },
      Memory: 4 * 1024 ** 3,
      MemoryReservation: 0,
      MemorySwap: 4 * 1024 ** 3,
      MemorySwappiness: null,
      NanoCpus: 4_000_000_000,
      IOMaximumBandwidth: 0,
      IOMaximumIOps: 0,
      NetworkMode: "none",
      OomKillDisable: null,
      OomScoreAdj: 0,
      PortBindings: null,
      PidMode: "",
      PidsLimit: 512,
      Privileged: false,
      PublishAllPorts: false,
      ReadonlyRootfs: true,
      Runtime: "runc",
      Sysctls: null,
      UTSMode: "",
      UseApiSocket: false,
      UsernsMode: "",
      VolumeDriver: "",
      VolumesFrom: null,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      SecurityOpt: ["no-new-privileges"],
      ShmSize: 64 * 1024 ** 2,
      StorageOpt: null,
      Tmpfs: {
        "/tmp": "rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777",
      },
      Ulimits: [
        { Name: "nofile", Soft: 65_536, Hard: 65_536 },
        { Name: "nproc", Soft: 4_096, Hard: 4_096 },
      ],
      MaskedPaths: [
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
      ],
      ReadonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
      Mounts: runtimeIdentity.imageMounts.map((mount) => ({
        Type: "image",
        Source: mount.imageId,
        Target: mount.target,
        ReadOnly: true,
        ImageOptions: { Subpath: mount.subpath },
      })),
    },
    NetworkSettings: {
      Bridge: "",
      SandboxID: "",
      SandboxKey: "",
      Ports: {},
      HairpinMode: false,
      LinkLocalIPv6Address: "",
      LinkLocalIPv6PrefixLen: 0,
      SecondaryIPAddresses: null,
      SecondaryIPv6Addresses: null,
      EndpointID: "",
      Gateway: "",
      GlobalIPv6Address: "",
      GlobalIPv6PrefixLen: 0,
      IPAddress: "",
      IPPrefixLen: 0,
      IPv6Gateway: "",
      MacAddress: "",
      Networks: {
        none: {
          IPAMConfig: null,
          Links: null,
          Aliases: null,
          MacAddress: "",
          DriverOpts: null,
          GwPriority: 0,
          NetworkID: "",
          EndpointID: "",
          Gateway: "",
          IPAddress: "",
          IPPrefixLen: 0,
          IPv6Gateway: "",
          GlobalIPv6Address: "",
          GlobalIPv6PrefixLen: 0,
          DNSNames: null,
        },
      },
    },
    Mounts: [
      {
        Type: "bind",
        Source: "/host/repo",
        Destination: "/workspace",
        Driver: "",
        Mode: "ro,z",
        RW: false,
        Propagation: "rprivate",
      },
      ...runtimeIdentity.imageMounts.map((mount) => ({
        Type: "image",
        Name: mount.imageId,
        Source: `/var/lib/docker/image-mounts/${mount.target.replaceAll("/", "-")}`,
        Destination: mount.target,
        Driver: "",
        Mode: "",
        RW: false,
        Propagation: "",
        ImageOptions: { Subpath: mount.subpath },
      })),
    ],
  };
}

describe("guarded verifier OCI Docker contract", () => {
  it("binds exact image subpaths and accepts the closed profile", async () => {
    const args: string[] = [];
    appendGuardedVerifierImageMountArgs(args, runtimeIdentity.imageMounts);
    expect(args.join(" ")).toContain(`type=image,src=${imageId}`);
    await expect(
      assertGuardedVerifierContainerRuntime({
        containerId: "c".repeat(64),
        configHash: "config",
        runtimeIdentity,
        authorization,
        workspaceDir: "/repo",
        workspaceMountSource: "/host/repo",
        workdir: "/workspace",
        tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777"],
        inspect: async () => containerFixture(),
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts Docker 28 nullable graph data and omitted storage options", async () => {
    const value = containerFixture();
    (value.GraphDriver as { Data: Record<string, string> | null }).Data = null;
    delete (value.HostConfig as Partial<typeof value.HostConfig>).StorageOpt;

    await expect(
      assertGuardedVerifierContainerRuntime({
        containerId: "c".repeat(64),
        configHash: "config",
        runtimeIdentity,
        authorization,
        workspaceDir: "/repo",
        workspaceMountSource: "/host/repo",
        workdir: "/workspace",
        tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777"],
        inspect: async () => value,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts Docker Desktop 28 output, OOM, and mount metadata defaults", async () => {
    const value = containerFixture();
    value.Config.AttachStdout = true;
    value.Config.AttachStderr = true;
    value.HostConfig.OomKillDisable = false;
    for (const mount of value.Mounts) {
      delete (mount as Partial<typeof mount>).Driver;
      if (mount.Type === "image") {
        mount.Propagation = "rprivate";
      }
    }

    await expect(
      assertGuardedVerifierContainerRuntime({
        containerId: "c".repeat(64),
        configHash: "config",
        runtimeIdentity,
        authorization,
        workspaceDir: "/repo",
        workspaceMountSource: "/host/repo",
        workdir: "/workspace",
        tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777"],
        inspect: async () => value,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects writable, substituted, networked, privileged, and port-exposed profiles", async () => {
    for (const mutate of [
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.Mounts[0].ReadOnly = false;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.Mounts[0].Source = `sha256:${"f".repeat(64)}`;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.Mounts[1].Name = `sha256:${"f".repeat(64)}`;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.Mounts[0].ImageOptions.Subpath = "/opt/openclaw-verifier/dependencies";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.Binds[0] = "/repo:/workspace:ro,z";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.Init = false;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.LogConfig.Type = "json-file";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.NetworkMode = "bridge";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.CpuShares = 1;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.MemoryReservation = 1;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.CpusetCpus = "0";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.Privileged = true;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.PortBindings = { "3000/tcp": {} };
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.HostConfig as Record<string, unknown>).CapAdd = ["SYS_ADMIN"];
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.CapDrop = [];
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.HostConfig as Record<string, unknown>).DeviceRequests = [{}];
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.HostConfig as Record<string, unknown>).Devices = [{}];
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.HostConfig as Record<string, unknown>).GroupAdd = ["docker"];
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.PidMode = "host";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.IpcMode = "host";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.UTSMode = "host";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.UsernsMode = "host";
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.HostConfig as Record<string, unknown>).VolumesFrom = ["other:ro"];
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.PublishAllPorts = true;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.AutoRemove = true;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.RestartPolicy.Name = "always";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.SecurityOpt = [];
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.HostConfig as Record<string, unknown>).Dns = ["8.8.8.8"];
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.HostConfig as Record<string, unknown>).ExtraHosts = [
          "host.docker.internal:host-gateway",
        ];
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.Config.Env.push("LD_PRELOAD=/tmp/inject.so");
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.Config.WorkingDir = "/tmp";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.Config.User = "0";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.Config.AttachStdout = true;
        value.Config.AttachStderr = false;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.OomKillDisable = true;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.Mounts[0].Driver = "local";
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.Mounts[1].Propagation = "shared";
      },
    ]) {
      const value = containerFixture();
      mutate(value);
      await expect(
        assertGuardedVerifierContainerRuntime({
          containerId: "c".repeat(64),
          configHash: "config",
          runtimeIdentity,
          authorization,
          workspaceDir: "/repo",
          workspaceMountSource: "/host/repo",
          workdir: "/workspace",
          tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777"],
          inspect: async () => value,
        }),
      ).rejects.toThrow("isolation profile");
    }
  });

  it("validates the full closed profile before a stopped verifier is started", async () => {
    const stopped = containerFixture();
    stopped.State.Running = false;
    stopped.State.Status = "created";
    stopped.State.Pid = 0;
    await expect(
      assertGuardedVerifierContainerRuntime({
        containerId: "c".repeat(64),
        configHash: "config",
        runtimeIdentity,
        authorization,
        workspaceDir: "/repo",
        workspaceMountSource: "/host/repo",
        workdir: "/workspace",
        tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777"],
        expectedRunning: false,
        inspect: async () => stopped,
      }),
    ).resolves.toBeUndefined();
    stopped.HostConfig.CpuQuota = 1;
    await expect(
      assertGuardedVerifierContainerRuntime({
        containerId: "c".repeat(64),
        configHash: "config",
        runtimeIdentity,
        authorization,
        workspaceDir: "/repo",
        workspaceMountSource: "/host/repo",
        workdir: "/workspace",
        tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777"],
        expectedRunning: false,
        inspect: async () => stopped,
      }),
    ).rejects.toThrow("isolation profile");
  });

  it("rejects unknown Docker 28 profile fields and socket-related additions", async () => {
    for (const mutate of [
      (value: ReturnType<typeof containerFixture>) => {
        (value.HostConfig as Record<string, unknown>).FutureDockerField = true;
      },
      (value: ReturnType<typeof containerFixture>) => {
        value.HostConfig.UseApiSocket = true;
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.Config as Record<string, unknown>).FutureConfigField = true;
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value.NetworkSettings.Networks.none as Record<string, unknown>).FutureNetworkField = true;
      },
      (value: ReturnType<typeof containerFixture>) => {
        (value as Record<string, unknown>).FutureInspectField = true;
      },
    ]) {
      const value = containerFixture();
      mutate(value);
      await expect(
        assertGuardedVerifierContainerRuntime({
          containerId: "c".repeat(64),
          configHash: "config",
          runtimeIdentity,
          authorization,
          workspaceDir: "/repo",
          workspaceMountSource: "/host/repo",
          workdir: "/workspace",
          tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=1777"],
          inspect: async () => value,
        }),
      ).rejects.toThrow();
    }
  });

  it("validates exact image provenance and the Gateway read-only workspace", () => {
    expect(() =>
      assertGuardedVerifierImageIdentity({
        image: imageFixture(),
        imageId,
        runtimeImageId,
        sourceRevision: authorization.sourceRevision,
        repositoryHead: authorization.repositoryHead,
        artifactDigest,
        dependencyManifestDigest,
        browserManifestDigest,
        repositoryIdentityDigest,
        browserIdentityDigest,
        effectiveYarnVersion: "4.9.2",
      }),
    ).not.toThrow();
    expect(() =>
      assertGuardedVerifierGatewayWorkspaceMount({
        workspaceDir: "/repo",
        mounts: [{ Type: "bind", Source: "/host/repo", Destination: "/repo", RW: false }],
      }),
    ).not.toThrow();
    expect(() =>
      assertGuardedVerifierGatewayWorkspaceMount({
        workspaceDir: "/repo",
        mounts: [{ Type: "bind", Source: "/host/repo", Destination: "/repo", RW: true }],
      }),
    ).toThrow("read-only bind");
  });
});
