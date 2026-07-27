import fs from "node:fs/promises";
import { z } from "zod";
import { writeJsonAtomic } from "../../infra/json-files.js";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { SANDBOX_BROWSER_REGISTRY_PATH, SANDBOX_REGISTRY_PATH } from "./constants.js";

export type SandboxRegistryEntry = {
  containerName: string;
  /** Immutable backend identity captured after creation; absent on legacy entries. */
  runtimeId?: string;
  backendId?: string;
  runtimeLabel?: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configLabelKind?: string;
  configHash?: string;
};

type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

export type SandboxBrowserRegistryEntry = {
  containerName: string;
  /** Immutable Docker container identity; absent on legacy entries. */
  runtimeId?: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configHash?: string;
  cdpPort: number;
  noVncPort?: number;
};

type SandboxBrowserRegistry = {
  entries: SandboxBrowserRegistryEntry[];
};

type RegistryReadMode = "strict" | "fallback";

/**
 * Runtime ownership changes are explicit. `adopt-existing` is reserved for a
 * caller that has already inspected and validated the exact live runtime
 * represented by a legacy row.
 */
export type RegistryRuntimeTransition = "new-runtime" | "adopt-existing";

type RegistryEntry = {
  containerName: string;
};

type RegistryFile<T extends RegistryEntry> = {
  entries: T[];
};

type UpsertEntry = RegistryEntry & {
  runtimeId?: string;
  backendId?: string;
  runtimeLabel?: string;
  createdAtMs: number;
  image: string;
  configLabelKind?: string;
  configHash?: string;
};

const RegistryEntrySchema = z
  .object({
    containerName: z.string(),
  })
  .passthrough();

const RegistryFileSchema = z.object({
  entries: z.array(RegistryEntrySchema),
});

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

async function withRegistryLock<T>(registryPath: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireSessionWriteLock({
    sessionFile: registryPath,
    allowReentrant: false,
    timeoutMs: 60_000,
  });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function readRegistryFromFile<T extends RegistryEntry>(
  registryPath: string,
  mode: RegistryReadMode,
): Promise<RegistryFile<T>> {
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    const parsed = safeParseJsonWithSchema(RegistryFileSchema, raw) as RegistryFile<T> | null;
    if (parsed) {
      return parsed;
    }
    if (mode === "fallback") {
      return { entries: [] };
    }
    throw new Error(`Invalid sandbox registry format: ${registryPath}`);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [] };
    }
    if (mode === "fallback") {
      return { entries: [] };
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
  }
}

async function writeRegistryFile<T extends RegistryEntry>(
  registryPath: string,
  registry: RegistryFile<T>,
): Promise<void> {
  await writeJsonAtomic(registryPath, registry, { trailingNewline: true });
}

export async function readRegistry(): Promise<SandboxRegistry> {
  const registry = await readRegistryFromFile<SandboxRegistryEntry>(
    SANDBOX_REGISTRY_PATH,
    "fallback",
  );
  return {
    entries: registry.entries.map((entry) => normalizeSandboxRegistryEntry(entry)),
  };
}

export async function readRegistryStrict(): Promise<SandboxRegistry> {
  const registry = await readRegistryFromFile<SandboxRegistryEntry>(
    SANDBOX_REGISTRY_PATH,
    "strict",
  );
  return {
    entries: registry.entries.map((entry) => normalizeSandboxRegistryEntry(entry)),
  };
}

function upsertEntry<T extends UpsertEntry>(
  entries: T[],
  entry: T,
  runtimeTransition?: RegistryRuntimeTransition,
): T[] {
  const existing = entries.find((item) => item.containerName === entry.containerName);
  if (runtimeTransition === "adopt-existing" && !existing) {
    throw new Error(
      `Cannot adopt sandbox runtime ${entry.containerName} without an existing registry row.`,
    );
  }
  const replacesRuntime =
    Boolean(existing) && Boolean(entry.runtimeId) && existing?.runtimeId !== entry.runtimeId;
  if (replacesRuntime && !runtimeTransition) {
    throw new Error(
      `Sandbox runtime ownership transition for ${entry.containerName} requires an explicit mode.`,
    );
  }
  if (runtimeTransition === "adopt-existing" && existing?.runtimeId) {
    throw new Error(`Cannot adopt sandbox runtime ${entry.containerName} over an exact owner.`);
  }
  const next = entries.filter((item) => item.containerName !== entry.containerName);
  const retainedCreatedAtMs = existing?.createdAtMs ?? entry.createdAtMs;
  const retainedImage = existing?.image ?? entry.image;
  next.push({
    ...entry,
    backendId: entry.backendId ?? existing?.backendId,
    runtimeId: entry.runtimeId ?? existing?.runtimeId,
    runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
    createdAtMs: replacesRuntime ? entry.createdAtMs : retainedCreatedAtMs,
    image: replacesRuntime ? entry.image : retainedImage,
    configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
    configHash: entry.configHash ?? existing?.configHash,
  });
  return next;
}

