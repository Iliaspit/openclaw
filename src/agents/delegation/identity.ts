import { createHash } from "node:crypto";

export function compareDelegationStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForCanonicalJson(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => compareDelegationStrings(left, right));
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, normalizeForCanonicalJson(entry)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Delegation identity inputs must contain only finite numbers.");
  }
  return value;
}

export function canonicalDelegationJson(value: unknown): string {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

export function hashDelegationIdentity(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalDelegationJson(value))
    .digest("hex");
}

export function createDelegationRecordId(prefix: string, value: unknown): string {
  return `${prefix}_${hashDelegationIdentity(prefix, value)}`;
}
