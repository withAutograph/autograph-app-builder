import { applicationSourceImportState } from "@/lib/agent/application-source-import-state";
import { emitCurrentBuildWorkflowProjection } from "@/lib/agent/approved-build-continuation-runtime";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appSpecRepairDiagnostic,
  normalizeBuildReadyAppSpec,
  validateBuildReadyAppSpec,
} from "@/lib/agent/app-spec-validation";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  sha256,
  updateExactWorkflow,
  validAppId,
} from "@/lib/agent/workflow-state";
import { planAcceptedAppSpec as continueAcceptedAppSpec } from "@/lib/agent/accepted-spec-planning";
import { existingAppChangesSchema } from "@/lib/agent/existing-app-changes";
import type { ExistingAppChange } from "@/lib/agent/existing-app-changes";

import { prepareAppCreation } from "@/lib/agent/prepare-app-creation";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import type { AcceptedAppSpec } from "@/lib/agent/workflow-state";
import { inspectCanonicalAppSpec } from "@/lib/agent/accepted-app-spec-stream";
import { isPrototypeArtifactV2 } from "@/lib/agent/prototype-artifacts";
import { createHostedPrototypeChunkStore } from "@/lib/agent/hosted-prototype-chunk-store";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";

const acceptanceResult = (appSpec: AcceptedAppSpec, reused: boolean) => {
  const state = appBuilderWorkflowState.get();
  const upgrade = "proposal" in state ? state.proposal.target?.frameworkUpgrade : undefined;
  const accepted = { ...appSpec };
  const withUpgrade =
    upgrade === undefined
      ? accepted
      : {
          ...accepted,
          frameworkUpgradePlan: {
            scope: upgrade.scope,
            sharedPaths: ["package.json", "bun.lock"],
            versions: upgrade.versions,
          },
        };
  return {
    ...withUpgrade,
    productAcceptance: productAcceptanceObligations(appSpec),
    reused,
  };
};

/**
 * Planning is the deterministic continuation of a successfully accepted
 * design.  Keeping it here prevents a live model turn from becoming a
 * required orchestration hop between a complete design and its plan.
 */
const planAcceptedAppSpec = async (
  ctx: Parameters<typeof prepareAppCreation>[1],
  existingAppChanges?: ExistingAppChange[],
  frameworkUpgrade?: "latest",
) => {
  let latest = appBuilderWorkflowState.get();
  if (
    frameworkUpgrade === "latest" &&
    "appSpec" in latest &&
    (!("proposal" in latest) || latest.proposal.target?.frameworkUpgrade === undefined)
  ) {
    assertUpstreamMutationAllowed(latest, "framework upgrade planning");
    const current = latest;
    updateExactWorkflow({
      expected: current,
      operation: "framework upgrade planning",
      transition: () => {
        const prepared = {
          appSpec: { ...current.appSpec, frameworkUpgrade: "latest" as const },
          artifacts: current.artifacts,
        };
        const withSource =
          current.githubSource === undefined
            ? prepared
            : { ...prepared, githubSource: current.githubSource };
        return {
          ...withSource,
          phase: "app_spec_accepted",
          preparedByCallId: current.preparedByCallId,
          sourceReceipt: current.sourceReceipt,
          version: APP_BUILDER_WORKFLOW_VERSION,
          workspace: current.workspace,
        };
      },
    });
    latest = appBuilderWorkflowState.get();
  }
  await continueAcceptedAppSpec({
    phase: latest.phase,
    plan: async () => {
      await prepareAppCreation(
        {
          existingAppChanges,
          frameworkUpgrade:
            frameworkUpgrade ?? ("appSpec" in latest ? latest.appSpec.frameworkUpgrade : undefined),
        },
        ctx,
      );
    },
    planComplete: "proposal" in latest && existingAppChanges === undefined,
  });
};