function removeEntry<T extends RegistryEntry>(entries: T[], containerName: string): T[] {
  return entries.filter((entry) => entry.containerName !== containerName);
}

function hasSameRuntimeOwnership(
  current: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
  expected: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
): boolean {
  return (
    current.containerName === expected.containerName &&
    current.runtimeId === expected.runtimeId &&
    current.sessionKey === expected.sessionKey &&
    current.createdAtMs === expected.createdAtMs
  );
}

async function withRegistryMutation<T extends RegistryEntry>(
  registryPath: string,
  mutate: (entries: T[]) => T[] | null,
): Promise<void> {
  await withRegistryLock(registryPath, async () => {
    const registry = await readRegistryFromFile<T>(registryPath, "strict");
    const next = mutate(registry.entries);
    if (next === null) {
      return;
    }
    await writeRegistryFile(registryPath, { entries: next });
  });
}

export async function updateRegistry(
  entry: SandboxRegistryEntry,
  options?: { runtimeTransition?: RegistryRuntimeTransition },
) {
  await withRegistryMutation<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, (entries) =>
    upsertEntry(entries, entry, options?.runtimeTransition),
  );
}

export async function removeRegistryEntry(containerName: string) {
  await withRegistryMutation<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, (entries) => {
    const next = removeEntry(entries, containerName);
    if (next.length === entries.length) {
      return null;
    }
    return next;
  });
}

export async function removeRegistryEntryExact(containerName: string, runtimeId: string) {
  await withRegistryMutation<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, (entries) => {
    const existing = entries.find((entry) => entry.containerName === containerName);
    if (!existing || existing.runtimeId !== runtimeId) {
      return null;
    }
    return removeEntry(entries, containerName);
  });
}

export async function removeRegistryEntryOwned(expected: SandboxRegistryEntry): Promise<boolean> {
  let removed = false;
  await withRegistryMutation<SandboxRegistryEntry>(SANDBOX_REGISTRY_PATH, (entries) => {
    const existing = entries.find((entry) => entry.containerName === expected.containerName);
    if (!existing || !hasSameRuntimeOwnership(existing, expected)) {
      return null;
    }
    removed = true;
    return removeEntry(entries, expected.containerName);
  });
  return removed;
}

export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  return await readRegistryFromFile<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    "fallback",
  );
}

export async function readBrowserRegistryStrict(): Promise<SandboxBrowserRegistry> {
  return await readRegistryFromFile<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    "strict",
  );
}

export async function updateBrowserRegistry(
  entry: SandboxBrowserRegistryEntry,
  options?: { runtimeTransition?: RegistryRuntimeTransition },
) {
  await withRegistryMutation<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    (entries) => upsertEntry(entries, entry, options?.runtimeTransition),
  );
}

export async function removeBrowserRegistryEntry(containerName: string) {
  await withRegistryMutation<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    (entries) => {
      const next = removeEntry(entries, containerName);
      if (next.length === entries.length) {
        return null;
      }
      return next;
    },
  );
}

export async function removeBrowserRegistryEntryExact(containerName: string, runtimeId: string) {
  await withRegistryMutation<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    (entries) => {
      const existing = entries.find((entry) => entry.containerName === containerName);
      if (!existing || existing.runtimeId !== runtimeId) {
        return null;
      }
      return removeEntry(entries, containerName);
    },
  );
}

export async function removeBrowserRegistryEntryOwned(
  expected: SandboxBrowserRegistryEntry,
): Promise<boolean> {
  let removed = false;
  await withRegistryMutation<SandboxBrowserRegistryEntry>(
    SANDBOX_BROWSER_REGISTRY_PATH,
    (entries) => {
      const existing = entries.find((entry) => entry.containerName === expected.containerName);
      if (!existing || !hasSameRuntimeOwnership(existing, expected)) {
        return null;
      }
      removed = true;
      return removeEntry(entries, expected.containerName);
    },
  );
  return removed;
}
