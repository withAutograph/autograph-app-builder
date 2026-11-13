/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
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
import {
  appAccessIntentSchema,
  resolveAppAccessIntent,
  sameAppAccessIntent,
} from "@/lib/agent/app-access-intent";
import type { ExistingAppChange } from "@/lib/agent/existing-app-changes";
import { optionalTextFieldSchema } from "@/lib/repository/optional-text-field";
import type { OptionalTextField } from "@/lib/repository/optional-text-field";

import { prepareAppCreation } from "@/lib/agent/prepare-app-creation";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { implementationRouteContext } from "@/lib/agent/implementation-route-context";
import type { AcceptedAppSpec } from "@/lib/agent/workflow-state";
import { inspectCanonicalAppSpec } from "@/lib/agent/accepted-app-spec-stream";
import { isPrototypeArtifactV2 } from "@/lib/agent/prototype-artifacts";
import { createHostedPrototypeChunkStore } from "@/lib/agent/hosted-prototype-chunk-store";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";

const acceptanceResult = (appSpec: AcceptedAppSpec, reused: boolean) => {
  const state = appBuilderWorkflowState.get();
  const upgrade = "proposal" in state ? state.proposal.target?.frameworkUpgrade : undefined;
  const result: AcceptedAppSpec & {
    frameworkUpgradePlan?: {
      scope: NonNullable<typeof upgrade>["scope"];
      versions: NonNullable<typeof upgrade>["versions"];
      sharedPaths: string[];
    };
  } = { ...appSpec };
  if (upgrade !== undefined) {
    result.frameworkUpgradePlan = {
      scope: upgrade.scope,
      versions: upgrade.versions,
      sharedPaths: ["package.json", "bun.lock"],
    };
  }
  return {
    ...result,
    productAcceptance: productAcceptanceObligations(appSpec),
    ...implementationRouteContext("proposal" in state ? state.proposal.target?.plan : undefined),
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
  optionalTextField?: OptionalTextField,
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
        type AcceptedState = Extract<
          ReturnType<typeof appBuilderWorkflowState.get>,
          { phase: "app_spec_accepted" }
        >;
        const accepted = {
          appSpec: { ...current.appSpec, frameworkUpgrade: "latest" as const },
          artifacts: current.artifacts,
        };
        const source: Pick<AcceptedState, "githubSource"> = {};
        if (current.githubSource !== undefined) {
          source.githubSource = current.githubSource;
        }
        return {
          ...accepted,
          ...source,
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
          optionalTextField,
          frameworkUpgrade:
            frameworkUpgrade ?? ("appSpec" in latest ? latest.appSpec.frameworkUpgrade : undefined),
        },
        ctx,
      );
    },
    planComplete:
      "proposal" in latest && existingAppChanges === undefined && optionalTextField === undefined,
  });
};

