import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const runLive = process.env.OPENCLAW_RUN_GUARDED_VERIFIER_IMAGE_SMOKE === "1";

describe.runIf(runLive)("guarded verifier raw image diagnostic (not acceptance)", () => {
  it("checks OCI toolchain bytes only; protected installed acceptance is separate", async () => {
    const workspace = process.env.OPENCLAW_VERIFIER_WORKSPACE_DIR;
    const image = process.env.OPENCLAW_VERIFIER_IMAGE_ID;
    if (!workspace || !image) {
      throw new Error("Guarded verifier live smoke environment is incomplete.");
    }
    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "1000:1000",
        "--mount",
        `type=bind,src=${workspace},dst=/workspace,readonly`,
        "--mount",
        `type=image,src=${image},dst=/workspace/node_modules,readonly,image-subpath=opt/openclaw-verifier/dependencies`,
        "--mount",
        `type=image,src=${image},dst=/home/node/.cache/ms-playwright,readonly,image-subpath=opt/openclaw-verifier/browsers`,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000",
        "--tmpfs",
        "/workspace/node_modules/.vite-temp:rw,nosuid,nodev,noexec,size=512m,uid=1000,gid=1000",
        image,
        "sh",
        "-lc",
        'yarn --version && node -e "' +
          "const { chromium } = require('playwright'); " +
          "chromium.launch({headless:true}).then(async b => { " +
          "console.log('playwright-launched'); await b.close(); })\"",
      ],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
    expect(stdout).toContain("playwright-launched");
  });
});
