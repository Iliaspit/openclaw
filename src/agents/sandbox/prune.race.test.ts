import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "./types.js";

const registryMocks = vi.hoisted(() => ({
  readRegistry: vi.fn(),
  readBrowserRegistry: vi.fn(),
  removeRegistryEntryOwned: vi.fn(),
  removeBrowserRegistryEntryOwned: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  removeRuntime: vi.fn(),
  stopBrowserBridgeServer: vi.fn(),
}));

const bridgeState = vi.hoisted(() => ({
  bridges: new Map(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: runtimeMocks.stopBrowserBridgeServer,
}));

vi.mock("./backend.js", () => ({
  getSandboxBackendManager: vi.fn(() => ({
    removeRuntime: runtimeMocks.removeRuntime,
  })),
}));

vi.mock("./browser-bridges.js", () => ({
  BROWSER_BRIDGES: bridgeState.bridges,
}));

vi.mock("./docker-backend.js", () => ({
  dockerSandboxBackendManager: {
    removeRuntime: runtimeMocks.removeRuntime,
  },
}));

vi.mock("./registry.js", () => ({
  readRegistry: registryMocks.readRegistry,
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  removeRegistryEntryOwned: registryMocks.removeRegistryEntryOwned,
  removeBrowserRegistryEntryOwned: registryMocks.removeBrowserRegistryEntryOwned,
}));

const { maybePruneSandboxes } = await import("./prune.js");

function pruneConfig(): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "session",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: true,
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
      autoStartTimeoutMs: 12_000,
    },
    tools: {
      allow: ["browser"],
      deny: [],
    },
    prune: {
      idleHours: 1,
      maxAgeDays: 1,
    },
  };
}

describe("sandbox prune ownership races", () => {
  beforeEach(() => {
    bridgeState.bridges.clear();
    vi.clearAllMocks();
    registryMocks.readRegistry.mockResolvedValue({ entries: [] });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.removeRegistryEntryOwned.mockResolvedValue(true);
    registryMocks.removeBrowserRegistryEntryOwned.mockResolvedValue(true);
    runtimeMocks.removeRuntime.mockResolvedValue(undefined);
    runtimeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  it("preserves a replacement bridge when exact registry removal loses the race", async () => {
    const oldRuntimeId = "a".repeat(64);
    const replacementRuntimeId = "b".repeat(64);
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "browser-race",
          runtimeId: oldRuntimeId,
          sessionKey: "agent:tester:race",
          createdAtMs: 0,
          lastUsedAtMs: 0,
          image: "browser-old",
          cdpPort: 9222,
        },
      ],
    });
    registryMocks.removeBrowserRegistryEntryOwned.mockResolvedValue(false);
    bridgeState.bridges.set("agent:tester:race", {
      containerName: "browser-race",
      runtimeId: replacementRuntimeId,
      bridge: { server: {} },
    });

    await maybePruneSandboxes(pruneConfig());

    expect(runtimeMocks.removeRuntime).toHaveBeenCalledOnce();
    expect(runtimeMocks.stopBrowserBridgeServer).not.toHaveBeenCalled();
    expect(bridgeState.bridges.get("agent:tester:race")).toMatchObject({
      runtimeId: replacementRuntimeId,
    });
  });
});
