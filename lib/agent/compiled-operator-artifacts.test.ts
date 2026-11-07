/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, eslint/require-await, typescript/no-unsafe-type-assertion -- Controlled Eve/owner/DB ports isolate the production capture hook; real PostgreSQL storage has its separate owned fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  compiledArtifactSandboxRelativePath,
  publishCompiledOperatorArtifactsForSession,
  recordPublishedOperatorSourceForSession,
  readPublishedOperatorSourceForSession,
  recordPublishedReconciliationSourceForSession,
} from "./compiled-operator-artifacts";
import type { DraftReconciliationCompletion } from "./draft-reconciliation-state";
import type { AppDescription } from "../repository/app-description";
import type { OperatorArtifactContext } from "../provisioning/hosted-operator-artifact-store";
import type {
  OperatorArtifactSelections,
  PublishedAppSource,
  PublishedAppSourceLookup,
  CompiledOperatorReleaseSelection,
} from "../provisioning/hosted-operator-artifact-selection";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
// oxlint-disable-next-line sonarjs/no-internal-api-use -- Actual local Eve authority is exercised only in this fixture, never through product imports.
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { requestPrivateApplyApproval, recordApprovedPrivateApply } from "./private-apply-authority";
import type { MessageStreamEvent } from "eve/client";
import { createHostedEveSessionService, HostedSubmissionUnknownError } from "../eve/hosted-service";
import type { HostedEveTransport } from "../eve/hosted-service";
import { InMemoryHostedEveStore, toDurableHostedSessionRecord } from "../eve/hosted-store";
import { hostedEveOperationScopes } from "../eve/hosted-auth";
import { nativeDeliveryForEvents } from "../eve/native-delivery-state";
import { projectInstalledEveEvent } from "../eve/public-events";
import { createHostedOperatorOwnerContextResolver } from "../provisioning/hosted-operator-owner-context";
import { readHostedOperatorCallbackOwner } from "../provisioning/hosted-operator-callback-owner";
import { createHostedOperatorClient } from "../provisioning/hosted-operator-client";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../provisioning/hosted-operator-contract";
import {
  privateHostedApprovalReceiptSchema,
  readPrivateHostedApproval,
} from "../eve/private-hosted-approval";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import {
  createReviewedChangeSetReceipt,
  deriveNormalizedChangeSet,
} from "../repository/reviewed-change-set";
import type { TargetApplyReceipt } from "../repository/target-apply";
import type { TargetValidationReceipt } from "../repository/target-validation";

const mocks = vi.hoisted(() => ({
  associate: vi.fn<NonNullable<OperatorArtifactSelections["associatePublishedSource"]>>(),
  associationAvailable: true,
  candidate: null as Record<string, unknown> | null,
  completion: null as DraftReconciliationCompletion | null,
  onRead: vi.fn<(index: number) => void | Promise<void>>(),
  owner: null as Record<string, unknown> | null,
  publishedSourceLookupAvailable: true,
  readExact: vi.fn(),
  readPublishedSource:
    vi.fn<
      (
        context: OperatorArtifactContext,
        lookup: PublishedAppSourceLookup,
      ) => Promise<PublishedAppSource | undefined>
    >(),
  readSelection: vi.fn(),
  record: vi.fn(),
  resolve: vi.fn(),
  rows: new Map<string, string>(),
  state: null as Record<string, unknown> | null,
}));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: () => mocks.state } }));
vi.mock("./draft-reconciliation-state", () => ({
  assertRetainedDraftReconciliationCompletion: (completion: DraftReconciliationCompletion) => {
    if (completion !== mocks.completion) {
      throw new Error("completion_context_missing");
    }
  },
  draftReconciliationState: { get: () => mocks.candidate },
}));
vi.mock("../provisioning/hosted-operator-owner-context", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHostedOperatorOwnerContext: mocks.resolve,
}));
vi.mock("../auth/preview-oauth-runtime", () => ({
  readPreviewOAuthRuntimeConfig: () => ({ databaseUrl: "private-fixture" }),
}));
vi.mock("../mcp/hosted-route", () => ({ openHostedPostgresDatabase: () => ({}) }));
vi.mock("../provisioning/hosted-operator-artifact-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPostgresOperatorArtifactStore: ({
    assertCurrentOwner,
  }: {
    assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
  }) => ({
    put: async (
      context: OperatorArtifactContext,
      chunk: { artifactRef: string; chunkIndex: number; content: string },
    ) => {
      await assertCurrentOwner(context);
      mocks.rows.set(`${chunk.artifactRef}:${chunk.chunkIndex}`, chunk.content);
    },
    read: async (context: OperatorArtifactContext, ref: string, index: number) => {
      await assertCurrentOwner(context);
      await mocks.onRead(index);
      return mocks.rows.get(`${ref}:${index}`);
    },
  }),
}));
vi.mock("../provisioning/hosted-operator-artifact-selection", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPostgresOperatorArtifactSelections: () => {
    const reads: Pick<OperatorArtifactSelections, "read" | "readExact" | "readPublishedSource"> = {
      read: mocks.readSelection,
      readExact: mocks.readExact,
    };
    if (mocks.publishedSourceLookupAvailable) {
      reads.readPublishedSource = mocks.readPublishedSource;
    }
    const selections: OperatorArtifactSelections = { ...reads, record: mocks.record };
    if (mocks.associationAvailable) {
      selections.associatePublishedSource = mocks.associate;
    }
    return selections;
  },
}));

