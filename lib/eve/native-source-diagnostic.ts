import { z } from "zod";

const nativeStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "waiting",
  "queued",
  "suspended",
  "other",
]);
const category = z.enum([
  "type",
  "reference",
  "syntax",
  "schema",
  "invalid_argument",
  "http_unauthorized",
  "http_forbidden",
  "http_not_found",
  "http_conflict",
  "http_throttled",
  "http_server",
  "http_other",
  "identity",
  "pagination",
  "authorization",
  "other",
]);
const count = z.number().int().nonnegative().nullable();
const stepCounts = z.strictObject({
  completed: count,
  pending: count,
  running: count,
  failed: count,
  cancelled: count,
  unknown: count,
});
const boundary = z.strictObject({
  stage: z.enum([
    "authority_anchor",
    "handoff_parent",
    "handoff_successor",
    "final_owner",
    "other",
  ]),
  status: nativeStatus,
  parentStatus: nativeStatus.optional(),
  allowParked: z.boolean().nullable(),
});

/** Private, closed structural facts. Never checkpoint content or authority. */
export const nativeSourceDiagnosticSchema = z.strictObject({
  version: z.literal(1),
  collectionKind: z.enum(["candidate", "preflight", "unavailable", "failed", "other"]),
  collectionReason: z
    .enum([
      "source-not-terminal",
      "native-data-expired",
      "paired-native-checkpoint-unavailable",
      "handoff-discovery-unavailable",
      "handoff-owner-ambiguous",
      "handoff-parent-frontier-uncertain",
      "other",
    ])
    .nullable(),
  collectionBoundary: boundary.nullable(),
  collectionErrorCategory: category.nullable(),
  collectionStage: z.enum(["dependencies", "candidate_collect", "candidate_read"]),
  reconciliation: z.strictObject({
    kind: z.enum(["ready", "uncertain", "unavailable", "failed", "unassessed"]),
    reason: z
      .enum([
        "source-not-terminal",
        "native-data-expired",
        "paired-native-checkpoint-unavailable",
        "native-checkpoint-identity-mismatch",
        "approval-transcript-unavailable",
        "cancelled-call-history-unreconciled",
        "cancelled-call-result-unreconciled",
        "cancelled-turn-replay",
        "conflicting-retained-history",
        "coordination-results-incomplete",
        "delivery-consumption-unreconciled",
        "failed-turn-effects-unreconciled",
        "later-coordination-input-unreconciled",
        "native-stream-incomplete",
        "runtime-result-consumption-ambiguous",
        "runtime-result-owner-unreconciled",
        "unconsumed-native-inbox-input",
        "unreadable-native-effect-frontier",
        "uncommitted-action-result",
        "uncommitted-action-dispatch",
        "other",
      ])
      .nullable(),
    errorCategory: category.nullable(),
  }),
  lineageRead: z.strictObject({
    outcome: z.enum(["succeeded", "failed", "unassessed"]),
    provenRunCount: count,
    unsettledStepCount: count,
    stepCounts: stepCounts.nullable(),
    errorCategory: category.nullable(),
    httpStatus: z.number().int().min(400).max(599).nullable(),
  }),
  anchorRead: z.strictObject({
    outcome: z.enum(["succeeded", "failed"]),
    stage: z.enum([
      "complete",
      "dependencies",
      "world",
      "run_read",
      "run_identity",
      "steps_list",
      "step_identity",
      "step_pagination",
      "other",
    ]),
    errorCategory: category.nullable(),
    httpStatus: z.number().int().min(400).max(599).nullable().optional(),
    status: nativeStatus.nullable(),
    unsettledStepCount: count,
    stepCounts: stepCounts.nullable(),
  }),
});

/** Validation failure and missing older summaries are advisory, with no raw body logging. */
export const reportNativeSourceDiagnostic = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This private HTTP boundary immediately validates unknown JSON with the closed diagnostic schema.
  value: unknown,
  unavailableReason?: "request_failed" | "identity_mismatch",
): void => {
  const parsed = nativeSourceDiagnosticSchema.safeParse(value);
  try {
    console.info(
      JSON.stringify(
        parsed.success && unavailableReason === undefined
          ? {
              event: "builder.native_source_observation_relay",
              outcome: "available",
              diagnostic: parsed.data,
            }
          : {
              event: "builder.native_source_observation_relay",
              outcome: "unavailable",
              reason:
                unavailableReason ?? (value === undefined ? "missing_summary" : "invalid_summary"),
            },
      ),
    );
  } catch {
    // Diagnostic sinks never change GET or recovery admission.
  }
};
