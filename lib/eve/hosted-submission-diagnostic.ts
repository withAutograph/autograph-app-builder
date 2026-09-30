import { createHash } from "node:crypto";

import { z } from "zod";

import type { HostedOperationKind } from "./hosted-store";

export type HostedSubmissionPhase =
  | "start_lookup"
  | "start_alias_lookup"
  | "reservation"
  | "reservation_verification"
  | "dispatch"
  | "unsuccessful_settlement"
  | "settlement"
  | "settlement_verification"
  | "recovery"
  | "checkpoint_cleanup"
  | "transport_dispatch"
  | "transport_acceptance"
  | "transport_start_confirmation";

const sqlStateCategories = {
  "08000": "storage_temporarily_unavailable",
  "08001": "storage_temporarily_unavailable",
  "08003": "storage_temporarily_unavailable",
  "08004": "storage_temporarily_unavailable",
  "08006": "storage_temporarily_unavailable",
  "08007": "storage_temporarily_unavailable",
  "08P01": "storage_temporarily_unavailable",
  "23502": "storage_constraint_rejected",
  "23503": "storage_constraint_rejected",
  "23505": "storage_constraint_rejected",
  "23514": "storage_constraint_rejected",
  "25P02": "storage_transaction_aborted",
  "40001": "storage_temporarily_unavailable",
  "40P01": "storage_temporarily_unavailable",
  "42501": "storage_access_denied",
  "42703": "storage_schema_unavailable",
  "42P01": "storage_schema_unavailable",
  "53300": "storage_temporarily_unavailable",
  "53400": "storage_temporarily_unavailable",
  "55P03": "storage_temporarily_unavailable",
  "57014": "storage_temporarily_unavailable",
  "57P01": "storage_temporarily_unavailable",
  "57P02": "storage_temporarily_unavailable",
  "57P03": "storage_temporarily_unavailable",
} as const;

type SqlState = keyof typeof sqlStateCategories;

const sqlStateSchema = z.enum([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "23502",
  "23503",
  "23505",
  "23514",
  "25P02",
  "40001",
  "40P01",
  "42501",
  "42703",
  "42P01",
  "53300",
  "53400",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
]);

export interface HostedSubmissionDiagnostic {
  event: "builder.hosted_submission_uncertain";
  phase: HostedSubmissionPhase;
  operationKind: HostedOperationKind;
  clientRequestIdHash?: string;
  operationIdHash?: string;
  adapterSessionIdHash?: string;
  savedState?: "reserved" | "submission_unknown";
  category: (typeof sqlStateCategories)[SqlState] | "unclassified_failure";
  sqlState?: SqlState;
}

export type HostedSubmissionDiagnosticSink = (
  diagnostic: HostedSubmissionDiagnostic,
) => void | Promise<void>;

const identifierHash = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Inspect data properties only; errors may contain secrets or hostile accessors. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser is the boundary for arbitrary caught exception objects.
const sqlStateFor = (error: unknown): SqlState | undefined => {
  const seen = new Set<object>();
  let candidate = error;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Exception causes require data-only inspection before parsing an allowlisted SQLSTATE.
  while (typeof candidate === "object" && candidate !== null && !seen.has(candidate)) {
    seen.add(candidate);
    const code: unknown = Object.getOwnPropertyDescriptor(candidate, "code")?.value;
    const parsed = sqlStateSchema.safeParse(code);
    if (parsed.success) {
      return parsed.data;
    }
    candidate = Object.getOwnPropertyDescriptor(candidate, "cause")?.value;
  }
  return undefined;
};

const discardDiagnosticRejection = async (delivery: Promise<void>): Promise<void> => {
  try {
    await delivery;
  } catch {
    // An asynchronous log sink has no authority over operation settlement.
  }
};

/** This is server observability, never an operation receipt or a recovery authority. */
export const reportHostedSubmissionDiagnostic = (input: {
  phase: HostedSubmissionPhase;
  operationKind: HostedSubmissionDiagnostic["operationKind"];
  clientRequestId?: string;
  operationId?: string;
  adapterSessionId?: string;
  savedState?: HostedSubmissionDiagnostic["savedState"];
  error?: unknown;
  sink?: HostedSubmissionDiagnosticSink;
}): void => {
  try {
    const sqlState = sqlStateFor(input.error);
    const diagnostic: HostedSubmissionDiagnostic = {
      category: sqlState === undefined ? "unclassified_failure" : sqlStateCategories[sqlState],
      event: "builder.hosted_submission_uncertain",
      operationKind: input.operationKind,
      phase: input.phase,
    };
    if (sqlState !== undefined) {
      diagnostic.sqlState = sqlState;
    }
    if (input.clientRequestId !== undefined) {
      diagnostic.clientRequestIdHash = identifierHash(input.clientRequestId);
    }
    if (input.operationId !== undefined) {
      diagnostic.operationIdHash = identifierHash(input.operationId);
    }
    if (input.adapterSessionId !== undefined) {
      diagnostic.adapterSessionIdHash = identifierHash(input.adapterSessionId);
    }
    if (input.savedState !== undefined) {
      diagnostic.savedState = input.savedState;
    }
    if (input.sink === undefined) {
      console.error("[builder:hosted-submission]", diagnostic);
    } else {
      const delivery = input.sink(diagnostic);
      if (delivery !== undefined) {
        void discardDiagnosticRejection(delivery);
      }
    }
  } catch {
    // A log sink or arbitrary error object must never change durable operation behavior.
  }
};
