import type {
  DelegationReportErrorCode,
  DelegationValidationOutcome,
} from "./contracts.js";

const MAX_REPORT_RESULT_MESSAGE_BYTES = 1024;
const MAX_REPORT_RESULT_ISSUES = 16;
const MAX_REPORT_RESULT_ISSUE_CODE_BYTES = 128;
const MAX_REPORT_RESULT_ISSUE_PATH_BYTES = 512;

export type DelegationReportIssue = {
  code: string;
  message: string;
  path?: string;
};

export type DelegationReportAcceptedResult = {
  status: "accepted";
  assignmentId: string;
  receiptId: string;
  validationId: string;
  semanticDigest: string;
};

export type DelegationReportPreReceiptRejectedResult = {
  status: "rejected";
  assignmentId: string;
  errorCode: DelegationReportErrorCode;
  message: string;
  auditEventId: string;
  issues: DelegationReportIssue[];
};

export type DelegationReportReceiptRejectedResult = {
  status: "rejected" | "blocked";
  assignmentId: string;
  errorCode: DelegationReportErrorCode;
  message: string;
  receiptId: string;
  validationId: string;
  semanticDigest: string;
  issues: DelegationReportIssue[];
};

export type DelegationReportResult =
  | DelegationReportAcceptedResult
  | DelegationReportPreReceiptRejectedResult
  | DelegationReportReceiptRejectedResult;

export class DelegationReportContractError extends Error {
  constructor(
    readonly errorCode: DelegationReportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DelegationReportContractError";
  }
}

export function boundDelegationReportText(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  let bytes = 0;
  let bounded = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bounded += character;
    bytes += characterBytes;
  }
  return bounded;
}

export function normalizeDelegationReportIssues(issues: unknown[]): DelegationReportIssue[] {
  return issues.slice(0, MAX_REPORT_RESULT_ISSUES).map((rawIssue) => {
    const issue =
      rawIssue && typeof rawIssue === "object"
        ? (rawIssue as { code?: unknown; message?: unknown; path?: unknown })
        : {};
    const code = boundDelegationReportText(
      typeof issue.code === "string" ? issue.code : "unknown",
      MAX_REPORT_RESULT_ISSUE_CODE_BYTES,
    );
    const message = boundDelegationReportText(
      typeof issue.message === "string" ? issue.message : "Delegation report was rejected.",
      MAX_REPORT_RESULT_MESSAGE_BYTES,
    );
    const path =
      typeof issue.path === "string"
        ? boundDelegationReportText(issue.path, MAX_REPORT_RESULT_ISSUE_PATH_BYTES)
        : undefined;
    return path ? { code, message, path } : { code, message };
  });
}

export function resolveDelegationReportErrorCode(params: {
  fallback: DelegationReportErrorCode;
  issues?: unknown[];
}): DelegationReportErrorCode {
  const issueCodes = new Set(
    normalizeDelegationReportIssues(params.issues ?? []).map((issue) => issue.code),
  );
  if (issueCodes.has("candidate-drift")) {
    return "candidate_drift";
  }
  if (issueCodes.has("validator-execution-failed")) {
    return "validator_execution_failed";
  }
  if (issueCodes.has("report-structure-invalid")) {
    return "report_structure_invalid";
  }
  return params.fallback;
}

export function createDelegationReportFailureResult(params:
  | {
      phase: "pre_receipt";
      assignmentId: string;
      errorCode: DelegationReportErrorCode;
      message: string;
      auditEventId: string;
      issues?: unknown[];
    }
  | {
      phase: "receipt";
      assignmentId: string;
      outcome: Exclude<DelegationValidationOutcome, "accepted">;
      errorCode: DelegationReportErrorCode;
      message: string;
      receiptId: string;
      validationId: string;
      semanticDigest: string;
      issues?: unknown[];
    }): DelegationReportPreReceiptRejectedResult | DelegationReportReceiptRejectedResult {
  const assignmentId = params.assignmentId;
  const errorCode = params.errorCode;
  const message = boundDelegationReportText(params.message, MAX_REPORT_RESULT_MESSAGE_BYTES);
  const issues = normalizeDelegationReportIssues(params.issues ?? []);
  if (params.phase === "pre_receipt") {
    return {
      status: "rejected",
      assignmentId,
      errorCode,
      message,
      auditEventId: params.auditEventId,
      issues,
    };
  }
  return {
    status: params.outcome,
    assignmentId,
    errorCode,
    message,
    receiptId: params.receiptId,
    validationId: params.validationId,
    semanticDigest: params.semanticDigest,
    issues,
  };
}
