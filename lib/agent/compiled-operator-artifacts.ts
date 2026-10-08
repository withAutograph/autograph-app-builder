import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { appBuilderWorkflowState } from "./workflow-state";
import { assertApprovedPrivateApplySession } from "./private-apply-authority";
import {
  createLocalOperatorArtifactStorage,
  readLocalOperatorArtifactAuthority,
} from "../provisioning/local-operator-artifact-store";
import { draftReconciliationState } from "./draft-reconciliation-state";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import {
  createPostgresOperatorArtifactStore,
  operatorArtifactUnavailable,
} from "../provisioning/hosted-operator-artifact-store";
import type { OperatorArtifactContext } from "../provisioning/hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "../provisioning/hosted-operator-artifacts";
import { createPostgresOperatorArtifactSelections } from "../provisioning/hosted-operator-artifact-selection";
import { describeSelectedApp } from "../repository/app-description";

/** Validates an internal approved root before adapting the fixed repository-relative capture API. */
export const compiledArtifactSandboxRelativePath = (root: string): string => {
  if (
    root.includes("\\") ||
    root.includes("\0") ||
    path.posix.normalize(root) !== root ||
    !root.startsWith("/workspace/")
  ) {
    throw operatorArtifactUnavailable();
  }
  const relative = root.slice("/workspace/".length);
  if (relative.length === 0) {
    throw operatorArtifactUnavailable();
  }
  return relative;
};
const assertApprovedCompilation = (input: {
  appId: string;
  appSpecDigest: string;
  root: string;
}) => {
  const state = appBuilderWorkflowState.get();
  if (
    !("applyReceipt" in state) ||
    state.appSpec.appId !== input.appId ||
    state.appSpec.digest !== input.appSpecDigest
  ) {
    throw operatorArtifactUnavailable();
  }
  if (state.applyReceipt.applyRoot === input.root) {
    return;
  }
  const candidate = draftReconciliationState.get();
  if (state.phase !== "reviewed" || candidate === null) {
    throw operatorArtifactUnavailable();
  }
  const wrongCandidate = candidate.root !== input.root || candidate.appId !== input.appId;
  const wrongReview =
    candidate.githubSourceDigest !== state.githubSource?.digest ||
    candidate.originalReviewDigest !== state.reviewReceipt.digest;
  if (wrongCandidate || wrongReview) {
    throw operatorArtifactUnavailable();
  }
};
const openArtifactDatabase = async () => {
  const [{ readPreviewOAuthRuntimeConfig }, { openHostedPostgresDatabase }] = await Promise.all([
    import("../auth/preview-oauth-runtime"),
    import("../mcp/hosted-route"),
  ]);
  const config = readPreviewOAuthRuntimeConfig({ ...process.env });
  return openHostedPostgresDatabase(config.databaseUrl);
};
let database: ReturnType<typeof openArtifactDatabase> | null = null;

/** Closed workflow hook. Public tool input cannot provide SQL, release paths, hashes or owner facts. */
export const publishCompiledOperatorArtifactsForSession = async (input: {
  appId: string;
  appSpecDigest: string;
  root: string;
  callId: string;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The exact forwarded authority parser owns Eve's unknown auth boundary.
  sessionAuth: unknown;
  adapterSessionId: string;
  sandbox: Pick<SandboxSession, "run" | "readBinaryFile">;
  signal?: AbortSignal;
}) => {
  assertApprovedCompilation(input);
  const relativeRoot = compiledArtifactSandboxRelativePath(input.root);
  const localAuthority = await readLocalOperatorArtifactAuthority();
  let context: OperatorArtifactContext;
  let assertCurrentOwner: (current: OperatorArtifactContext) => Promise<void>;
  if (localAuthority === undefined) {
    const { authority, principal } = exactForwardedSessionAuthority(input.sessionAuth);
    const resolve = async () =>
      await resolveHostedOperatorOwnerContext({
        adapterSessionId: input.adapterSessionId,
        authority,
        environment: process.env,
        principal,
        sessionAuth: input.sessionAuth,
      });
    const owner = await resolve();
    context = {
      authority: owner.authority,
      target: { appId: input.appId, sessionId: owner.sessionId },
    };
    assertCurrentOwner = async (current) => {
      assertApprovedCompilation(input);
      if (
        JSON.stringify(current) !== JSON.stringify(context) ||
        JSON.stringify(await resolve()) !== JSON.stringify(owner)
      ) {
        throw operatorArtifactUnavailable();
      }
    };
  } else {
    context = {
      authority: localAuthority,
      target: { appId: input.appId, sessionId: input.adapterSessionId },
    };
    assertCurrentOwner = async (current) => {
      assertApprovedCompilation(input);
      const state = appBuilderWorkflowState.get();
      if (!("applyReceipt" in state)) {
        throw operatorArtifactUnavailable();
      }
      assertApprovedPrivateApplySession({
        appId: input.appId,
        appSpecDigest: input.appSpecDigest,
        proposalDigest: state.proposal.digest,
        sessionId: input.adapterSessionId,
        workspaceId: state.workspace.workspaceId,
      });
      if (
        JSON.stringify(current) !== JSON.stringify(context) ||
        JSON.stringify(await readLocalOperatorArtifactAuthority()) !==
          JSON.stringify(localAuthority)
      ) {
        throw operatorArtifactUnavailable();
      }
    };
  }
  await assertCurrentOwner(context);
  const description = await describeSelectedApp({
    appId: input.appId,
    root: input.root,
    sandbox: input.sandbox,
    signal: input.signal,
  });
  await assertCurrentOwner(context);
  if (description.backend.kind === "static") {
    return { status: "not-required" as const };
  }
  let storage: Awaited<ReturnType<typeof createLocalOperatorArtifactStorage>>;
  if (localAuthority === undefined) {
    database ??= openArtifactDatabase();
    const pendingDatabase = database;
    let opened: Awaited<typeof pendingDatabase>;
    try {
      opened = await pendingDatabase;
    } catch {
      database = null;
      throw operatorArtifactUnavailable();
    }
    storage = {
      selections: createPostgresOperatorArtifactSelections({
        assertCurrentOwner,
        database: opened,
      }),
      store: createPostgresOperatorArtifactStore({ assertCurrentOwner, database: opened }),
    };
  } else {
    storage = await createLocalOperatorArtifactStorage({
      assertCurrentOwner,
      authority: localAuthority,
    });
  }
  const publication = createOperatorArtifactPublication({
    assertCurrentOwner,
    store: storage.store,
  });
  const captured = await publication.publishGeneratedRelease({
    context,
    description,
    source: {
      readBinaryFile: async (request) => {
        if (!request.path.startsWith("repository/")) {
          throw operatorArtifactUnavailable();
        }
        await assertCurrentOwner(context);
        return await input.sandbox.readBinaryFile({
          ...request,
          abortSignal: input.signal,
          path: `${relativeRoot}/${request.path.slice("repository/".length)}`,
        });
      },
    },
  });
  // Read every completed immutable member before recording a planner-visible selection.
  await publication.readGeneratedRelease(context, captured);
  const selection = await storage.selections.record(context, input.callId, {
    ...captured,
    appId: input.appId,
    appSpecDigest: input.appSpecDigest,
    version: 1,
  });
  return { selection, status: "published" as const };
};
