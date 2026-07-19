import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { DelegationGuardConfig } from "../../config/types.agents.js";
import {
  DELEGATION_VALIDATOR_PROTOCOL,
  type DelegationValidatorRequest,
  type DelegationValidatorResponse,
} from "./contracts.js";

const VALIDATOR_TIMEOUT_MS = 30_000;
const MAX_VALIDATOR_INPUT_BYTES = 1024 * 1024;
const MAX_VALIDATOR_BUNDLE_BYTES = 4 * 1024 * 1024;

function createValidatorEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readPinnedEntrypoint(validator: DelegationGuardConfig["validator"]): {
  entrypoint: string;
  source: Buffer;
} {
  if (!path.isAbsolute(validator.entrypoint)) {
    throw new Error("Delegation validator entrypoint must be an absolute path.");
  }
  const configuredStat = lstatSync(validator.entrypoint);
  if (configuredStat.isSymbolicLink() || !configuredStat.isFile()) {
    throw new Error("Delegation validator entrypoint must be a regular non-symlink file.");
  }
  if ((configuredStat.mode & 0o222) !== 0) {
    throw new Error("Delegation validator entrypoint must be installed read-only.");
  }
  const entrypoint = realpathSync(validator.entrypoint);
  const source = readFileSync(entrypoint);
  if (source.length > MAX_VALIDATOR_BUNDLE_BYTES) {
    throw new Error("Delegation validator bundle exceeds the 4 MiB protected limit.");
  }
  const actualDigest = sha256Hex(source);
  if (actualDigest !== validator.sha256) {
    throw new Error(
      `Delegation validator digest mismatch for ${validator.id}@${validator.version}.`,
    );
  }
  return { entrypoint, source };
}

function materializePinnedEntrypoint(
  validator: DelegationGuardConfig["validator"],
  stateDir = resolveStateDir(),
): string {
  const { source } = readPinnedEntrypoint(validator);
  const directory = path.join(stateDir, "delegation", "validator-bundles");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const cachedEntrypoint = path.join(directory, `${validator.sha256}.mjs`);
  if (!existsSync(cachedEntrypoint)) {
    writeFileSync(cachedEntrypoint, source, { flag: "wx", mode: 0o400 });
  }
  const cachedSource = readFileSync(cachedEntrypoint);
  if (sha256Hex(cachedSource) !== validator.sha256) {
    throw new Error("Protected delegation validator cache digest mismatch.");
  }
  chmodSync(cachedEntrypoint, 0o400);
  return cachedEntrypoint;
}

export function verifyPinnedDelegationValidator(
  validator: DelegationGuardConfig["validator"],
  options?: { stateDir?: string },
): void {
  materializePinnedEntrypoint(validator, options?.stateDir);
}

function parseValidatorResponse(
  raw: string,
  request: DelegationValidatorRequest,
): DelegationValidatorResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Delegation validator returned malformed JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Delegation validator returned a non-object response.");
  }
  const response = parsed as DelegationValidatorResponse;
  if (
    response.protocol !== DELEGATION_VALIDATOR_PROTOCOL ||
    response.action !== request.action ||
    typeof response.ok !== "boolean"
  ) {
    throw new Error("Delegation validator response does not match the requested protocol/action.");
  }
  if (
    response.issues !== undefined &&
    (!Array.isArray(response.issues) ||
      response.issues.some(
        (issue) =>
          !issue ||
          typeof issue !== "object" ||
          typeof issue.code !== "string" ||
          typeof issue.message !== "string" ||
          (issue.path !== undefined && typeof issue.path !== "string"),
      ))
  ) {
    throw new Error("Delegation validator returned malformed issues.");
  }
  return response;
}

export async function runPinnedDelegationValidator(params: {
  validator: DelegationGuardConfig["validator"];
  request: DelegationValidatorRequest;
  stateDir?: string;
}): Promise<DelegationValidatorResponse> {
  if (params.request.protocol !== DELEGATION_VALIDATOR_PROTOCOL) {
    throw new Error("Unsupported delegation validator protocol.");
  }
  const entrypoint = materializePinnedEntrypoint(params.validator, params.stateDir);
  const input = `${JSON.stringify(params.request)}\n`;
  if (Buffer.byteLength(input, "utf8") > MAX_VALIDATOR_INPUT_BYTES) {
    throw new Error("Delegation validator input exceeds the 1 MiB protocol limit.");
  }
  const configuredMaxOutputBytes = Math.floor(params.validator.maxOutputBytes);
  const maxOutputBytes = Number.isSafeInteger(configuredMaxOutputBytes)
    ? Math.max(1024, configuredMaxOutputBytes)
    : 1024;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd: path.dirname(entrypoint),
      env: createValidatorEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Delegation validator execution timed out."));
    }, VALIDATOR_TIMEOUT_MS);
    timeout.unref?.();

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(error);
    };
    const capture = (chunk: Buffer | string, preserve: boolean) => {
      if (settled) {
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error("Delegation validator output exceeds the configured limit."));
        return;
      }
      if (preserve) {
        stdoutChunks.push(bytes);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => capture(chunk, true));
    child.stderr.on("data", (chunk: Buffer | string) => capture(chunk, false));
    child.on("error", (error) => {
      fail(new Error(`Delegation validator execution failed: ${error.message}`));
    });
    child.stdin.on("error", (error) => {
      fail(new Error(`Delegation validator input failed: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (signal) {
        reject(new Error(`Delegation validator terminated by signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Delegation validator exited with status ${String(code)}.`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf8"));
    });
    child.stdin.end(input);
  });
  return parseValidatorResponse(stdout, params.request);
}
