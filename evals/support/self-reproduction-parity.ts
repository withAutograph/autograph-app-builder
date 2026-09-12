/* oxlint-disable eslint/no-await-in-loop -- assessment rows retain deterministic requirement order while checking artifacts. */
import { z } from "zod";

export const parityVersion = "self-reproduction-parity/v1" as const;
export const sides = ["reference", "candidate"] as const;
export const desktopViewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "desktop-wide", width: 1920, height: 1080 },
  { name: "desktop-window", width: 1024, height: 768 },
] as const;
export const captureStates = ["panel-resize", "keyboard", "loading", "empty", "error"] as const;

// IDs are the integration boundary. Both adapters must implement the same
// assertions; labels, routes and selectors may differ between applications.
export const workflowMatrix = [
  {
    id: "anonymous-entry",
    seed: "anonymous-empty",
    action: "Enter the fixed brief and continue",
    assertions: ["brief-editable", "continuation-changes-state"],
  },
  {
    id: "authentication",
    seed: "anonymous-draft",
    action: "Sign in, sign out, then try another user's draft",
    assertions: ["sign-in-restores-draft", "sign-out-revokes-access", "other-user-denied"],
  },
  {
    id: "durable-draft",
    seed: "owner-empty",
    action:
      "Edit all draft fields, await server acknowledgement, reopen in a fresh browser context",
    assertions: ["write-acknowledged", "fresh-context-read-matches", "revision-advanced"],
  },
  {
    id: "provider-return-success",
    seed: "owner-draft-provider-pending",
    action: "Complete seeded successful callback through application handler",
    assertions: ["callback-consumed", "draft-preserved", "connection-persisted"],
  },
  {
    id: "provider-return-error",
    seed: "owner-draft-provider-pending",
    action: "Return seeded denial, then replay callback state",
    assertions: ["error-visible", "draft-preserved", "replayed-state-rejected"],
  },
  {
    id: "app-creation",
    seed: "owner-build-ready",
    action: "Submit fixed child brief through this application's creation workflow",
    assertions: [
      "submission-changes-state",
      "durable-job-created",
      "artifact-readable",
      "result-linked",
    ],
  },
  {
    id: "preview-access",
    seed: "owner-created-app",
    action: "Open preview as owner and as unrelated user",
    assertions: ["owner-preview-loads", "other-user-denied", "expired-access-rejected"],
  },
  {
    id: "cancellation",
    seed: "owner-running-job",
    action: "Cancel while operation is pending and reload",
    assertions: ["cancel-acknowledged", "terminal-state-persists", "no-late-success"],
  },
  {
    id: "retry",
    seed: "owner-failed-job",
    action: "Retry once and reload",
    assertions: ["retry-changes-state", "single-continuation", "result-persists"],
  },
  {
    id: "session-recovery",
    seed: "owner-interrupted-job",
    action: "Close context while pending; open new context and resume",
    assertions: ["session-restored", "single-continuation", "result-persists"],
  },
  {
    id: "independent-child",
    seed: "owner-build-ready",
    action: "Create exactly one child via this application; inspect child output and stop",
    assertions: [
      "child-artifact-readable",
      "child-count-one",
      "recursion-depth-one",
      "no-reference-backend",
      "no-reference-source",
    ],
  },
  {
    id: "documentation",
    seed: "anonymous-empty",
    action: "Navigate to public docs and back",
    assertions: ["docs-readable", "return-navigation-works"],
  },
] as const;

export const frameworkMatrix = [
  { id: "server-first", assertions: ["request-data-on-server", "useful-server-shell"] },
  { id: "narrow-client", assertions: ["client-import-graph-reviewed", "interactive-leaves-only"] },
  {
    id: "server-writes",
    assertions: ["server-authorizes-write", "durable-readback", "failure-not-success"],
  },
  {
    id: "auth-cache-isolation",
    assertions: ["two-user-isolation", "sign-out-invalidates", "cache-scope-reviewed"],
  },
  {
    id: "suspense",
    assertions: ["direct-load-fallback-useful", "shared-layout-navigation-fallback-useful"],
  },
  {
    id: "cache-components",
    assertions: ["cache-boundaries-reviewed", "static-shell-observed", "revalidation-observed"],
  },
  {
    id: "partial-prefetching",
    assertions: ["app-shell-prefetch-observed", "url-dependent-content-correct"],
  },
  {
    id: "instant-navigation",
    assertions: ["instant-direct-load", "instant-client-navigation", "resolved-content-visible"],
  },
  {
    id: "navigation-continuity",
    assertions: ["back-forward-preserves-draft", "shared-layout-state-preserved", "focus-restored"],
  },
  {
    id: "pending-optimistic",
    assertions: [
      "pending-visible",
      "duplicate-submit-prevented",
      "failure-rolls-back",
      "confirmed-write-reconciles",
    ],
  },
  { id: "semantic-tokens", assertions: ["arrusted-token-provenance", "palette-unchanged"] },
] as const;