export default defineTool({
  description:
    "Silently accept the current AppSpec artifact with explicit build-ready intent and continue planning. Before authoring it, read design-app references/app-spec.md for product coverage guidance; section names, order, and Markdown formatting are advisory. Preserve the user's actual requirements and declare readiness with JSON status build-ready only when the product intent is ready; a later draft status keeps planning open. For an existing app, include existingAppChanges with complete replacement contents for each app-owned file to change. When adding one optional text field to an existing generated app, pass optionalTextField with its modelId, fieldId, label and any existing changeTypeIds that must write it; Builder preserves existing CUE and authors the change before Build approval. Omit the CUE file from existingAppChanges when using optionalTextField. If recording the AppSpec said planning needs changes, call this tool with the accepted artifact and those changes before requesting build approval. No new approval receipt is required. This does not publish or change an external repository.",
  // oxlint-disable-next-line eslint/complexity -- Preserve the accepted-spec resume protocol while forwarding explicit repair intent.
  async execute(
    {
      appId,
      expectedArtifactDigest,
      expectedArtifactRevision,
      existingAppChanges,
      optionalTextField,
      frameworkUpgrade,
      access,
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
    const selectedAccess = resolveAppAccessIntent(
      access,
      "appSpec" in current && current.appSpec.appId === appId ? current.appSpec.access : undefined,
    );
    const path = `prototype/${appId}/app-spec.md`;
    const artifact = current.artifacts.find((candidate) => {
      if (candidate.path !== path || candidate.sessionId !== ctx.session.id) {
        return false;
      }
      return (
        (expectedArtifactDigest === undefined || candidate.digest === expectedArtifactDigest) &&
        (expectedArtifactRevision === undefined || candidate.revision === expectedArtifactRevision)
      );
    });
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
      // oxlint-disable-next-line sonarjs/expression-complexity -- Retained artifact identity and access authority must both match before resuming.
      "appSpec" in current &&
      current.appSpec.appId === appId &&
      current.appSpec.artifactPath === artifact.path &&
      current.appSpec.artifactRevision === artifact.revision &&
      sameAppAccessIntent(current.appSpec.access, selectedAccess)
    ) {
      await planAcceptedAppSpec(ctx, existingAppChanges, frameworkUpgrade, optionalTextField);
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
    const acceptance: Pick<AcceptedAppSpec, "acceptedByCallId" | "frameworkUpgrade" | "access"> = {
      acceptedByCallId: ctx.callId,
    };
    if (selectedAccess !== undefined) {
      acceptance.access = selectedAccess;
    }
    if (frameworkUpgrade !== undefined) {
      acceptance.frameworkUpgrade = frameworkUpgrade;
    }
    const artifactIdentity = {
      ...acceptance,
      appId,
      artifactPath: artifact.path,
      artifactRevision: artifact.revision,
    };
    const contentFields: Pick<AcceptedAppSpec, "version" | "walkthrough" | "content"> =
      content === undefined ? { version: 2, walkthrough } : { content };
    const accepted: AcceptedAppSpec = { ...artifactIdentity, ...contentFields, digest };
    if (current.phase === "ui_accepted") {
      accepted.uiRevision = current.uiPreview.revision;
    }
    if (
      "appSpec" in current &&
      current.appSpec.digest === accepted.digest &&
      current.appSpec.appId === accepted.appId &&
      sameAppAccessIntent(current.appSpec.access, accepted.access)
    ) {
      await planAcceptedAppSpec(ctx, existingAppChanges, frameworkUpgrade, optionalTextField);
      await emitCurrentBuildWorkflowProjection(ctx);
      return acceptanceResult(current.appSpec, true);
    }
    updateExactWorkflow({
      expected: current,
      operation: "AppSpec acceptance",
      transition: () => {
        type AcceptedState = Extract<
          ReturnType<typeof appBuilderWorkflowState.get>,
          { phase: "app_spec_accepted" }
        >;
        const app = { appSpec: accepted, artifacts: current.artifacts };
        const source: Pick<AcceptedState, "githubSource"> = {};
        if (current.githubSource !== undefined) {
          source.githubSource = current.githubSource;
        }
        return {
          ...app,
          ...source,
          phase: "app_spec_accepted",
          preparedByCallId: current.preparedByCallId,
          sourceReceipt: current.sourceReceipt,
          version: APP_BUILDER_WORKFLOW_VERSION,
          workspace: current.workspace,
        };
      },
    });
    await planAcceptedAppSpec(ctx, existingAppChanges, frameworkUpgrade, optionalTextField);
    await emitCurrentBuildWorkflowProjection(ctx);
    return acceptanceResult(accepted, false);
  },
  inputSchema: z.strictObject({
    appId: z.string().min(1),
    access: appAccessIntentSchema
      .optional()
      .describe(
        "Record the app brief's access choice. Omit for private creator/invitation access on new apps or to retain an existing choice on revision. Self-signup must name only the app's intended nonprivileged roles; the Production operator validates them and separately obtains approval. This does not grant access or publish anything.",
      ),
    frameworkUpgrade: z
      .literal("latest")
      .optional()
      .describe(
        "Upgrade this existing app to the latest stable Next.js and React versions; new apps select current stable versions automatically. Shared catalog and lockfile updates are included in the reviewed change set.",
      ),
    existingAppChanges: existingAppChangesSchema.optional(),
    optionalTextField: optionalTextFieldSchema.optional(),
    expectedArtifactDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    expectedArtifactRevision: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  }),
});
