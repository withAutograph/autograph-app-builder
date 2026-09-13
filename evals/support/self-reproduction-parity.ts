/* oxlint-disable eslint/no-await-in-loop -- assessment rows retain deterministic requirement order while checking artifacts. */
import { z } from "zod";

export const parityVersion = "self-reproduction-parity/v1" as const;
export const sides = ["reference", "candidate"] as const;
export const desktopViewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1080, name: "desktop-wide", width: 1920 },
  { height: 768, name: "desktop-window", width: 1024 },
] as const;
export const captureStates = ["panel-resize", "keyboard", "loading", "empty", "error"] as const;

// IDs are the integration boundary. Both adapters must implement the same
// assertions; labels, routes and selectors may differ between applications.
export const workflowMatrix = [
  {
    action: "Enter the fixed brief and continue",
    assertions: ["brief-editable", "continuation-changes-state"],
    id: "anonymous-entry",
    seed: "anonymous-empty",
  },
  {
    action: "Sign in, sign out, then try another user's draft",
    assertions: ["sign-in-restores-draft", "sign-out-revokes-access", "other-user-denied"],
    id: "authentication",
    seed: "anonymous-draft",
  },
  {
    action:
      "Edit all draft fields, await server acknowledgement, reopen in a fresh browser context",
    assertions: ["write-acknowledged", "fresh-context-read-matches", "revision-advanced"],
    id: "durable-draft",
    seed: "owner-empty",
  },
  {
    action: "Complete seeded successful callback through application handler",
    assertions: ["callback-consumed", "draft-preserved", "connection-persisted"],
    id: "provider-return-success",
    seed: "owner-draft-provider-pending",
  },
  {
    action: "Return seeded denial, then replay callback state",
    assertions: ["error-visible", "draft-preserved", "replayed-state-rejected"],
    id: "provider-return-error",
    seed: "owner-draft-provider-pending",
  },
  {
    action: "Submit fixed child brief through this application's creation workflow",
    assertions: [
      "submission-changes-state",
      "durable-job-created",
      "artifact-readable",
      "result-linked",
    ],
    id: "app-creation",
    seed: "owner-build-ready",
  },
  {
    action: "Open preview as owner and as unrelated user",
    assertions: ["owner-preview-loads", "other-user-denied", "expired-access-rejected"],
    id: "preview-access",
    seed: "owner-created-app",
  },
  {
    action: "Cancel while operation is pending and reload",
    assertions: ["cancel-acknowledged", "terminal-state-persists", "no-late-success"],
    id: "cancellation",
    seed: "owner-running-job",
  },
  {
    action: "Retry once and reload",
    assertions: ["retry-changes-state", "single-continuation", "result-persists"],
    id: "retry",
    seed: "owner-failed-job",
  },
  {
    action: "Close context while pending; open new context and resume",
    assertions: ["session-restored", "single-continuation", "result-persists"],
    id: "session-recovery",
    seed: "owner-interrupted-job",
  },
  {
    action: "Create exactly one child via this application; inspect child output and stop",
    assertions: [
      "child-artifact-readable",
      "child-count-one",
      "recursion-depth-one",
      "no-reference-backend",
      "no-reference-source",
    ],
    id: "independent-child",
    seed: "owner-build-ready",
  },
  {
    action: "Navigate to public docs and back",
    assertions: ["docs-readable", "return-navigation-works"],
    id: "documentation",
    seed: "anonymous-empty",
  },
] as const;