const captureAssertions: Record<(typeof captureStates)[number], string[]> = {
  "panel-resize": ["panel-dimension-changed", "content-remains-reachable"],
  keyboard: ["focus-visible", "keyboard-activation-changes-state"],
  loading: ["pending-held", "useful-loading-visible"],
  empty: ["empty-state-visible", "next-action-works"],
  error: ["error-visible", "recovery-action-works"],
};

export const requirements = [
  ...workflowMatrix.map((row) => ({ ...row, kind: "workflow" as const })),
  ...frameworkMatrix.map((row) => ({ ...row, kind: "framework" as const })),
  ...desktopViewports.flatMap((viewport) =>
    captureStates.map((state) => ({
      id: `capture/${viewport.name}/${state}`,
      kind: "capture" as const,
      assertions: captureAssertions[state],
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
    id: z.string().min(1),
    passed: z.boolean(),
    detail: z.string().min(1),
    artifacts: z.array(artifactPath).min(1),
  })
  .strict();
export const observationSchema = z
  .object({
    requirementId: z.enum(requirements.map((row) => row.id)),
    disposition: z.enum([
      "observed",
      "missing-functionality",
      "infrastructure-unavailable",
      "not-run",
    ]),
    reason: z.string().min(1),
    assertions: z.array(assertionSchema),
    artifacts: z.array(artifactPath),
    method: z.enum([
      "browser",
      "source-review",
      "source-and-browser",
      "@next/playwright/instant",
      "none",
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.assertions.map((item) => item.id)).size !== value.assertions.length)
      ctx.addIssue({ code: "custom", message: "Duplicate assertions" });
  });
export const sideEvidenceSchema = z
  .object({
    output: z.enum(["available", "missing", "infrastructure-unavailable"]),
    reason: z.string().min(1),
    sourceRevision: z.string().min(1),
    observations: z.array(observationSchema),
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
    schemaVersion: z.literal(parityVersion),
    runId: z.string().min(1),
    producer: z.literal("evaluator"),
    fixtureVersion: z.literal(1),
    reference: sideEvidenceSchema,
    candidate: sideEvidenceSchema,
  })
  .strict();
export type ParityEvidence = z.infer<typeof parityEvidenceSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type Status = "passed" | "failed" | "blocked" | "unassessed";

export const parityAssessmentSchema = z
  .object({
    schemaVersion: z.literal(parityVersion),
    runId: z.string(),
    visualScoresAdvisory: z.literal(true),
    rows: z.array(
      z
        .object({
          side: z.enum(sides),
          requirementId: z.enum(requirements.map((row) => row.id)),
          kind: z.enum(["workflow", "framework", "capture"]),
          status: z.enum(["passed", "failed", "blocked", "unassessed"]),
          reason: z.string(),
          artifacts: z.array(artifactPath),
        })
        .strict(),
    ),
  })
  .strict();
export type Assessment = z.infer<typeof parityAssessmentSchema>;

/** artifactExists must verify a nonempty file within the evaluator evidence root. */
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
      let reason = observation?.reason ?? "No evaluator observation supplied.";
      const artifacts = [
        ...new Set([
          ...(observation?.artifacts ?? []),
          ...(observation?.assertions.flatMap((item) => item.artifacts) ?? []),
        ]),
      ];
      if (bundle.output !== "available") {
        status = bundle.output === "missing" ? "failed" : "blocked";
        ({ reason } = bundle);
      } else if (observation?.disposition === "missing-functionality") status = "failed";
      else if (observation?.assertions.some((assertion) => !assertion.passed)) status = "failed";
      else if (observation?.disposition === "infrastructure-unavailable") status = "blocked";
      else if (observation?.disposition === "observed") {
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
        if (complete && retained && screenshot && behavioral && instant) status = "passed";
        else
          reason = `Incomplete evidence: assertions=${complete}, retained=${retained}, capture=${screenshot}, behavioral=${behavioral}, instant=${instant}. ${reason}`;
      }
      rows.push({
        side,
        requirementId: requirement.id,
        kind: requirement.kind,
        status,
        reason,
        artifacts,
      });
    }
  }
  return { schemaVersion: parityVersion, runId: evidence.runId, visualScoresAdvisory: true, rows };
}
