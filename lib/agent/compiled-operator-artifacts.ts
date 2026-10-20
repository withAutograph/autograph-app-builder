import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SandboxSession } from "eve/sandbox";
import { appBuilderWorkflowState } from "./workflow-state";
import { assertApprovedPrivateApplySession } from "./private-apply-authority";
import {
  createLocalOperatorArtifactStorage,
  readLocalOperatorArtifactAuthority,
} from "../provisioning/local-operator-artifact-store";
import {
  draftReconciliationState,
  assertRetainedDraftReconciliationCompletion,
} from "./draft-reconciliation-state";
import type {
  DraftReconciliationCompletion,
  ReconciliationCompilation,
} from "./draft-reconciliation-state";
import type { PrivateApplyScope } from "./private-apply-authority";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import {
  createPostgresOperatorArtifactStore,
  operatorArtifactUnavailable,
} from "../provisioning/hosted-operator-artifact-store";
import type { OperatorArtifactContext } from "../provisioning/hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "../provisioning/hosted-operator-artifacts";
import type { OperatorArtifactPublicationDiagnostic } from "../provisioning/hosted-operator-artifacts";
import {
  createPostgresOperatorArtifactSelections,
  readExactCompiledOperatorRelease,
  publishedAppSourceSchema,
} from "../provisioning/hosted-operator-artifact-selection";
import type {
  CompiledOperatorReleaseSelection,
  ExactCompiledOperatorReleaseLookup,
  PublishedAppSource,
  PublishedAppSourceLookup,
} from "../provisioning/hosted-operator-artifact-selection";
import { describeSelectedApp } from "../repository/app-description";
import type { AppDescription } from "../repository/app-description";

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

export interface CompiledOperatorArtifactSessionInput {
  appId: string;
  appSpecDigest: string;
  root: string;
  callId: string;
  sessionAuth: unknown;
  adapterSessionId: string;
  signal?: AbortSignal;
}

const resolveCompiledArtifactSession = async (
  input: CompiledOperatorArtifactSessionInput,
  completion?: DraftReconciliationCompletion,
) => {
  const assertCompilation = () => {
    if (completion === undefined) {
      assertApprovedCompilation(input);
    } else {
      assertRetainedDraftReconciliationCompletion(completion);
      if (
        input.appId !== completion.appId ||
        input.appSpecDigest !== completion.appReview.appSpecDigest
      ) {
        throw operatorArtifactUnavailable();
      }
    }
  };
  assertCompilation();
  const localAuthority = await readLocalOperatorArtifactAuthority();
  let context: OperatorArtifactContext;
  let privateApplyScope: PrivateApplyScope | undefined;
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
      assertCompilation();
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
    if (completion === undefined) {
      const state = appBuilderWorkflowState.get();
      if (!("applyReceipt" in state)) {
        throw operatorArtifactUnavailable();
      }
      privateApplyScope = {
        appId: input.appId,
        appSpecDigest: input.appSpecDigest,
        proposalDigest: state.proposal.digest,
        sessionId: input.adapterSessionId,
        workspaceId: state.workspace.workspaceId,
      };
    } else {
      privateApplyScope = completion.compilation.privateApplyScope;
    }
    assertCurrentOwner = async (current) => {
      assertCompilation();
      if (privateApplyScope === undefined) {
        throw operatorArtifactUnavailable();
      }
      if (completion === undefined) {
        const currentState = appBuilderWorkflowState.get();
        if (!("applyReceipt" in currentState)) {
          throw operatorArtifactUnavailable();
        }
        const currentScope: PrivateApplyScope = {
          appId: input.appId,
          appSpecDigest: input.appSpecDigest,
          proposalDigest: currentState.proposal.digest,
          sessionId: input.adapterSessionId,
          workspaceId: currentState.workspace.workspaceId,
        };
        assertApprovedPrivateApplySession(currentScope);
        if (!isDeepStrictEqual(currentScope, privateApplyScope)) {
          throw operatorArtifactUnavailable();
        }
      } else {
        assertApprovedPrivateApplySession(privateApplyScope);
      }
      if (
        JSON.stringify(current) !== JSON.stringify(context) ||
        JSON.stringify(await readLocalOperatorArtifactAuthority()) !==
          JSON.stringify(localAuthority)
      ) {
        throw operatorArtifactUnavailable();
      }
    };
  }
  if (completion !== undefined && !isDeepStrictEqual(context, completion.compilation.context)) {
    throw operatorArtifactUnavailable();
  }
  await assertCurrentOwner(context);
  const captureAuthority = {
    context,
    ...(privateApplyScope === undefined ? {} : { privateApplyScope }),
  };
  return { assertCurrentOwner, context, localAuthority, captureAuthority };
};