export const frameworkMatrix = [
  { assertions: ["request-data-on-server", "useful-server-shell"], id: "server-first" },
  { assertions: ["client-import-graph-reviewed", "interactive-leaves-only"], id: "narrow-client" },
  {
    assertions: ["server-authorizes-write", "durable-readback", "failure-not-success"],
    id: "server-writes",
  },
  {
    assertions: ["two-user-isolation", "sign-out-invalidates", "cache-scope-reviewed"],
    id: "auth-cache-isolation",
  },
  {
    assertions: ["direct-load-fallback-useful", "shared-layout-navigation-fallback-useful"],
    id: "suspense",
  },
  {
    assertions: ["cache-boundaries-reviewed", "static-shell-observed", "revalidation-observed"],
    id: "cache-components",
  },
  {
    assertions: ["app-shell-prefetch-observed", "url-dependent-content-correct"],
    id: "partial-prefetching",
  },
  {
    assertions: ["instant-direct-load", "instant-client-navigation", "resolved-content-visible"],
    id: "instant-navigation",
  },
  {
    assertions: ["back-forward-preserves-draft", "shared-layout-state-preserved", "focus-restored"],
    id: "navigation-continuity",
  },
  {
    assertions: [
      "pending-visible",
      "duplicate-submit-prevented",
      "failure-rolls-back",
      "confirmed-write-reconciles",
    ],
    id: "pending-optimistic",
  },
  { assertions: ["arrusted-token-provenance", "palette-unchanged"], id: "semantic-tokens" },
] as const;

const captureAssertions: Record<(typeof captureStates)[number], string[]> = {
  empty: ["empty-state-visible", "next-action-works"],
  error: ["error-visible", "recovery-action-works"],
  keyboard: ["focus-visible", "keyboard-activation-changes-state"],
  loading: ["pending-held", "useful-loading-visible"],
  "panel-resize": ["panel-dimension-changed", "content-remains-reachable"],
};

export const requirements = [
  ...workflowMatrix.map((row) => ({ ...row, kind: "workflow" as const })),
  ...frameworkMatrix.map((row) => ({ ...row, kind: "framework" as const })),
  ...desktopViewports.flatMap((viewport) =>
    captureStates.map((state) => ({
      assertions: captureAssertions[state],
      id: `capture/${viewport.name}/${state}`,
      kind: "capture" as const,
    })),
  ),
];

const artifactPath = z
  .string()
  .regex(
    /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[^\s]+(?<!\/)$/u,
    "Use a relative evidence artifact path without traversal",
  );
const assertionSchema = z
  .object({
    artifacts: z.array(artifactPath).min(1),
    detail: z.string().min(1),
    id: z.string().min(1),
    passed: z.boolean(),
  })
  .strict();
export const observationSchema = z
  .object({
    artifacts: z.array(artifactPath),
    assertions: z.array(assertionSchema),
    disposition: z.enum([
      "observed",
      "missing-functionality",
      "infrastructure-unavailable",
      "not-run",
    ]),
    method: z.enum([
      "browser",
      "source-review",
      "source-and-browser",
      "@next/playwright/instant",
      "none",
    ]),
    reason: z.string().min(1),
    requirementId: z.enum(requirements.map((row) => row.id)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.assertions.map((item) => item.id)).size !== value.assertions.length)
      ctx.addIssue({ code: "custom", message: "Duplicate assertions" });
  });
export const sideEvidenceSchema = z
  .object({
    observations: z.array(observationSchema),
    output: z.enum(["available", "missing", "infrastructure-unavailable"]),
    reason: z.string().min(1),
    sourceRevision: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.observations.map((item) => item.requirementId)).size !==
      value.observations.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate requirement observations" });
  });
export const parityEvidenceSchema = z
  .object({
    candidate: sideEvidenceSchema,
    fixtureVersion: z.literal(1),
    producer: z.literal("evaluator"),
    reference: sideEvidenceSchema,
    runId: z.string().min(1),
    schemaVersion: z.literal(parityVersion),
  })
  .strict();
export type ParityEvidence = z.infer<typeof parityEvidenceSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type Status = "passed" | "failed" | "blocked" | "unassessed";
export const parityReasonCodes = [
  "observed-complete",
  "output-missing",
  "output-infrastructure-unavailable",
  "missing-functionality",
  "assertion-failed",
  "observation-infrastructure-unavailable",
  "observation-not-run",
  "observation-missing",
  "evidence-incomplete",
] as const;
export type ParityReasonCode = (typeof parityReasonCodes)[number];

