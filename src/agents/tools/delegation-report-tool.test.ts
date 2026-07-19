import { describe, expect, it } from "vitest";
import { makeCompleteReport } from "../delegation/ledger.test-helpers.js";
import { bindDelegationReportToAssignmentScope } from "./delegation-report-tool.js";

describe("delegation report scope binding", () => {
  it("binds unambiguous worker-local scope labels to protected canonical paths", () => {
    const report = makeCompleteReport({
      assigned: [".openclaw/delegation-runtime-canary.txt (expectation may-create)"],
    });
    report.scope.inspected[0].scopeId = "canary-file";
    report.scope.inspected[0].path = ".openclaw/delegation-runtime-canary.txt";
    report.commands[0].scopeIds = ["canary-file"];

    const bound = bindDelegationReportToAssignmentScope({
      report,
      scopeUnits: [".openclaw/delegation-runtime-canary.txt"],
    });

    expect(bound.scope.assigned).toEqual([".openclaw/delegation-runtime-canary.txt"]);
    expect(bound.scope.inspected[0].scopeId).toBe(
      ".openclaw/delegation-runtime-canary.txt",
    );
    expect(bound.commands[0].scopeIds).toEqual([
      ".openclaw/delegation-runtime-canary.txt",
    ]);
    expect(report.scope.assigned).toEqual([
      ".openclaw/delegation-runtime-canary.txt (expectation may-create)",
    ]);
  });

  it("rejects local labels that do not map one-to-one to protected paths", () => {
    const report = makeCompleteReport({ assigned: ["canary-file"] });
    report.scope.inspected[0].path = "src/outside.ts";

    expect(() =>
      bindDelegationReportToAssignmentScope({
        report,
        scopeUnits: [".openclaw/delegation-runtime-canary.txt"],
      }),
    ).toThrow(/outside the protected assignment/i);
  });
});
