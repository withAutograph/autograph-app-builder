import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  prototypeArtifactReceipt,
  recordPrototypeArtifactBundle,
} from "@/lib/agent/prototype-artifacts";
import { developmentPrototypeBundle } from "@/lib/agent/development-prototype";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
  validAppId,
} from "@/lib/agent/workflow-state";

import acceptAppSpec from "./accept_app_spec";

const localDevelopment =
  process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development";

const bundleInputSchema = z
  .object({
    appId: z.string().min(1),
    indexHtml: z.string().min(1).max(262_144).optional(),
    decisionsMarkdown: z.string().min(1).max(262_144).optional(),
    appSpecMarkdown: z.string().min(1).max(262_144).optional(),
    brief: z.string().min(1).max(8_000).optional(),
    productName: z.string().min(1).max(120).optional(),
    interfacePattern: z.enum(["queue", "dashboard", "form"]).optional(),
    product: z
      .object({
        outcome: z.string().min(1).max(240).optional(),
        itemLabels: z.array(z.string().min(1).max(80)).min(1).max(3).optional(),
        filters: z.array(z.string().min(1).max(80)).min(1).max(4).optional(),
        keyFacts: z
          .array(
            z
              .object({
                label: z.string().min(1).max(60),
                value: z.string().min(1).max(100),
              })
              .strict(),
          )
          .min(1)
          .max(4)
          .optional(),
        primaryAction: z.string().min(1).max(80).optional(),
        states: z.array(z.string().min(1).max(80)).min(1).max(4).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const authored = [
      input.indexHtml,
      input.decisionsMarkdown,
      input.appSpecMarkdown,
    ];
    if (authored.every((value) => value !== undefined)) return;
    if (
      authored.every((value) => value === undefined) &&
      input.brief !== undefined
    )
      return;
    context.addIssue({
      code: "custom",
      message:
        "Provide either the complete authored bundle or one concise development brief.",
    });
  });

export default defineTool({
  description: localDevelopment
    ? "Local development fast path: provide appId, brief, an optional productName, optional interfacePattern, and optional small product object (outcome, itemLabels, filters, keyFacts, primaryAction, states). This tool deterministically expands those concise product choices into a usable Browser prototype and build-ready internal design, then continues planning. Do not author HTML, decisions, or an internal design payload in local development. It never writes the target repository."
    : "Record one complete, usable new-app prototype bundle and continue silently through implementation planning in one internal operation. Prefer this normal creation path over three record_prototype_artifact calls. Before calling, provide a complete build-ready internal design with each heading exactly once: ## Status and prototype; ## User and outcome; ## Interfaces and navigation; ## Controls and behavior; ## Data model; ## Integrations and reconciliation; ## Temporal semantics; ## Writes, review, and authority; ## Access and tenancy; ## Agent behavior; ## Operational states; ## Defaults, non-goals, and risks; ## Acceptance walkthrough; ## Build handoff. End Build handoff with one closed json block using status build-ready. It never writes the target repository.",
  inputSchema: bundleInputSchema,
  async execute(input, ctx) {
    const { appId } = input;
    if (!validAppId(appId))
      throw new Error("App id must be one lowercase kebab-case segment.");
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "prototype bundle recording");
    if (current.phase === "empty")
      throw new Error(
        "Prepare a workspace before recording a prototype bundle.",
      );
    if (current.phase === "validation_pending")
      throw new Error(
        `Target validation attempt ${current.validationAttempt.digest} is pending; artifact mutation is disabled until it is recovered.`,
      );
    const compactBundle =
      input.brief === undefined
        ? undefined
        : localDevelopment
          ? developmentPrototypeBundle({
              appId,
              brief: input.brief,
              ...(input.productName === undefined
                ? {}
                : { productName: input.productName }),
              ...(input.interfacePattern === undefined
                ? {}
                : { interfacePattern: input.interfacePattern }),
              ...(input.product === undefined
                ? {}
                : { product: input.product }),
            })
          : undefined;
    if (input.brief !== undefined && compactBundle === undefined)
      throw new Error(
        "Concise prototype generation is available only in local development.",
      );
    const recorded = recordPrototypeArtifactBundle({
      artifacts: current.artifacts,
      appId,
      indexHtml: compactBundle?.indexHtml ?? input.indexHtml!,
      decisionsMarkdown:
        compactBundle?.decisionsMarkdown ?? input.decisionsMarkdown!,
      appSpecMarkdown: compactBundle?.appSpecMarkdown ?? input.appSpecMarkdown!,
      sessionId: ctx.session.id,
      callId: ctx.callId,
      expectedAppId:
        current.phase === "app_spec_accepted" ||
        current.phase === "dependencies_prepared" ||
        current.phase === "identity_resolved" ||
        current.phase === "planned" ||
        current.phase === "apply_failed" ||
        current.phase === "applied" ||
        current.phase === "validation_failed" ||
        current.phase === "validated" ||
        current.phase === "reviewed"
          ? current.appSpec.appId
          : undefined,
    });
    if (!recorded.reused)
      updateExactWorkflow({
        expected: current,
        operation: "prototype bundle recording",
        transition: () => ({
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "prepared",
          preparedByCallId: current.preparedByCallId,
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          ...(current.githubSource === undefined
            ? {}
            : { githubSource: current.githubSource }),
          artifacts: recorded.artifacts,
        }),
      });
    await acceptAppSpec.execute(
      {
        appId,
        expectedArtifactDigest: recorded.appSpec.digest,
        expectedArtifactRevision: recorded.appSpec.revision,
        expectedSourceSha: current.workspace.sourceSha,
        expectedSourceTree: current.workspace.sourceTree,
        expectedEligibilityDigest: current.workspace.eligibilityDigest,
        expectedWorkspaceDigest: current.workspace.workspaceDigest,
      },
      ctx,
    );
    return {
      appId,
      artifacts: recorded.artifacts.map(prototypeArtifactReceipt),
      reused: recorded.reused,
      implementationPlanReady: true,
    };
  },
});
