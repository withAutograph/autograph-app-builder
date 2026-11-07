import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import type { HostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { appBuilderWorkflowState } from "./workflow-state";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import { currentDraftCandidateSource } from "./published-draft-repair";
import { assertApprovedPrivateApplySession } from "./private-apply-authority";
import {
  createLocalOperatorArtifactStorage,
  readLocalOperatorArtifactAuthority,
} from "../provisioning/local-operator-artifact-store";
import {
  draftReconciliationState,
  assertRetainedDraftReconciliationCompletion,
  assertRetainedPublishedDraftRepairCompletion,
} from "./draft-reconciliation-state";
import type {
  DraftPublicationCompletion,
  ReconciliationCompilation,
} from "./draft-reconciliation-state";
import type { PrivateApplyScope } from "./private-apply-authority";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";
import {
  createPostgresOperatorArtifactStore,
  operatorArtifactUnavailable,
} from "../provisioning/hosted-operator-artifact-store";
import type { OperatorArtifactContext } from "../provisioning/hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "../provisioning/hosted-operator-artifacts";
import { createCapturedAppDescriptionStore } from "../provisioning/captured-app-description";
import type { CapturedAppDescriptionStore } from "../provisioning/captured-app-description";
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
  const workflow = appBuilderWorkflowState.get();
  const candidate = draftReconciliationState.get();
  const state = resolveDraftReviewedWorkflow(workflow, candidate) ?? workflow;
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
  if (state.phase !== "reviewed" || candidate === null) {
    throw operatorArtifactUnavailable();
  }
  const wrongCandidate = candidate.root !== input.root || candidate.appId !== input.appId;
  const wrongReview =
    currentDraftCandidateSource(state, candidate) === undefined ||
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
  callbackExecution?: HostedOperatorCallbackExecution;
}

