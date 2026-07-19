import { describe, expect, it } from "vitest";
import type { DelegationScopeManifest } from "./contracts.js";
import { canonicalizeDelegationScope } from "./scope.js";

function slice(...paths: string[]): DelegationScopeManifest {
  return {
    version: "openclaw-scope-v1",
    kind: "slice",
    entries: paths.map((path) => ({ path, expectation: "existing" })),
  };
}

describe("canonical delegation scope", () => {
  it("sorts finite file paths into one deterministic canonical manifest", () => {
    const first = canonicalizeDelegationScope(slice("src/z.ts", "src/a.ts"));
    const second = canonicalizeDelegationScope(slice("src/a.ts", "src/z.ts"));

    expect(first.paths).toEqual(["src/a.ts", "src/z.ts"]);
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.scopeDigest).toBe(second.scopeDigest);
  });

  it.each([
    ["empty slice", slice()],
    ["repository root", slice(".")],
    ["absolute path", slice("/tmp/file.ts")],
    ["parent escape", slice("../file.ts")],
    ["noncanonical alias", slice("src/../file.ts")],
    ["directory spelling", slice("src/")],
    ["glob star", slice("src/*.ts")],
    ["glob braces", slice("src/{a,b}.ts")],
    ["glob character class", slice("src/[ab].ts")],
    ["Windows separator", slice("src\\file.ts")],
    ["edge whitespace", slice(" src/file.ts")],
    ["duplicate", slice("src/file.ts", "src/file.ts")],
  ])("rejects %s before candidate creation", (_label, manifest) => {
    expect(() => canonicalizeDelegationScope(manifest)).toThrow();
  });

  it("rejects a repository scope without explicit operator authorization", () => {
    expect(() =>
      canonicalizeDelegationScope({
        version: "openclaw-scope-v1",
        kind: "repository",
        operatorAuthorized: false,
      } as unknown as DelegationScopeManifest),
    ).toThrow(/operator authorization/i);
  });

  it("accepts the explicit repository scope kind without representing it as a path", () => {
    const scope = canonicalizeDelegationScope({
      version: "openclaw-scope-v1",
      kind: "repository",
      operatorAuthorized: true,
    });

    expect(scope.paths).toEqual([]);
    expect(scope.manifest).toEqual({
      version: "openclaw-scope-v1",
      kind: "repository",
      operatorAuthorized: true,
    });
  });
});