const openCompiledArtifactStorage = async (
  binding: Awaited<ReturnType<typeof resolveCompiledArtifactSession>>,
) => {
  const { assertCurrentOwner, localAuthority } = binding;
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
  return storage;
};

/** Associate the verified Git result with the same owned selected release; no Git or deployment effect. */
export const recordPublishedOperatorSourceForSession = async (
  input: CompiledOperatorArtifactSessionInput & {
    publishedSource: PublishedAppSource;
    backendKind?: AppDescription["backend"]["kind"];
  },
): Promise<
  { status: "not-required" } | { status: "recorded"; selection: CompiledOperatorReleaseSelection }
> => {
  if (input.backendKind === "static") {
    return { status: "not-required" };
  }
  const binding = await resolveCompiledArtifactSession(input);
  const storage = await openCompiledArtifactStorage(binding);
  const selected = await storage.selections.read(binding.context, input.appSpecDigest);
  if (selected === undefined) {
    throw operatorArtifactUnavailable();
  }
  await binding.assertCurrentOwner(binding.context);
  const selection = await storage.selections.record(binding.context, input.callId, {
    ...selected,
    publishedSource: input.publishedSource,
  });
  return { selection, status: "recorded" };
};

/** A sealed context records no grant: every completion re-resolves the current authenticated owner. */
export const assertReconciliationCompletionOwnerForSession = async (input: {
  completion: DraftReconciliationCompletion;
  adapterSessionId: string;
  sessionAuth: unknown;
}) => {
  await resolveCompiledArtifactSession(
    {
      ...input,
      appId: input.completion.appId,
      appSpecDigest: input.completion.appReview.appSpecDigest,
      root: input.completion.root,
      callId: input.completion.proposal.digest,
    },
    input.completion,
  );
};

/** Complete only a retained sealed publication, using its original release instead of current selection. */
export const recordPublishedReconciliationSourceForSession = async (input: {
  completion: DraftReconciliationCompletion;
  adapterSessionId: string;
  sessionAuth: unknown;
  publishedSource: PublishedAppSource;
}) => {
  const { completion } = input;
  const binding = await resolveCompiledArtifactSession(
    {
      ...input,
      appId: completion.appId,
      appSpecDigest: completion.appReview.appSpecDigest,
      root: completion.root,
      callId: completion.proposal.digest,
    },
    completion,
  );
  const { release } = completion.compilation;
  if (release.status === "not-required") {
    return { status: "not-required" as const };
  }
  const storage = await openCompiledArtifactStorage(binding);
  const retained = await readExactCompiledOperatorRelease({
    assertCurrentOwner: binding.assertCurrentOwner,
    context: binding.context,
    lookup: {
      artifactRef: release.selection.artifactRef,
      appSpecDigest: release.selection.appSpecDigest,
    },
    selections: storage.selections,
    store: storage.store,
  });
  if (retained === undefined) {
    throw operatorArtifactUnavailable();
  }
  // readExact's reference lookup alone does not compare the complete sealed release identity.
  const identity = { ...retained.selection };
  delete identity.publishedSource;
  if (!isDeepStrictEqual(identity, release.selection)) {
    throw operatorArtifactUnavailable();
  }
  await binding.assertCurrentOwner(binding.context);
  const selection = await storage.selections.record(
    binding.context,
    `draft-reconciliation:${completion.proposal.digest}`,
    {
      ...release.selection,
      publishedSource: input.publishedSource,
    },
  );
  return { selection, status: "recorded" as const };
};

/** Recover only a verified historical publication under this current app and original owner session. */
export const readPublishedOperatorSourceForSession = async (
  input: CompiledOperatorArtifactSessionInput & { lookup: PublishedAppSourceLookup },
): Promise<PublishedAppSource | undefined> => {
  input.signal?.throwIfAborted();
  const binding = await resolveCompiledArtifactSession(input);
  const storage = await openCompiledArtifactStorage(binding);
  await binding.assertCurrentOwner(binding.context);
  const source = await storage.selections.readPublishedSource?.(binding.context, input.lookup);
  await binding.assertCurrentOwner(binding.context);
  input.signal?.throwIfAborted();
  if (source === undefined) {
    return undefined;
  }
  const parsed = publishedAppSourceSchema.safeParse(source);
  if (!parsed.success) {
    return undefined;
  }
  const matched = [
    parsed.data.repositoryId === input.lookup.repositoryId,
    parsed.data.branch === input.lookup.branch,
    parsed.data.gitSha === input.lookup.gitSha,
    parsed.data.gitTree === input.lookup.gitTree,
  ].every(Boolean);
  return matched ? parsed.data : undefined;
};

