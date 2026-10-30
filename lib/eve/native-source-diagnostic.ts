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
  collectionKind: z.enum(["candidate", "unavailable", "failed", "other"]),
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
