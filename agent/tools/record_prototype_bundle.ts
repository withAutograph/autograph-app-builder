import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  exactPrototypeArtifact,
  prototypeArtifactReceipt,
  recordPrototypeArtifactBundle,
} from "@/lib/agent/prototype-artifacts";
import { developmentPrototypeBundle } from "@/lib/agent/development-prototype";
import { existingAppChangesSchema } from "@/lib/agent/existing-app-changes";
import { sourceWorkflowState } from "@/lib/agent/source-state";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  updateExactWorkflow,
  validAppId,
} from "@/lib/agent/workflow-state";
import acceptAppSpec from "./accept_app_spec";
import prepareWorkspace from "./prepare_workspace";
import sourceStatus from "./source_status";

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
        itemLabels: z.array(z.string().min(1).max(80)).min(1).optional(),
        filters: z.array(z.string().min(1).max(80)).min(1).optional(),
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
          .optional(),
        primaryAction: z.string().min(1).max(80).optional(),
        states: z.array(z.string().min(1).max(80)).min(1).optional(),
      })
      .strict()
      .optional(),
    existingAppChanges: existingAppChangesSchema.optional(),
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
  description:
    "Record one complete, usable prototype bundle and continue silently through implementation planning in one operation. For products that naturally fit a queue, dashboard, or form, provide appId, a concise brief, and optional product choices (productName, interfacePattern, outcome, itemLabels, filters, keyFacts, primaryAction, states); the builder expands them into a Browser prototype and complete internal design. For any other product shape, provide the complete authored indexHtml, decisionsMarkdown, and appSpecMarkdown instead of forcing it into those patterns. For an existing app, include the inspected app-owned change set in existingAppChanges. Empty workflows automatically resolve and prepare the eligible source before recording. Never expose internal preparation, validation, or receipt mechanics, and never write the target repository.",
  inputSchema: bundleInputSchema,
  async execute(input, ctx) {
    const { appId } = input;
    if (!validAppId(appId))
      throw new Error("App id must be one lowercase kebab-case segment.");
    let current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "prototype bundle recording");
    if (current.phase === "empty") {
      await sourceStatus.execute({}, ctx);
      const source = sourceWorkflowState.get();
      if (source.phase === "empty")
        throw new Error("The supported builder source is unavailable.");
      await prepareWorkspace.execute(
        { expectedSourceReceiptDigest: source.receipt.digest },
        ctx,
      );
      current = appBuilderWorkflowState.get();
    }
    if (current.phase === "empty")
      throw new Error("The builder workspace could not be prepared.");
    if (current.phase === "ui_previewed" || current.phase === "ui_accepted")
      throw new Error(
        "This session is using component-backed UI review; revise or finalize that UI instead of recording an HTML bundle.",
      );
    if (current.phase === "validation_pending")
      throw new Error(
        `Target validation attempt ${current.validationAttempt.digest} is pending; artifact mutation is disabled until it is recovered.`,
      );
    const compactBundle =
      input.brief === undefined
        ? undefined
        : developmentPrototypeBundle({
            appId,
            brief: input.brief,
            ...(input.productName === undefined
              ? {}
              : { productName: input.productName }),
            ...(input.interfacePattern === undefined
              ? {}
              : { interfacePattern: input.interfacePattern }),
            ...(input.product === undefined ? {} : { product: input.product }),
          });
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
        ...(input.existingAppChanges === undefined
          ? {}
          : { existingAppChanges: input.existingAppChanges }),
      },
      ctx,
    );
    const planned = appBuilderWorkflowState.get();
    if (planned.phase !== "planned")
      throw new Error("The implementation plan was not completed.");
    const prototype = exactPrototypeArtifact(recorded.artifacts, {
      path: `prototype/${appId}/index.html`,
      digest: recorded.artifacts.find(
        ({ path }) => path === `prototype/${appId}/index.html`,
      )!.digest,
      sessionId: ctx.session.id,
    });
    return {
      appId,
      artifacts: recorded.artifacts.map(prototypeArtifactReceipt),
      prototype: {
        path: prototype.path,
        mediaType: prototype.mediaType,
        content: prototype.content,
        digest: prototype.digest,
        revision: prototype.revision,
      },
      implementationPlan: {
        appId: planned.proposal.target.contract.appId,
        runtime: planned.proposal.target.plan.source.runtime,
        workspacePath: planned.proposal.target.plan.source.workspacePath,
        packageName: planned.proposal.target.plan.source.packageName,
        projectName: planned.proposal.target.plan.topology.projectName,
        routes: planned.proposal.target.plan.topology.routes,
        sourceSha: planned.workspace.sourceSha,
        sourceTree: planned.workspace.sourceTree,
        proposalDigest: planned.proposal.digest,
        readOnly: true,
      },
      reused: recorded.reused,
      implementationPlanReady: true,
    };
  },
});