/** Read only the exact retained release named by actual installed identity or a saved owned reference. */
export const readExactCompiledOperatorReleaseForSession = async (
  input: CompiledOperatorArtifactSessionInput & { lookup: ExactCompiledOperatorReleaseLookup },
) => {
  const binding = await resolveCompiledArtifactSession(input);
  const storage = await openCompiledArtifactStorage(binding);
  return await readExactCompiledOperatorRelease({
    assertCurrentOwner: binding.assertCurrentOwner,
    context: binding.context,
    lookup: input.lookup,
    selections: storage.selections,
    store: storage.store,
  });
};

/** Closed workflow hook. Public tool input cannot provide SQL, release paths, hashes or owner facts. */
export const publishCompiledOperatorArtifactsForSession = async (
  input: CompiledOperatorArtifactSessionInput & {
    sandbox: Pick<SandboxSession, "run" | "readBinaryFile">;
    onCaptured?: (
      captured: Pick<
        CompiledOperatorReleaseSelection,
        "artifactRef" | "releaseId" | "manifestSha256" | "schemaSha256"
      >,
    ) => Promise<void>;
  },
) => {
  const wrapperStages = ["authority", "description", "storage", "captured", "selection"] as const;
  type Diagnostic = Omit<OperatorArtifactPublicationDiagnostic, "stage"> & {
    stage: OperatorArtifactPublicationDiagnostic["stage"] | (typeof wrapperStages)[number];
  };
  let stage: Diagnostic["stage"] = "authority";
  const observe = (diagnostic: Diagnostic) => {
    ({ stage } = diagnostic);
    try {
      console.info(
        JSON.stringify({
          callId: input.callId,
          event: "app_builder.compiled_artifact_progress",
          ...diagnostic,
        }),
      );
    } catch {
      // Best-effort progress cannot change capture or selection.
    }
  };
  const checkStopped = () => {
    if (input.signal?.aborted === true) {
      throw operatorArtifactUnavailable();
    }
  };
  try {
    checkStopped();
    observe({ outcome: "started", stage: "authority" });
    const relativeRoot = compiledArtifactSandboxRelativePath(input.root);
    const binding = await resolveCompiledArtifactSession(input);
    const { assertCurrentOwner, context } = binding;
    checkStopped();
    observe({ outcome: "completed", stage: "authority" });
    observe({ outcome: "started", stage: "description" });
    const description = await describeSelectedApp({
      appId: input.appId,
      root: input.root,
      sandbox: input.sandbox,
      signal: input.signal,
    });
    await assertCurrentOwner(context);
    checkStopped();
    observe({ outcome: "completed", stage: "description" });
    if (description.backend.kind === "static") {
      return {
        status: "not-required" as const,
        compilation: {
          ...binding.captureAuthority,
          release: { status: "not-required" as const },
        } satisfies ReconciliationCompilation,
      };
    }
    observe({ outcome: "started", stage: "storage" });
    const storage = await openCompiledArtifactStorage(binding);
    checkStopped();
    observe({ outcome: "completed", stage: "storage" });
    const publication = createOperatorArtifactPublication({
      assertCurrentOwner,
      observe,
      signal: input.signal,
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
    checkStopped();
    observe({ outcome: "started", stage: "captured" });
    checkStopped();
    await input.onCaptured?.(captured);
    checkStopped();
    observe({ outcome: "completed", stage: "captured" });
    observe({ outcome: "started", stage: "selection" });
    checkStopped();
    const selection = await storage.selections.record(context, input.callId, {
      ...captured,
      appId: input.appId,
      appSpecDigest: input.appSpecDigest,
      version: 1,
    });
    checkStopped();
    observe({ outcome: "completed", stage: "selection" });
    return {
      selection,
      status: "published" as const,
      compilation: {
        ...binding.captureAuthority,
        release: { status: "published" as const, selection },
      } satisfies ReconciliationCompilation,
    };
  } catch (error) {
    observe({ outcome: input.signal?.aborted === true ? "cancelled" : "failed", stage });
    throw error;
  }
};
