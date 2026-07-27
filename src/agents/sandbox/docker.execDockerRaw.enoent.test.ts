import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { dockerContainerState, execDockerRaw } from "./docker.js";

describe("execDockerRaw", () => {
  it("wraps docker ENOENT with an actionable configuration error", async () => {
    await withEnvAsync({ PATH: "" }, async () => {
      let err: unknown;
      try {
        await execDockerRaw(["version"]);
      } catch (caught) {
        err = caught;
      }

      expect(err).toBeInstanceOf(Error);
      expect(err).toMatchObject({ code: "INVALID_CONFIG" });
      expect((err as Error).message).toContain("Sandbox mode requires Docker");
      expect((err as Error).message).toContain("agents.defaults.sandbox.mode=off");
    });
  });

  it("enforces explicit wall-clock and output bounds", async () => {
    const binDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-docker-bounds-"));
    const docker = path.join(binDir, "docker");
    try {
      await writeFile(
        docker,
        "#!/bin/sh\nif [ \"$1\" = slow ]; then exec sleep 5; else printf '0123456789'; fi\n",
      );
      await chmod(docker, 0o755);
      await withEnvAsync({ PATH: `${binDir}:${process.env.PATH ?? ""}` }, async () => {
        await expect(execDockerRaw(["slow"], { timeoutMs: 10 })).rejects.toThrow(
          "wall-clock deadline",
        );
        await expect(execDockerRaw(["large"], { maxOutputBytes: 4 })).rejects.toThrow(
          "output byte limit",
        );
      });
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("distinguishes proven container absence from ambiguous inspect failures", async () => {
    const binDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-docker-state-"));
    const docker = path.join(binDir, "docker");
    try {
      await writeFile(
        docker,
        [
          "#!/bin/sh",
          'case "$DOCKER_STATE_FIXTURE" in',
          "  absent) printf 'Error: No such object: exact-id\\n' >&2; exit 1 ;;",
          "  outage) printf 'permission denied while connecting to daemon\\n' >&2; exit 1 ;;",
          "  malformed) printf 'maybe\\n'; exit 0 ;;",
          "  running) printf 'true\\n'; exit 0 ;;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(docker, 0o755);
      const pathValue = `${binDir}:${process.env.PATH ?? ""}`;
      await withEnvAsync(
        { PATH: pathValue, DOCKER_STATE_FIXTURE: "absent" },
        async () =>
          await expect(dockerContainerState("exact-id")).resolves.toEqual({
            exists: false,
            running: false,
          }),
      );
      await withEnvAsync(
        { PATH: pathValue, DOCKER_STATE_FIXTURE: "outage" },
        async () =>
          await expect(dockerContainerState("exact-id")).rejects.toThrow("Could not establish"),
      );
      await withEnvAsync(
        { PATH: pathValue, DOCKER_STATE_FIXTURE: "malformed" },
        async () =>
          await expect(dockerContainerState("exact-id")).rejects.toThrow(
            "malformed container state",
          ),
      );
      await withEnvAsync(
        { PATH: pathValue, DOCKER_STATE_FIXTURE: "running" },
        async () =>
          await expect(dockerContainerState("exact-id")).resolves.toEqual({
            exists: true,
            running: true,
          }),
      );
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
