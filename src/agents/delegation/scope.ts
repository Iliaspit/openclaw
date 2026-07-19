import path from "node:path";
import {
  DELEGATION_SCOPE_VERSION,
  type CanonicalDelegationScope,
  type DelegationScopeManifest,
  type DelegationSliceScopeManifest,
} from "./contracts.js";
import {
  canonicalDelegationJson,
  compareDelegationStrings,
  hashDelegationIdentity,
} from "./identity.js";

const GLOB_META = /[*?[\]{}]/;

export function canonicalizeDelegationScopePath(input: string): string {
  if (!input || input.trim() !== input) {
    throw new Error("Delegation scope paths must be non-empty and cannot contain edge whitespace.");
  }
  if (input.includes("\\")) {
    throw new Error(`Delegation scope path must use POSIX separators: ${input}`);
  }
  if (path.posix.isAbsolute(input)) {
    throw new Error(`Delegation scope path must be repository-relative: ${input}`);
  }
  if (GLOB_META.test(input)) {
    throw new Error(`Delegation scope path cannot contain glob syntax: ${input}`);
  }
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized === "" || normalized.startsWith("../")) {
    throw new Error(`Delegation scope path cannot name or escape the repository root: ${input}`);
  }
  if (normalized !== input || input.endsWith("/")) {
    throw new Error(`Delegation scope path must already be canonical: ${input}`);
  }
  const unicodeCanonical = normalized.normalize("NFC");
  if (unicodeCanonical !== input) {
    throw new Error(`Delegation scope path must use canonical Unicode spelling: ${input}`);
  }
  return unicodeCanonical;
}

function canonicalizeSliceManifest(
  manifest: DelegationSliceScopeManifest,
): DelegationSliceScopeManifest {
  if (manifest.entries.length === 0) {
    throw new Error("A sliced delegation scope must contain at least one file.");
  }
  const seen = new Set<string>();
  const entries = manifest.entries.map((entry) => {
    const canonicalPath = canonicalizeDelegationScopePath(entry.path);
    if (seen.has(canonicalPath)) {
      throw new Error(`Delegation scope contains a duplicate path: ${canonicalPath}`);
    }
    seen.add(canonicalPath);
    if (entry.expectation !== "existing" && entry.expectation !== "may-create") {
      throw new Error(`Unsupported delegation scope expectation for ${canonicalPath}.`);
    }
    return { path: canonicalPath, expectation: entry.expectation };
  });
  entries.sort((left, right) => compareDelegationStrings(left.path, right.path));
  return {
    version: DELEGATION_SCOPE_VERSION,
    kind: "slice",
    entries,
  };
}

export function canonicalizeDelegationScope(
  manifest: DelegationScopeManifest,
): CanonicalDelegationScope {
  if (manifest.version !== DELEGATION_SCOPE_VERSION) {
    throw new Error(`Unsupported delegation scope version: ${String(manifest.version)}`);
  }
  const canonicalManifest: DelegationScopeManifest =
    manifest.kind === "slice"
      ? canonicalizeSliceManifest(manifest)
      : manifest.operatorAuthorized
        ? {
            version: DELEGATION_SCOPE_VERSION,
            kind: "repository",
            operatorAuthorized: true,
          }
        : (() => {
            throw new Error("Repository-wide delegation scope requires operator authorization.");
          })();
  const canonicalJson = canonicalDelegationJson(canonicalManifest);
  return {
    manifest: canonicalManifest,
    canonicalJson,
    scopeDigest: hashDelegationIdentity("delegation-scope-v1", canonicalManifest),
    paths:
      canonicalManifest.kind === "slice"
        ? canonicalManifest.entries.map((entry) => entry.path)
        : [],
  };
}