const resolveCompiledArtifactSession = async (
  input: CompiledOperatorArtifactSessionInput,
  completion?: DraftPublicationCompletion,
) => {
  const assertCompilation = () => {
    if (completion === undefined) {
      assertApprovedCompilation(input);
    } else {
      if ("kind" in completion) {
        assertRetainedPublishedDraftRepairCompletion(completion);
      } else {
        assertRetainedDraftReconciliationCompletion(completion);
      }
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
        execution: input.callbackExecution,
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
  return { assertCurrentOwner, captureAuthority, context, localAuthority };
};

const openCompiledArtifactStorage = async (
  binding: Awaited<ReturnType<typeof resolveCompiledArtifactSession>>,
) => {
  const { assertCurrentOwner, localAuthority } = binding;
  let storage: Awaited<ReturnType<typeof createLocalOperatorArtifactStorage>> & {
    descriptions?: CapturedAppDescriptionStore;
  };
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
      descriptions: createCapturedAppDescriptionStore({
        assertCurrentOwner,
        database: opened,
      }),
      selections: createPostgresOperatorArtifactSelections({
        assertCurrentOwner,
        database: opened,
      }),
      store: createPostgresOperatorArtifactStore({ assertCurrentOwner, database: opened }),
    };
  } else {
    storage = {
      ...(await createLocalOperatorArtifactStorage({
        assertCurrentOwner,
        authority: localAuthority,
      })),
      descriptions: undefined,
    };
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
  | { status: "not-required" }
  | { status: "recorded"; selection: CompiledOperatorReleaseSelection }
  | { status: "recorded-static"; publishedSource: PublishedAppSource }
> => {
  if (input.backendKind === "static") {
    if (appBuilderWorkflowState.get() === null) {
      return { status: "not-required" };
    }
    const binding = await resolveCompiledArtifactSession(input);
    const storage = await openCompiledArtifactStorage(binding);
    if (storage.descriptions === undefined) {
      return { status: "not-required" };
    }
    const description = await storage.descriptions.read(binding.context, input.appSpecDigest);
    if (description === undefined || description.backend.kind !== "static") {
      throw operatorArtifactUnavailable();
    }
    const source = publishedAppSourceSchema.parse(input.publishedSource);
    const artifactPath = `_protected-operator/static-published-source/${input.appId}/${input.appSpecDigest}`;
    const [{ prototypeArtifactChunks }, { and, eq }, { createHash }, db] = await Promise.all([
      import("../db/schema"),
      import("drizzle-orm"),
      import("node:crypto"),
      openArtifactDatabase(),
    ]);
    const key = {
      ...hostedTenantAuthoritySchema.parse(binding.context.authority),
      chunkIndex: 0,
      path: artifactPath,
      sessionId: binding.context.target.sessionId,
    };
    const scope = and(
      eq(prototypeArtifactChunks.issuer, key.issuer),
      eq(prototypeArtifactChunks.audience, key.audience),
      eq(prototypeArtifactChunks.workspaceId, key.workspaceId),
      eq(prototypeArtifactChunks.ownerUserId, key.ownerUserId),
      eq(prototypeArtifactChunks.sessionId, key.sessionId),
      eq(prototypeArtifactChunks.path, key.path),
      eq(prototypeArtifactChunks.chunkIndex, key.chunkIndex),
    );
    const content = JSON.stringify({
      appId: input.appId,
      appSpecDigest: input.appSpecDigest,
      descriptionSha256: createHash("sha256").update(JSON.stringify(description)).digest("hex"),
      source,
      version: 1,
    });
    const chunkDigest = createHash("sha256").update(content).digest("hex");
    const transferDigest = createHash("sha256").update(source.reviewDigest).digest("hex");
    await binding.assertCurrentOwner(binding.context);
    await db
      .insert(prototypeArtifactChunks)
      .values({
        ...key,
        chunkDigest,
        content,
        createdAt: new Date(),
        transferDigest,
      })
      .onConflictDoNothing();
    const rows = await db
      .select()
      .from(prototypeArtifactChunks)
      .where(and(scope, eq(prototypeArtifactChunks.transferDigest, transferDigest)))
      .limit(1);
    await binding.assertCurrentOwner(binding.context);
    const row = rows.at(0);
    if (row === undefined || row.chunkDigest !== chunkDigest || row.content !== content) {
      throw operatorArtifactUnavailable();
    }
    return { publishedSource: source, status: "recorded-static" };
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

/** Read exact owner/session/AppSpec static publication provenance after independent owner resolution. */
export const readPublishedStaticAppSourceForSession = async (
  input: CompiledOperatorArtifactSessionInput,
): Promise<PublishedAppSource | undefined> => {
  const binding = await resolveCompiledArtifactSession(input);
  const storage = await openCompiledArtifactStorage(binding);
  if (storage.descriptions === undefined) {
    return undefined;
  }
  const description = await storage.descriptions.read(binding.context, input.appSpecDigest);
  if (description === undefined || description.backend.kind !== "static") {
    return undefined;
  }
  const [{ prototypeArtifactChunks }, { and, desc, eq }, { createHash }, db] = await Promise.all([
    import("../db/schema"),
    import("drizzle-orm"),
    import("node:crypto"),
    openArtifactDatabase(),
  ]);
  const scope = and(
    eq(
      prototypeArtifactChunks.issuer,
      hostedTenantAuthoritySchema.parse(binding.context.authority).issuer,
    ),
    eq(
      prototypeArtifactChunks.audience,
      hostedTenantAuthoritySchema.parse(binding.context.authority).audience,
    ),
    eq(
      prototypeArtifactChunks.workspaceId,
      hostedTenantAuthoritySchema.parse(binding.context.authority).workspaceId,
    ),
    eq(
      prototypeArtifactChunks.ownerUserId,
      hostedTenantAuthoritySchema.parse(binding.context.authority).ownerUserId,
    ),
    eq(prototypeArtifactChunks.sessionId, binding.context.target.sessionId),
    eq(
      prototypeArtifactChunks.path,
      `_protected-operator/static-published-source/${input.appId}/${input.appSpecDigest}`,
    ),
    eq(prototypeArtifactChunks.chunkIndex, 0),
  );
  await binding.assertCurrentOwner(binding.context);
  const rows = await db
    .select()
    .from(prototypeArtifactChunks)
    .where(scope)
    .orderBy(desc(prototypeArtifactChunks.createdAt), desc(prototypeArtifactChunks.transferDigest))
    .limit(1);
  await binding.assertCurrentOwner(binding.context);
  const row = rows.at(0);
  if (
    row === undefined ||
    createHash("sha256").update(row.content).digest("hex") !== row.chunkDigest
  ) {
    return undefined;
  }
  const value = z
    .strictObject({
      appId: z.string(),
      appSpecDigest: z.string(),
      descriptionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      source: publishedAppSourceSchema,
      version: z.literal(1),
    })
    .safeParse(JSON.parse(row.content));
  if (
    !value.success ||
    value.data.appId !== input.appId ||
    value.data.appSpecDigest !== input.appSpecDigest ||
    value.data.descriptionSha256 !==
      createHash("sha256").update(JSON.stringify(description)).digest("hex")
  ) {
    return undefined;
  }
  return value.data.source;
};

/** A sealed context records no grant: every completion re-resolves the current authenticated owner. */
export const assertReconciliationCompletionOwnerForSession = async (input: {
  completion: DraftPublicationCompletion;
  adapterSessionId: string;
  sessionAuth: unknown;
  callbackExecution?: HostedOperatorCallbackExecution;
}) => {
  await resolveCompiledArtifactSession(
    {
      ...input,
      appId: input.completion.appId,
      appSpecDigest: input.completion.appReview.appSpecDigest,
      callId: input.completion.proposal.digest,
      root: input.completion.root,
    },
    input.completion,
  );
};

class CurrentReleaseSelectionChangedError extends Error {
  override name = "CurrentReleaseSelectionChangedError";
}

/** Complete only a retained sealed publication, using its original release instead of current selection. */
export const recordPublishedReconciliationSourceForSession = async (input: {
  completion: DraftPublicationCompletion;
  adapterSessionId: string;
  sessionAuth: unknown;
  publishedSource: PublishedAppSource;
  recordCurrentEquivalentRelease?: true;
  callbackExecution?: HostedOperatorCallbackExecution;
}) => {
  const { completion } = input;
  const resolvedBinding = await resolveCompiledArtifactSession(
    {
      ...input,
      appId: completion.appId,
      appSpecDigest: completion.appReview.appSpecDigest,
      callId: completion.proposal.digest,
      root: completion.root,
    },
    completion,
  );
  const binding =
    input.recordCurrentEquivalentRelease === true
      ? {
          ...resolvedBinding,
          assertCurrentOwner: async (context: OperatorArtifactContext) => {
            await resolvedBinding.assertCurrentOwner(context);
            const current = appBuilderWorkflowState.get();
            if (
              !("appSpec" in current) ||
              current.appSpec.appId !== completion.appId ||
              current.appSpec.digest !== completion.appReview.appSpecDigest
            ) {
              throw new CurrentReleaseSelectionChangedError();
            }
          },
        }
      : resolvedBinding;
  try {
    await binding.assertCurrentOwner(binding.context);
    const { release } = completion.compilation;
    if (release.status === "not-required") {
      return { status: "not-required" as const };
    }
    const storage = await openCompiledArtifactStorage(binding);
    const retained = await readExactCompiledOperatorRelease({
      assertCurrentOwner: binding.assertCurrentOwner,
      context: binding.context,
      lookup: {
        appSpecDigest: release.selection.appSpecDigest,
        artifactRef: release.selection.artifactRef,
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
    if (input.recordCurrentEquivalentRelease === true) {
      if (storage.selections.associatePublishedSource === undefined) {
        throw operatorArtifactUnavailable();
      }
      return await storage.selections.associatePublishedSource(binding.context, {
        approvedSelection: release.selection,
        operationId: `draft-reconciliation:${completion.proposal.digest}`,
        publishedSource: input.publishedSource,
      });
    }
    const selection = await storage.selections.record(
      binding.context,
      `draft-reconciliation:${completion.proposal.digest}`,
      {
        ...release.selection,
        publishedSource: input.publishedSource,
      },
    );
    return { selection, status: "recorded" as const };
  } catch (error) {
    if (error instanceof CurrentReleaseSelectionChangedError) {
      return { status: "selection-changed" as const };
    }
    throw error;
  }
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

/** Read the static description captured for the exact app, owner session, and AppSpec digest. */
export const readCapturedAppDescriptionForSession = async (
  input: CompiledOperatorArtifactSessionInput,
): Promise<AppDescription | undefined> => {
  input.signal?.throwIfAborted();
  const binding = await resolveCompiledArtifactSession(input);
  const storage = await openCompiledArtifactStorage(binding);
  if (storage.descriptions === undefined) {
    return undefined;
  }
  await binding.assertCurrentOwner(binding.context);
  const description = await storage.descriptions.read(binding.context, input.appSpecDigest);
  await binding.assertCurrentOwner(binding.context);
  input.signal?.throwIfAborted();
  return description;
};

/** Closed workflow hook. Public tool input cannot provide SQL, release paths, hashes or owner facts. */
export const publishCompiledOperatorArtifactsForSession = async (
  input: CompiledOperatorArtifactSessionInput & {
    sandbox: Pick<SandboxSession, "run" | "readBinaryFile">;
    /** Internal Auth-only planner guard: capture static description, never publish a generated release. */
    expectedBackend?: "static";
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
    if (input.expectedBackend === "static" && description.backend.kind !== "static") {
      throw operatorArtifactUnavailable();
    }
    if (description.backend.kind === "static") {
      const storage = await openCompiledArtifactStorage(binding);
      await storage.descriptions?.record(context, input.appSpecDigest, input.callId, description);
      await assertCurrentOwner(context);
      checkStopped();
      return {
        compilation: {
          ...binding.captureAuthority,
          release: { status: "not-required" as const },
        } satisfies ReconciliationCompilation,
        status: "not-required" as const,
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
      compilation: {
        ...binding.captureAuthority,
        release: { status: "published" as const, selection },
      } satisfies ReconciliationCompilation,
      selection,
      status: "published" as const,
    };
  } catch (error) {
    observe({ outcome: input.signal?.aborted === true ? "cancelled" : "failed", stage });
    throw error;
  }
};