const digest = "a".repeat(64);
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const auth = {
  attributes: {
    "mcp:audience": authority.audience,
    "mcp:scopes": ["builder:write"],
    "mcp:workspace-id": authority.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: "owner",
  principalType: "user",
  subject: "owner",
};
const frame = () => {
  const schemaHash = createHash("sha256").update("schema").digest("hex");
  const directory = "apps/spend-review/schema/release/fixture-v1";
  const description = {
    app: { id: "spend-review", routes: [], workspacePath: "apps/spend-review" },
    backend: {
      authorization: "declared-policy",
      kind: "generated-postgres",
      release: { artifactHash: `sha256:${schemaHash}`, directory, id: "fixture-v1" },
      roles: ["member"],
      runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
    },
    validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
    version: 1,
  };
  const readBinaryFile = vi.fn(async (request: { path: string }) =>
    Buffer.from(
      request.path.endsWith("release-manifest.json")
        ? JSON.stringify({
            app: "spend-review",
            hashes: { schema: `sha256:${schemaHash}` },
            schema_version: "fixture-v1",
          })
        : "member",
    ),
  );
  const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(description) }));
  return {
    adapterSessionId: "adapter",
    appId: "spend-review",
    appSpecDigest: digest,
    callId: "call",
    root: "/workspace/repository",
    sandbox: { readBinaryFile, run },
    sessionAuth: { current: auth, initiator: auth },
  };
};
describe("owned compiled artifact workflow hook", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onRead.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.rows.clear();
    mocks.readSelection.mockReset();
    mocks.associationAvailable = true;
    mocks.associate.mockReset().mockImplementation(async (_context, input) => ({
      selection: { ...input.approvedSelection, publishedSource: input.publishedSource },
      status: "recorded",
    }));
    mocks.readExact.mockReset();
    mocks.completion = null;
    mocks.readPublishedSource.mockReset();
    mocks.publishedSourceLookupAvailable = true;
    mocks.state = {
      appSpec: { appId: "spend-review", digest },
      applyReceipt: { applyRoot: "/workspace/repository" },
      phase: "applied",
    };
    mocks.candidate = null;
    mocks.owner = {
      adapterGeneration: 1,
      adapterSessionId: "adapter",
      authority,
      kind: "direct",
      principal: { ...authority, scopes: ["builder:write"] },
      sessionId: "durable-original",
    };
    mocks.resolve.mockImplementation(async () => mocks.owner);
    mocks.record.mockImplementation(
      async (
        _context: OperatorArtifactContext,
        _call: string,
        selection: CompiledOperatorReleaseSelection,
      ) => selection,
    );
  });
  const historicalSource = {
    branch: "app-builder/review-existing",
    changeSetDigest: "d".repeat(64),
    gitSha: "b".repeat(40),
    gitTree: "c".repeat(40),
    repositoryId: "4242",
    reviewDigest: "e".repeat(64),
  };
  const historicalLookup = {
    branch: historicalSource.branch,
    gitSha: historicalSource.gitSha,
    gitTree: historicalSource.gitTree,
    repositoryId: historicalSource.repositoryId,
  };

  it("reads historical publication under the current approved app and original owner session", async () => {
    mocks.readPublishedSource.mockResolvedValue(historicalSource);
    const input = frame();
    await expect(
      readPublishedOperatorSourceForSession({ ...input, lookup: historicalLookup }),
    ).resolves.toEqual(historicalSource);
    expect(mocks.readPublishedSource).toHaveBeenCalledWith(
      { authority, target: { appId: input.appId, sessionId: "durable-original" } },
      historicalLookup,
    );
    expect(mocks.readSelection).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(input.sandbox.run).not.toHaveBeenCalled();
  });

  it("treats an unavailable optional historical reader as a miss", async () => {
    mocks.publishedSourceLookupAvailable = false;
    await expect(
      readPublishedOperatorSourceForSession({ ...frame(), lookup: historicalLookup }),
    ).resolves.toBeUndefined();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each(["repositoryId", "branch", "gitSha", "gitTree"] as const)(
    "does not trust a storage port returning a mismatched %s",
    async (field) => {
      mocks.readPublishedSource.mockResolvedValue({ ...historicalSource, [field]: "f".repeat(40) });
      await expect(
        readPublishedOperatorSourceForSession({ ...frame(), lookup: historicalLookup }),
      ).resolves.toBeUndefined();
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );

  it("does not return a historical marker with invalid publication evidence", async () => {
    mocks.readPublishedSource.mockResolvedValue({ ...historicalSource, reviewDigest: "invalid" });
    await expect(
      readPublishedOperatorSourceForSession({ ...frame(), lookup: historicalLookup }),
    ).resolves.toBeUndefined();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("does not return a historical marker after the current owner changes during its read", async () => {
    mocks.readPublishedSource.mockImplementation(async () => {
      mocks.owner = { ...mocks.owner, adapterGeneration: 2 };
      return historicalSource;
    });
    await expect(
      readPublishedOperatorSourceForSession({ ...frame(), lookup: historicalLookup }),
    ).rejects.toThrow("artifact is unavailable");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("records published source on the selected tuple under the canonical public owner session", async () => {
    const selected: CompiledOperatorReleaseSelection = {
      appId: "spend-review",
      appSpecDigest: digest,
      artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${digest}`,
      manifestSha256: "b".repeat(64),
      releaseId: "actual-selected-fixture",
      schemaSha256: "c".repeat(64),
      version: 1,
    };
    const publishedSource = {
      branch: "app-builder/actual-reviewed-fixture",
      changeSetDigest: "d".repeat(64),
      gitSha: "e".repeat(40),
      gitTree: "f".repeat(40),
      repositoryId: "4242",
      reviewDigest: "a".repeat(64),
    };
    mocks.readSelection.mockResolvedValue(selected);
    const input = frame();
    await expect(
      recordPublishedOperatorSourceForSession({ ...input, publishedSource }),
    ).resolves.toMatchObject({ selection: { ...selected, publishedSource }, status: "recorded" });
    const context = { authority, target: { appId: input.appId, sessionId: "durable-original" } };
    expect(mocks.readSelection).toHaveBeenCalledWith(context, digest);
    expect(mocks.record).toHaveBeenCalledWith(context, input.callId, {
      ...selected,
      publishedSource,
    });
    expect(input.sandbox.run).not.toHaveBeenCalled();
    expect(input.sandbox.readBinaryFile).not.toHaveBeenCalled();
  });
  const captureCompletion = async () => {
    const captured = await publishCompiledOperatorArtifactsForSession(frame());
    if (captured.status !== "published") {
      throw new Error("Expected actual fixture release capture.");
    }
    // SAFETY: This closed compiled-storage test consumes only digest/app binding from the proposal; repository tests validate its full seal.
    const completion = {
      appId: "spend-review",
      appReview: { appSpecDigest: digest, changeSetDigest: digest, digest },
      compilation: captured.compilation,
      githubSourceDigest: digest,
      preparation: "sealed-before-approval",
      proposal: { digest },
      review: { digest },
      root: "/workspace/repository",
    } as DraftReconciliationCompletion;
    mocks.completion = completion;
    mocks.readExact.mockResolvedValue(captured.selection);
    mocks.record.mockClear();
    return completion;
  };

  it("associates the verified original publication with the current equivalent capture without reading app source", async () => {
    const completion = await captureCompletion();
    mocks.candidate = null;
    const input = frame();
    input.sandbox.run.mockClear();
    input.sandbox.readBinaryFile.mockClear();
    await expect(
      recordPublishedReconciliationSourceForSession({
        adapterSessionId: "adapter",
        completion,
        publishedSource: historicalSource,
        recordCurrentEquivalentRelease: true,
        sessionAuth: input.sessionAuth,
      }),
    ).resolves.toMatchObject({
      selection: { publishedSource: historicalSource },
      status: "recorded",
    });
    expect(mocks.associate).toHaveBeenCalledWith(
      completion.compilation.context,
      expect.objectContaining({
        approvedSelection:
          completion.compilation.release.status === "published"
            ? completion.compilation.release.selection
            : {},
        publishedSource: historicalSource,
      }),
    );
    expect(mocks.record).not.toHaveBeenCalled();
    expect(input.sandbox.run).not.toHaveBeenCalled();
    expect(input.sandbox.readBinaryFile).not.toHaveBeenCalled();
  });
  it("does not fall back to an ordinary selection write when atomic association is unavailable", async () => {
    const completion = await captureCompletion();
    mocks.associationAvailable = false;
    await expect(
      recordPublishedReconciliationSourceForSession({
        adapterSessionId: "adapter",
        completion,
        publishedSource: historicalSource,
        recordCurrentEquivalentRelease: true,
        sessionAuth: frame().sessionAuth,
      }),
    ).rejects.toThrow();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("checks the retained completion and current canonical owner before equivalent association", async () => {
    const completion = await captureCompletion();
    mocks.owner = { ...mocks.owner, sessionId: "foreign-session" };
    await expect(
      recordPublishedReconciliationSourceForSession({
        adapterSessionId: "adapter",
        completion,
        publishedSource: historicalSource,
        recordCurrentEquivalentRelease: true,
        sessionAuth: frame().sessionAuth,
      }),
    ).rejects.toThrow();
    expect(mocks.associate).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    { appId: "another-app", digest },
    { appId: "spend-review", digest: "f".repeat(64) },
  ])(
    "does not label a different current accepted specification as associated: %j",
    async (appSpec) => {
      const completion = await captureCompletion();
      mocks.state = { ...mocks.state, appSpec };
      await expect(
        recordPublishedReconciliationSourceForSession({
          adapterSessionId: "adapter",
          completion,
          publishedSource: historicalSource,
          recordCurrentEquivalentRelease: true,
          sessionAuth: frame().sessionAuth,
        }),
      ).resolves.toMatchObject({ status: "selection-changed" });
      expect(mocks.associate).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );
  it("stops equivalent association when the accepted specification changes during exact release readback", async () => {
    const completion = await captureCompletion();
    mocks.readExact.mockImplementation(async () => {
      mocks.state = { ...mocks.state, appSpec: { appId: "spend-review", digest: "f".repeat(64) } };
      return completion.compilation.release.status === "published"
        ? completion.compilation.release.selection
        : undefined;
    });
    await expect(
      recordPublishedReconciliationSourceForSession({
        adapterSessionId: "adapter",
        completion,
        publishedSource: historicalSource,
        recordCurrentEquivalentRelease: true,
        sessionAuth: frame().sessionAuth,
      }),
    ).resolves.toMatchObject({ status: "selection-changed" });
    expect(mocks.associate).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("records the original exact release after current selection and candidate move", async () => {
    const completion = await captureCompletion();
    mocks.state = null;
    mocks.candidate = null;
    mocks.readSelection.mockRejectedValue(new Error("latest must never be consulted"));
    const result = await recordPublishedReconciliationSourceForSession({
      adapterSessionId: "adapter",
      completion,
      publishedSource: historicalSource,
      sessionAuth: frame().sessionAuth,
    });
    expect(result).toMatchObject({ status: "recorded" });
    expect(mocks.readSelection).not.toHaveBeenCalled();
    expect(mocks.readExact).toHaveBeenCalledWith(completion.compilation.context, {
      appSpecDigest: digest,
      artifactRef:
        completion.compilation.release.status === "published"
          ? completion.compilation.release.selection.artifactRef
          : "",
    });
    expect(mocks.record).toHaveBeenCalledWith(
      completion.compilation.context,
      `draft-reconciliation:${digest}`,
      completion.compilation.release.status === "published"
        ? { ...completion.compilation.release.selection, publishedSource: historicalSource }
        : { publishedSource: historicalSource },
    );
  });

  it.each(["releaseId", "manifestSha256", "schemaSha256", "appSpecDigest"] as const)(
    "refuses a historical reader substituting the pinned %s",
    async (field) => {
      const completion = await captureCompletion();
      if (completion.compilation.release.status !== "published") {
        throw new Error("Expected pinned release.");
      }
      mocks.readExact.mockResolvedValue({
        ...completion.compilation.release.selection,
        [field]: "f".repeat(64),
      });
      await expect(
        recordPublishedReconciliationSourceForSession({
          adapterSessionId: "adapter",
          completion,
          publishedSource: historicalSource,
          sessionAuth: frame().sessionAuth,
        }),
      ).rejects.toThrow();
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );

  it("refuses original release recording after owner changes during historical read", async () => {
    const completion = await captureCompletion();
    mocks.readExact.mockImplementation(async () => {
      mocks.owner = { ...mocks.owner, adapterGeneration: 2 };
      return completion.compilation.release.status === "published"
        ? completion.compilation.release.selection
        : undefined;
    });
    await expect(
      recordPublishedReconciliationSourceForSession({
        adapterSessionId: "adapter",
        completion,
        publishedSource: historicalSource,
        sessionAuth: frame().sessionAuth,
      }),
    ).rejects.toThrow();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a different current canonical owner even with a retained sealed context", async () => {
    const completion = await captureCompletion();
    mocks.owner = { ...mocks.owner, sessionId: "another-owner-session" };
    await expect(
      recordPublishedReconciliationSourceForSession({
        adapterSessionId: "adapter",
        completion,
        publishedSource: historicalSource,
        sessionAuth: frame().sessionAuth,
      }),
    ).rejects.toThrow();
    expect(mocks.readExact).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("returns the static no-op without compiled workflow markers or hosted storage", async () => {
    const input = frame();
    mocks.state = null;
    const result = await recordPublishedOperatorSourceForSession({
      ...input,
      appSpecDigest: "f".repeat(64),
      backendKind: "static",
      publishedSource: {
        branch: "reviewed-static",
        changeSetDigest: digest,
        gitSha: "a".repeat(40),
        gitTree: "b".repeat(40),
        repositoryId: "4242",
        reviewDigest: digest,
      },
      root: "/private/static-preview",
    });
    expect(result.status).toBe("not-required");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.readSelection).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(input.sandbox.run).not.toHaveBeenCalled();
    expect(input.sandbox.readBinaryFile).not.toHaveBeenCalled();
  });
  const requiredOrUnknownBackends: (AppDescription["backend"]["kind"] | undefined)[] = [
    "generated-postgres",
    undefined,
  ];
  it.each(requiredOrUnknownBackends)(
    "does not classify absent compiled selection as static for backend %s",
    async (backendKind) => {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing selected release is the actual reader's optional undefined result.
      mocks.readSelection.mockResolvedValue(undefined);
      await expect(
        recordPublishedOperatorSourceForSession({
          ...frame(),
          backendKind,
          publishedSource: {
            branch: "reviewed-fixture",
            changeSetDigest: digest,
            gitSha: "a".repeat(40),
            gitTree: "b".repeat(40),
            repositoryId: "4242",
            reviewDigest: digest,
          },
        }),
      ).rejects.toThrow("artifact is unavailable");
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );
  it("does not record publication after the current owner changes during selection read", async () => {
    mocks.readSelection.mockImplementation(async () => {
      mocks.owner = { ...mocks.owner, adapterGeneration: 2 };
      return {
        appId: "spend-review",
        appSpecDigest: digest,
        artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${digest}`,
        manifestSha256: digest,
        releaseId: "fixture",
        schemaSha256: digest,
        version: 1,
      };
    });
    await expect(
      recordPublishedOperatorSourceForSession({
        ...frame(),
        publishedSource: {
          branch: "reviewed-fixture",
          changeSetDigest: digest,
          gitSha: "a".repeat(40),
          gitTree: "b".repeat(40),
          repositoryId: "4242",
          reviewDigest: digest,
        },
      }),
    ).rejects.toThrow();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("does not select a captured release rejected by the schema identity guard", async () => {
    const input = frame();
    const onCaptured = vi.fn().mockRejectedValue(new Error("schema_release_identity_reused"));
    await expect(
      publishCompiledOperatorArtifactsForSession({ ...input, onCaptured }),
    ).rejects.toThrow("schema_release_identity_reused");
    expect(onCaptured).toHaveBeenCalledOnce();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("captures all actual selected members and finalizes only under resolved owner/session", async () => {
    const input = frame();
    const result = await publishCompiledOperatorArtifactsForSession(input);
    expect(result.status).toBe("published");
    expect(input.sandbox.run).toHaveBeenCalledWith({
      command: "mise run --no-deps app:describe spend-review",
      workingDirectory: input.root,
    });
    expect(input.sandbox.readBinaryFile).toHaveBeenCalledTimes(GENERATED_RELEASE_MEMBERS.length);
    expect(mocks.record).toHaveBeenCalledWith(
      { authority, target: { appId: "spend-review", sessionId: "durable-original" } },
      "call",
      expect.objectContaining({ appSpecDigest: digest, releaseId: "fixture-v1" }),
    );
    expect(mocks.rows.size).toBeGreaterThan(1);
  });
  it("maps a reviewed candidate root rather than reading repository bytes", async () => {
    mocks.state = {
      appSpec: { appId: "spend-review", digest },
      applyReceipt: { applyRoot: "/workspace/repository" },
      githubSource: { digest: "source" },
      phase: "reviewed",
      reviewReceipt: { digest: "review" },
    };
    mocks.candidate = {
      appId: "spend-review",
      githubSourceDigest: "source",
      originalReviewDigest: "review",
      root: "/workspace/.app-builder/candidate",
    };
    const input = { ...frame(), root: "/workspace/.app-builder/candidate" };
    await publishCompiledOperatorArtifactsForSession(input);
    for (const [request] of input.sandbox.readBinaryFile.mock.calls) {
      expect(request.path).toMatch(
        /^\.app-builder\/candidate\/apps\/spend-review\/schema\/release\//u,
      );
    }
  });
  const lostReviewCandidate = () => {
    const apply: TargetApplyReceipt = {
      appSpecDigest: digest,
      appSpecPath: ".config/app-specs/spend-review.cue",
      appliedByCallId: "original-apply",
      applyRoot: "/workspace/repository",
      artifactRevision: "reviewed-revision",
      changedContentDigest: digest,
      changes: [],
      command: {
        exitCode: 0,
        name: "iterate-existing-app",
        stderrDigest: digest,
        stdoutDigest: digest,
      },
      dependencyCacheContentDigest: digest,
      dependencyCacheDigest: digest,
      dependencyReceiptDigest: digest,
      digest,
      eligibilityDigest: digest,
      identityDigest: digest,
      imageDigest: digest,
      planningTreeDigest: digest,
      postTree: [],
      postTreeDigest: digest,
      preTree: [],
      preTreeDigest: digest,
      preparedTreeDigest: digest,
      proposalDigest: digest,
      sourceReceiptDigest: digest,
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      status: "applied",
      targetReceipt: {
        appId: "spend-review",
        mutations: ["apps/spend-review", "microfrontends.json"],
        omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
        recovered: false,
        topology: { newDigest: digest, oldDigest: digest, path: "microfrontends.json" },
        version: 1,
        workspacePath: "apps/spend-review",
      },
      version: 2,
      workspaceDigest: digest,
    };
    const validation: TargetValidationReceipt = {
      ...apply,
      appId: "spend-review",
      appValidationSha256: digest,
      appliedTreeDigest: apply.postTreeDigest,
      applyDigest: apply.digest,
      attemptDigest: digest,
      commands: [
        {
          command: "mise run --no-deps --skip-tools app:check spend-review",
          exitCode: 0,
          inputTreeDigest: digest,
          name: "check-build",
          stderrDigest: digest,
          stdoutDigest: digest,
          validationRoot: apply.applyRoot,
        },
        {
          command: "mise run --no-deps --skip-tools app:test spend-review 1/1",
          exitCode: 0,
          inputTreeDigest: digest,
          name: "test",
          stderrDigest: digest,
          stdoutDigest: digest,
          validationRoot: apply.applyRoot,
        },
      ],
      status: "passed",
      testShards: ["1/1"],
      validatedByCallId: "original-validation",
      version: 3,
    };
    const review = createReviewedChangeSetReceipt(
      deriveNormalizedChangeSet(apply, validation, digest, digest),
      "original-review",
    );
    const reviewed = {
      appSpec: { appId: "spend-review", digest },
      applyReceipt: apply,
      githubSource: { digest, repository: { repositoryId: "4242" } },
      identityReceipt: { digest },
      phase: "reviewed",
      proposal: { digest },
      reviewReceipt: review,
      sourceReceipt: { digest, sourceKind: "existing-repository" },
      validationReceipt: validation,
      workspace: { workspaceDigest: digest, workspaceId: "workspace" },
    };
    mocks.state = { ...reviewed, phase: "validated" };
    Reflect.deleteProperty(mocks.state, "reviewReceipt");
    mocks.candidate = {
      appId: "spend-review",
      githubSourceDigest: digest,
      originalReviewDigest: review.digest,
      repositoryId: "4242",
      reviewedLineage: structuredClone(reviewed),
      root: "/workspace/.app-builder/candidate",
    };
    return { ...frame(), root: "/workspace/.app-builder/candidate" };
  };
  it("captures the actual candidate under retained review lineage after creation review loss", async () => {
    const input = lostReviewCandidate();
    await expect(publishCompiledOperatorArtifactsForSession(input)).resolves.toMatchObject({
      status: "published",
    });
    expect(mocks.state?.phase).toBe("validated");
    expect(mocks.state).not.toHaveProperty("reviewReceipt");
    expect(input.sandbox.readBinaryFile).toHaveBeenCalled();
    for (const [request] of input.sandbox.readBinaryFile.mock.calls) {
      expect(request.path).toMatch(
        /^\.app-builder\/candidate\/apps\/spend-review\/schema\/release\//u,
      );
    }
    expect(mocks.rows.size).toBeGreaterThan(0);
    expect(mocks.record).toHaveBeenCalledWith(
      { authority, target: { appId: "spend-review", sessionId: "durable-original" } },
      input.callId,
      expect.objectContaining({ appSpecDigest: digest, releaseId: "fixture-v1" }),
    );
    expect(mocks.associate).not.toHaveBeenCalled();
  });
  it.each(["source", "apply"])(
    "refuses retained candidate capture after the %s binding changes",
    async (binding) => {
      const input = lostReviewCandidate();
      const field = binding === "source" ? "githubSource" : "applyReceipt";
      mocks.state = {
        ...mocks.state,
        [field]: { ...(mocks.state?.[field] as Record<string, unknown>), digest: "f".repeat(64) },
      };
      await expect(publishCompiledOperatorArtifactsForSession(input)).rejects.toThrow(
        "artifact is unavailable",
      );
      expect(input.sandbox.readBinaryFile).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.rows.size).toBe(0);
    },
  );
  it("does not finalize retained-lineage capture after current owner authority changes", async () => {
    const input = lostReviewCandidate();
    mocks.resolve.mockImplementation(async () => {
      if (input.sandbox.readBinaryFile.mock.calls.length >= 2) {
        return { ...mocks.owner, sessionId: "foreign-owner-session" };
      }
      return mocks.owner;
    });
    await expect(publishCompiledOperatorArtifactsForSession(input)).rejects.toThrow(
      "artifact is unavailable",
    );
    expect(input.sandbox.readBinaryFile).toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.rows.size).toBe(0);
  });
  it("denies unapproved app/digest/root and stale owner before selection", async () => {
    await Promise.all(
      [
        { ...frame(), appId: "other" },
        { ...frame(), appSpecDigest: "b".repeat(64) },
        { ...frame(), root: "/workspace/unapproved" },
      ].map(async (input) => {
        await expect(publishCompiledOperatorArtifactsForSession(input)).rejects.toThrow();
      }),
    );
    expect(mocks.record).not.toHaveBeenCalled();
    mocks.resolve
      .mockResolvedValueOnce(mocks.owner)
      .mockResolvedValue({ ...mocks.owner, adapterGeneration: 2 });
    await expect(publishCompiledOperatorArtifactsForSession(frame())).rejects.toThrow();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("does not finalize a selection when capture loses current owner authority", async () => {
    const input = frame();
    mocks.resolve.mockImplementation(async () => {
      if (input.sandbox.readBinaryFile.mock.calls.length >= 2) {
        throw new Error("owner revoked during capture");
      }
      return mocks.owner;
    });
    await expect(publishCompiledOperatorArtifactsForSession(input)).rejects.toThrow();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.rows.size).toBe(0);
  });
  it("resumes the same stopped native lineage through exact SEND proof, artifact capture and private bindings", async () => {
    const store = new InMemoryHostedEveStore();
    const principal = { ...authority, scopes: Object.values(hostedEveOperationScopes) };
    const sessionAuth = {
      current: { ...auth, attributes: { ...auth.attributes, "mcp:scopes": principal.scopes } },
      initiator: { ...auth, attributes: { ...auth.attributes, "mcp:scopes": principal.scopes } },
    };
    let events: MessageStreamEvent[] = [];
    const snapshot = () => ({
      events: events.flatMap((event, index) => projectInstalledEveEvent(event, index)),
      nativeDeliveryState: nativeDeliveryForEvents(events),
      status: "waiting" as const,
    });
    const send = vi.fn<HostedEveTransport["send"]>(async (input) => {
      await input.onAccepted?.("explicit-resume-delivery");
      throw new Error("Lost SEND readback after durable ACK");
    });
    const start = vi.fn<HostedEveTransport["start"]>(async (input) => {
      if (input.recovery === undefined) {
        return { adapterSessionId: "adapter", snapshot: { events: [], status: "failed" } };
      }
      const recoveryBinding = {
        ...input.recovery,
        ownerRunId: "adapter-child",
        provenance: {
          checkpointVersion: 1 as const,
          kind: "failed-turn-input" as const,
          sourceEventId: "retained-event",
          sourceSlot: 1,
          sourceStepId: "retained-step",
        },
      };
      await store.commitNativeRecoveryReceipt({
        descriptor: input.recovery,
        nowEpochMs: Date.now(),
        principal,
        recoveryBinding,
      });
      return { adapterSessionId: "adapter-child", recoveryBinding, snapshot: snapshot() };
    });
    const service = createHostedEveSessionService({
      assertNativeRecoveryOwner: async () => {},
      assertSendDeliveryOwner: async () => {},
      principal,
      store,
      transport: {
        activateRecovery: async ({ operationId }) => {
          const operation = await store.getPrivateOperation(principal, operationId);
          const child = await store.getSession(principal, operation?.sessionId ?? "missing");
          if (child?.version !== 2 || child.nativeRecoveryBinding === undefined) {
            throw new Error("Missing committed native recovery");
          }
          return child.nativeRecoveryBinding;
        },
        cancel: async () => snapshot(),
        get: async () => snapshot(),
        respond: async () => snapshot(),
        send,
        start,
      },
    });
    const source = await service.start({
      clientRequestId: "canary-initial",
      prompt: "Continue the existing app",
    });
    const recovered = await service.start({
      clientRequestId: "canary-recovery",
      resumeSessionId: source.sessionId,
    });
    const original = await store.getSession(principal, source.sessionId);
    const resolver = createHostedOperatorOwnerContextResolver({
      audience: authority.audience,
      handoffs: {
        read: async () => {
          new Map<string, never>().get("missing");
        },
      },
      isActiveMember: async () => true,
      issuer: authority.issuer,
      sessions: store,
    });
    const execution = {
      logicalSessionId: "adapter",
      ownerAnchorRunId: "adapter-child",
      ownerRunId: "callback-step-owner",
    };
    const resolve = async () =>
      await resolver({ adapterSessionId: "adapter", authority, execution, principal, sessionAuth });
    mocks.resolve.mockImplementation(
      async (input: Parameters<typeof resolver>[0]) => await resolver(input),
    );
    const input = { ...frame(), callbackExecution: execution, sessionAuth };
    await service.cancel({ sessionId: recovered.sessionId });
    await expect(resolve()).rejects.toMatchObject({ code: "authorization_required" });
    await expect(publishCompiledOperatorArtifactsForSession(input)).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(mocks.rows.size).toBe(0);
    const request = {
      clientRequestId: "canary-resume-exact",
      message: "Resume the same approved app work",
      sessionId: recovered.sessionId,
    };
    await expect(service.send(request)).rejects.toBeInstanceOf(HostedSubmissionUnknownError);
    await expect(resolve()).rejects.toMatchObject({ code: "authorization_required" });
    const queued = await store.getSession(principal, recovered.sessionId);
    expect(queued?.version === 2 ? queued.resumedCancellationRevision : undefined).not.toBe(1);
    events = [
      {
        data: { sequence: 1, turnId: "resumed-native-turn" },
        meta: {
          at: "2026-10-29T00:00:00Z",
          deliveryIds: ["explicit-resume-delivery"],
          id: "native-resume-event",
        },
        type: "turn.started",
      },
    ];
    await service.get({ cursor: 0, limit: 100, sessionId: recovered.sessionId });
    await expect(resolve()).rejects.toMatchObject({ code: "authorization_required" });
    await service.send(request);
    expect(send).toHaveBeenCalledOnce();
    const resumed = await store.getSession(principal, recovered.sessionId);
    expect(resumed).toMatchObject({ cancellationRevision: 1, resumedCancellationRevision: 1 });
    const owner = await resolve();
    expect(owner).toMatchObject({
      adapterGeneration: 1,
      adapterSessionId: "adapter-child",
      sessionId: source.sessionId,
    });
    await expect(
      resolver({
        adapterSessionId: "adapter",
        authority,
        execution: { ...execution, ownerAnchorRunId: "wrong-anchor" },
        principal,
        sessionAuth,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    await expect(
      readHostedOperatorCallbackOwner({
        execution,
        owner: { ...owner, adapterGeneration: 2 },
        store,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    const captured = await publishCompiledOperatorArtifactsForSession(input);
    expect(captured.status).toBe("published");
    expect(input.sandbox.readBinaryFile).toHaveBeenCalledTimes(GENERATED_RELEASE_MEMBERS.length);
    expect(mocks.record).toHaveBeenCalledWith(
      { authority, target: { appId: input.appId, sessionId: source.sessionId } },
      input.callId,
      expect.objectContaining({ appSpecDigest: digest, releaseId: "fixture-v1" }),
    );
    const selection = {
      appId: input.appId,
      branch: "preview",
      environment: "preview" as const,
      projectId: "project-owned",
      sessionId: source.sessionId,
    };
    const release = mocks.record.mock.calls[0]?.[2] as CompiledOperatorReleaseSelection;
    const plan = hostedOperatorPlanSchema.parse({
      access: [],
      action: "prepare",
      appDatabase: {
        database: "app",
        migratorRole: "app_owner",
        resourceId: "owned-app",
        runtimeRole: "app_runtime",
      },
      authDatabase: {
        database: "auth",
        migratorRole: "auth_owner",
        resourceId: "owned-auth",
        runtimeRole: "auth_runtime",
      },
      contextId: "owned-context",
      cost: {
        class: "independent-service",
        description: "Owned fixture only",
        owner: authority.ownerUserId,
      },
      deploymentBoundary: {
        app: { branch: selection.branch, environment: "preview", projectId: selection.projectId },
        authority,
        gateway: { branch: "gateway", environment: "preview", projectId: "gateway-owned" },
        operator: { deploymentId: "operator", environment: "production", projectId: "builder" },
        teamId: "team-owned",
        verification: {
          gatewayOrigin: "https://gateway.example",
          jwksUrl: "https://gateway.example/_platform/jwks.json",
          publicOrigin: "https://app.example",
        },
      },
      effects: ["resources", "install", "access", "bindings"].map((kind) => ({
        description: `Approved ${kind}`,
        id: kind,
        kind,
      })),
      installer: { reference: "fixed-installer", sha256: "b".repeat(64) },
      neon: {
        branchId: "branch-owned",
        connectionRef: "owner-connection",
        endpoint: "ep-owned.neon.tech",
        projectId: "neon-owned",
        source: "synthetic-only",
      },
      publicGateway: {
        branch: "gateway",
        origin: "https://app.example",
        projectId: "gateway-owned",
      },
      release: {
        artifactRef: release.artifactRef,
        id: release.releaseId,
        sha256: release.manifestSha256,
      },
      retention: { expiresAt: "2030-01-01T00:00:00Z", policy: "Retain approved Preview" },
      selection,
      version: 1,
    });
    const operationRef = "11111111-1111-4111-8111-111111111111";
    const receipt = privateHostedApprovalReceiptSchema.parse({
      callId: "runtime-call",
      format: "autograph-hosted-approval-v1",
      outcome: "approved",
      requestId: "runtime-approval",
      responderPrincipalId: principal.ownerUserId,
      sequence: 1,
      toolInput: {
        appId: selection.appId,
        branch: selection.branch,
        environment: selection.environment,
        operationRef,
        plan,
        planDigest: operatorPlanDigest(plan),
        projectId: selection.projectId,
      },
      toolName: "prepare-app-hosted-runtime",
      turnId: "",
    });
    await store.recordPrivateApprovalReceipts({
      principal,
      receipts: [receipt],
      sessionId: source.sessionId,
    });
    let approvalCallId = receipt.callId;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      await readHostedOperatorCallbackOwner({ execution, owner, store });
      const body = z
        .object({ ownerContext: z.unknown() })
        .parse(JSON.parse(z.string().parse(init?.body)));
      expect(body.ownerContext).toEqual(owner);
      const approved = await readPrivateHostedApproval({
        action: "prepare",
        callId: approvalCallId,
        planDigest: operatorPlanDigest(plan),
        principal,
        selection,
        sessionId: source.sessionId,
        store,
      });
      if (approved?.outcome !== "approved") {
        return Response.json({
          appId: input.appId,
          authenticatedBehavior: "unassessed",
          code: "authorization_required",
          status: "blocked",
        });
      }
      return Response.json({
        environment: {
          PLATFORM_JWKS_URL: "https://gateway.example/_platform/jwks.json",
          PLATFORM_ORIGIN: "https://gateway.example",
          PLATFORM_PUBLIC_ORIGIN: "https://app.example",
          SPEND_REVIEW_DATABASE_URL:
            "postgresql://app_runtime:private@ep-owned.neon.tech/app?sslmode=verify-full",
        },
        operationRef,
        plan,
        proof: {
          actors: 0,
          artifactHash: release.schemaSha256,
          authenticatedBehavior: "unassessed",
          manifestSha256: release.manifestSha256,
          releaseId: release.releaseId,
          tenants: 1,
        },
      });
    });
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: fetcher,
      ownerContext: owner,
      token: async () => "synthetic-workload",
    });
    const bindingRequest = { action: "bindings" as const, operationRef, selection };
    await expect(client.bindings(bindingRequest)).resolves.toMatchObject({
      operationRef,
      proof: { artifactHash: release.schemaSha256, releaseId: release.releaseId },
    });
    await store.recordPrivateApprovalReceipts({
      principal,
      receipts: [
        {
          ...receipt,
          callId: "cancelled-runtime-call",
          outcome: "cancelled",
          requestId: "cancelled-runtime-approval",
          sequence: 2,
        },
      ],
      sessionId: source.sessionId,
    });
    approvalCallId = "cancelled-runtime-call";
    await expect(client.bindings(bindingRequest)).rejects.toMatchObject({
      code: "authorization_required",
    });
    const capturedRows = new Map(mocks.rows);
    const evidence = await store.getSession(principal, source.sessionId);
    const savedReceipt =
      evidence?.version === 2 ? evidence.privateApprovalReceipts?.[0] : undefined;
    expect(
      savedReceipt?.toolName === "prepare-app-hosted-runtime"
        ? savedReceipt.toolInput.plan.release
        : undefined,
    ).toEqual(plan.release);
    await service.cancel({ sessionId: recovered.sessionId });
    await expect(publishCompiledOperatorArtifactsForSession(input)).rejects.toMatchObject({
      code: "authorization_required",
    });
    await expect(client.bindings(bindingRequest)).rejects.toBeDefined();
    expect(mocks.rows).toEqual(capturedRows);
    expect(send).toHaveBeenCalledOnce();
    const originalApproval = await readPrivateHostedApproval({
      action: "prepare",
      callId: receipt.callId,
      planDigest: operatorPlanDigest(plan),
      principal,
      selection,
      sessionId: source.sessionId,
      store,
    });
    expect(originalApproval).toEqual(receipt);
    expect(original).toMatchObject({ sessionId: source.sessionId, status: "failed" });
    const finalSource = await store.getSession(principal, source.sessionId);
    if (finalSource === null) {
      throw new Error("Original source evidence is missing");
    }
    expect(toDurableHostedSessionRecord(finalSource).adapterSessionId).toBe("adapter");
  });
  it("normal developer profile captures through actual private files and Eve approval without hosted auth or DB", async () => {
    const stateRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "developer-compiled-artifact-")),
    );
    try {
      const runsRoot = path.join(stateRoot, "runs");
      await mkdir(runsRoot, { mode: 0o700 });
      for (const [name, value] of Object.entries({
        APP_BUILDER_DEV_RUNS_ROOT: runsRoot,
        APP_BUILDER_EXECUTION_BUNDLE: "local-development",
        APP_BUILDER_EXECUTION_MODE: "development",
        APP_BUILDER_LOCAL_ADAPTER: "1",
        APP_BUILDER_SANDBOX_PROVIDER: "vercel",
        EVE_HOSTED_ADAPTER: "0",
      })) {
        vi.stubEnv(name, value);
      }
      mocks.state = {
        ...mocks.state,
        proposal: { digest: "approved-proposal" },
        workspace: { workspaceId: "private-workspace" },
      };
      const input = { ...frame(), sessionAuth: null };
      const scope = {
        appId: input.appId,
        appSpecDigest: input.appSpecDigest,
        proposalDigest: "approved-proposal",
        sessionId: input.adapterSessionId,
        workspaceId: "private-workspace",
      };
      await contextStorage.run(new ContextContainer(), async () => {
        requestPrivateApplyApproval(scope, "approve");
        recordApprovedPrivateApply(scope, "approve");
        const result = await publishCompiledOperatorArtifactsForSession(input);
        expect(result.status).toBe("published");
        expect(input.sandbox.readBinaryFile).toHaveBeenCalledTimes(
          GENERATED_RELEASE_MEMBERS.length,
        );
        await expect(
          publishCompiledOperatorArtifactsForSession({
            ...input,
            adapterSessionId: "other-session",
          }),
        ).rejects.toThrow();
      });
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.rows.size).toBe(0);
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
    }
  });
  it("finishes every member and immutable readback before the callback, then records selection", async () => {
    const input = frame();
    const onCaptured = vi.fn(async () => {
      expect(input.sandbox.readBinaryFile).toHaveBeenCalledTimes(GENERATED_RELEASE_MEMBERS.length);
      expect(mocks.onRead.mock.calls.map(([index]) => index)).toEqual([0, 1]);
      expect(mocks.record).not.toHaveBeenCalled();
    });
    const result = await publishCompiledOperatorArtifactsForSession({ ...input, onCaptured });
    expect(result.status).toBe("published");
    expect(onCaptured).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledOnce();
  });
  it("skips all authority, source, callback and selection work when pre-aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const input = frame();
    const onCaptured = vi.fn();
    await expect(
      publishCompiledOperatorArtifactsForSession({ ...input, onCaptured, signal: abort.signal }),
    ).rejects.toThrow();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(input.sandbox.run).not.toHaveBeenCalled();
    expect(input.sandbox.readBinaryFile).not.toHaveBeenCalled();
    expect(onCaptured).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.rows.size).toBe(0);
  });
  it("propagates cancellation through capture and skips selection", async () => {
    const abort = new AbortController();
    const input = frame();
    const original = input.sandbox.readBinaryFile.getMockImplementation();
    input.sandbox.readBinaryFile.mockImplementation(async (request) => {
      expect(request).toMatchObject({ abortSignal: abort.signal });
      const bytes = await original?.(request);
      abort.abort();
      return bytes ?? Buffer.alloc(0);
    });
    const onCaptured = vi.fn();
    await expect(
      publishCompiledOperatorArtifactsForSession({ ...input, onCaptured, signal: abort.signal }),
    ).rejects.toThrow();
    expect(input.sandbox.readBinaryFile).toHaveBeenCalledOnce();
    expect(mocks.rows.size).toBe(0);
    expect(onCaptured).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("skips the captured callback and selection after cancellation during readback", async () => {
    const abort = new AbortController();
    mocks.onRead.mockImplementation(async (index: number) => {
      if (index > 0) {
        abort.abort();
      }
    });
    const onCaptured = vi.fn();
    await expect(
      publishCompiledOperatorArtifactsForSession({ ...frame(), onCaptured, signal: abort.signal }),
    ).rejects.toThrow();
    expect(mocks.rows.size).toBeGreaterThan(1);
    expect(onCaptured).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("skips selection when the captured callback cancels after immutable readback", async () => {
    const abort = new AbortController();
    const onCaptured = vi.fn(async () => {
      abort.abort();
    });
    await expect(
      publishCompiledOperatorArtifactsForSession({ ...frame(), onCaptured, signal: abort.signal }),
    ).rejects.toThrow();
    expect(onCaptured).toHaveBeenCalledOnce();
    expect(mocks.rows.size).toBeGreaterThan(1);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("emits only bounded approved diagnostic fields and tolerates logger failure", async () => {
    const log = vi.mocked(console.info);
    await publishCompiledOperatorArtifactsForSession(frame());
    const events = log.mock.calls.map(([value]) =>
      z.record(z.string(), z.unknown()).parse(JSON.parse(String(value))),
    );
    for (const event of events) {
      expect(
        Object.keys(event).every((key) =>
          [
            "callId",
            "event",
            "stage",
            "outcome",
            "member",
            "bytes",
            "chunkTotal",
            "chunkCompleted",
          ].includes(key),
        ),
      ).toBe(true);
      expect(event.callId).toBe("call");
      expect(event.event).toBe("app_builder.compiled_artifact_progress");
      expect([
        "authority",
        "description",
        "storage",
        "capture",
        "publication",
        "completion",
        "readback",
        "captured",
        "selection",
      ]).toContain(event.stage);
      expect(["started", "completed", "failed", "cancelled"]).toContain(event.outcome);
      if (event.member !== undefined) {
        expect(GENERATED_RELEASE_MEMBERS).toContain(event.member);
      }
    }
    for (const forbidden of [
      "owner",
      "durable-original",
      "adapter",
      "spend-review",
      "_protected-operator",
      "fixture-v1",
      "private-fixture",
      "appSpecDigest",
      "artifactRef",
    ]) {
      expect(JSON.stringify(events)).not.toContain(forbidden);
    }
    log.mockImplementation(() => {
      throw new Error("private logger failure");
    });
    const result = await publishCompiledOperatorArtifactsForSession(frame());
    expect(result.status).toBe("published");
  });
  it("rejects paths escaping the approved sandbox workspace", () => {
    expect(compiledArtifactSandboxRelativePath("/workspace/.app-builder/candidate")).toBe(
      ".app-builder/candidate",
    );
    for (const root of [
      "/workspace/../other",
      "/workspace/",
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Negative fixture path is rejected without filesystem access.
      "/tmp/repository",
      "repository",
      "/workspace/a\\b",
    ]) {
      expect(() => compiledArtifactSandboxRelativePath(root)).toThrow();
    }
  });
});