export const parityAssessmentSchema = z
  .object({
    rows: z.array(
      z
        .object({
          artifacts: z.array(artifactPath),
          kind: z.enum(["workflow", "framework", "capture"]),
          reason: z.string(),
          reasonCode: z.enum(parityReasonCodes),
          requirementId: z.enum(requirements.map((row) => row.id)),
          side: z.enum(sides),
          status: z.enum(["passed", "failed", "blocked", "unassessed"]),
        })
        .strict(),
    ),
    runId: z.string(),
    schemaVersion: z.literal(parityVersion),
    visualScoresAdvisory: z.literal(true),
  })
  .strict();
export type Assessment = z.infer<typeof parityAssessmentSchema>;

/** artifactExists must verify a nonempty file within the evaluator evidence root. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function assessParity(
  input: unknown,
  artifactExists: (path: string) => Promise<boolean>,
): Promise<Assessment> {
  const evidence = parityEvidenceSchema.parse(input);
  const rows: Assessment["rows"] = [];
  for (const side of sides) {
    const bundle = evidence[side];
    for (const requirement of requirements) {
      const observation = bundle.observations.find((item) => item.requirementId === requirement.id);
      let status: Status = "unassessed";
      let reasonCode: ParityReasonCode = "observation-missing";
      let reason = observation?.reason ?? "No evaluator observation supplied.";
      const artifacts = [
        ...new Set([
          ...(observation?.artifacts ?? []),
          ...(observation?.assertions.flatMap((item) => item.artifacts) ?? []),
        ]),
      ];
      if (bundle.output !== "available") {
        status = bundle.output === "missing" ? "failed" : "blocked";
        reasonCode =
          bundle.output === "missing" ? "output-missing" : "output-infrastructure-unavailable";
        ({ reason } = bundle);
      } else if (observation?.disposition === "missing-functionality") {
        status = "failed";
        reasonCode = "missing-functionality";
      } else if (observation?.assertions.some((assertion) => !assertion.passed)) {
        status = "failed";
        reasonCode = "assertion-failed";
      } else if (observation?.disposition === "infrastructure-unavailable") {
        status = "blocked";
        reasonCode = "observation-infrastructure-unavailable";
      } else if (observation?.disposition === "not-run") {
        reasonCode = "observation-not-run";
      } else if (observation?.disposition === "observed") {
        const complete = requirement.assertions.every((id) =>
          observation.assertions.some((item) => item.id === id && item.passed),
        );
        const retained =
          artifacts.length > 0 && (await Promise.all(artifacts.map(artifactExists))).every(Boolean);
        const screenshot =
          requirement.kind !== "capture" ||
          observation.artifacts.some((path) => path.endsWith(".png"));
        const behavioral =
          requirement.kind === "framework"
            ? observation.method === "source-and-browser" ||
              (requirement.id === "instant-navigation" &&
                observation.method === "@next/playwright/instant")
            : observation.method === "browser";
        const instant =
          requirement.id !== "instant-navigation" ||
          observation.method === "@next/playwright/instant";
        if (complete && retained && screenshot && behavioral && instant) {
          status = "passed";
          reasonCode = "observed-complete";
        } else {
          reasonCode = "evidence-incomplete";
          reason = `Incomplete evidence: assertions=${complete}, retained=${retained}, capture=${screenshot}, behavioral=${behavioral}, instant=${instant}. ${reason}`;
        }
      }
      rows.push({
        artifacts,
        kind: requirement.kind,
        reason,
        reasonCode,
        requirementId: requirement.id,
        side,
        status,
      });
    }
  }
  return { rows, runId: evidence.runId, schemaVersion: parityVersion, visualScoresAdvisory: true };
}