export default defineTool({
  description:
    "Silently accept the current AppSpec artifact with explicit build-ready intent and continue planning. Before authoring it, read design-app references/app-spec.md for product coverage guidance; section names, order, and Markdown formatting are advisory. Preserve the user's actual requirements and declare readiness with JSON status build-ready only when the product intent is ready; a later draft status keeps planning open. For an existing app, include existingAppChanges with complete replacement contents for each app-owned file to change; if recording the AppSpec said planning needs changes, call this tool with the accepted artifact and those changes before requesting build approval. No new approval receipt is required. This does not publish or change an external repository.",
  // oxlint-disable-next-line eslint/complexity -- Preserve the accepted-spec resume protocol while forwarding explicit repair intent.
  async execute(
    {
      appId,
      expectedArtifactDigest,
      expectedArtifactRevision,
      existingAppChanges,
      frameworkUpgrade,
    },
    ctx,
  ) {
    const imported = applicationSourceImportState.get();
    if (
      imported !== undefined &&
      (imported.reference.appId !== appId || imported.importedSessionId !== ctx.session.id)
    ) {
      throw new Error("Preserve the imported application identity in this session.");
    }
    if (!validAppId(appId)) {
      throw new Error("App id must be one lowercase kebab-case segment.");
    }
    const current = appBuilderWorkflowState.get();
    if (current.phase === "empty") {
      throw new Error("Start a workspace before creating an implementation plan.");
    }
    const path = `prototype/${appId}/app-spec.md`;
    const matchesExpectedArtifact = (candidate: (typeof current.artifacts)[number]) =>
      (expectedArtifactDigest === undefined || candidate.digest === expectedArtifactDigest) &&
      (expectedArtifactRevision === undefined || candidate.revision === expectedArtifactRevision);
    const artifact = current.artifacts.find(
      (candidate) =>
        candidate.path === path &&
        candidate.sessionId === ctx.session.id &&
        matchesExpectedArtifact(candidate),
    );
    if (artifact === undefined) {
      throw new Error("Create a product design before creating its implementation plan.");
    }
    if (artifact.mediaType !== "text/markdown" || artifact.transfer !== undefined) {
      throw new Error("The accepted AppSpec artifact media type is invalid.");
    }
    // A resumed acceptance is bound to the recorded artifact revision. New
    // draft recording must not rewrite an already accepted snapshot or
    // invalidate its preparation, apply, validation, or publication receipts.
    if (
      "appSpec" in current &&
      current.appSpec.appId === appId &&
      current.appSpec.artifactPath === artifact.path &&
      current.appSpec.artifactRevision === artifact.revision
    ) {
      await planAcceptedAppSpec(ctx, existingAppChanges, frameworkUpgrade);
      await emitCurrentBuildWorkflowProjection(ctx);
      return acceptanceResult(current.appSpec, true);
    }
    let content: string | undefined;
    let digest: string;
    let walkthrough: string | undefined;
    if (isPrototypeArtifactV2(artifact)) {
      const store = createHostedPrototypeChunkStore({
        db: openHostedPostgresDatabase(process.env.DATABASE_URL ?? ""),
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      const inspection = await inspectCanonicalAppSpec({
        artifact,
        readChunk: async (chunkIndex) =>
          await store.get({
            chunkIndex,
            path: artifact.path,
            transferDigest: artifact.digest,
          }),
      });
      ({ digest, walkthrough } = inspection);
    } else {
      content = normalizeBuildReadyAppSpec(artifact.content);
      const validation = validateBuildReadyAppSpec(content);
      if (!validation.valid) {
        throw new Error(appSpecRepairDiagnostic(validation));
      }
      digest = sha256(content);
    }
    const acceptedBy = { acceptedByCallId: ctx.callId };
    const upgraded =
      frameworkUpgrade === undefined ? acceptedBy : { ...acceptedBy, frameworkUpgrade };
    const artifactInfo = {
      ...upgraded,
      appId,
      artifactPath: artifact.path,
      artifactRevision: artifact.revision,
    };
    const specContent =
      content === undefined
        ? { ...artifactInfo, version: 2 as const, walkthrough }
        : { ...artifactInfo, content };
    const digested = { ...specContent, digest };
    const accepted: AcceptedAppSpec =
      current.phase === "ui_accepted"
        ? { ...digested, uiRevision: current.uiPreview.revision }
        : digested;
    if (
      "appSpec" in current &&
      current.appSpec.digest === accepted.digest &&
      current.appSpec.appId === accepted.appId
    ) {
      await planAcceptedAppSpec(ctx, existingAppChanges, frameworkUpgrade);
      await emitCurrentBuildWorkflowProjection(ctx);
      return acceptanceResult(current.appSpec, true);
    }
    updateExactWorkflow({
      expected: current,
      operation: "AppSpec acceptance",
      transition: () => {
        const prepared = { appSpec: accepted, artifacts: current.artifacts };
        const withSource =
          current.githubSource === undefined
            ? prepared
            : { ...prepared, githubSource: current.githubSource };
        return {
          ...withSource,
          phase: "app_spec_accepted",
          preparedByCallId: current.preparedByCallId,
          sourceReceipt: current.sourceReceipt,
          version: APP_BUILDER_WORKFLOW_VERSION,
          workspace: current.workspace,
        };
      },
    });
    await planAcceptedAppSpec(ctx, existingAppChanges, frameworkUpgrade);
    await emitCurrentBuildWorkflowProjection(ctx);
    return acceptanceResult(accepted, false);
  },
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    existingAppChanges: existingAppChangesSchema.optional(),
    expectedArtifactDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedArtifactRevision: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    frameworkUpgrade: z
      .literal("latest")
      .optional()
      .describe(
        "Upgrade this existing app to the latest stable Next.js and React versions; new apps select current stable versions automatically. Shared catalog and lockfile updates are included in the reviewed change set.",
      ),
  }),
});
