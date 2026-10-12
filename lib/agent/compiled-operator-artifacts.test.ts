/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, eslint/require-await, typescript/no-unsafe-type-assertion -- Controlled Eve/owner/DB ports isolate the production capture hook; real PostgreSQL storage has its separate owned fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  compiledArtifactSandboxRelativePath,
  publishCompiledOperatorArtifactsForSession,
} from "./compiled-operator-artifacts";
import type { OperatorArtifactContext } from "../provisioning/hosted-operator-artifact-store";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
// oxlint-disable-next-line sonarjs/no-internal-api-use -- Actual local Eve authority is exercised only in this fixture, never through product imports.
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { requestPrivateApplyApproval, recordApprovedPrivateApply } from "./private-apply-authority";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";

const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  onRead: vi.fn<(index: number) => void | Promise<void>>(),
  owner: null as Record<string, unknown> | null,
  record: vi.fn(),
  resolve: vi.fn(),
  rows: new Map<string, string>(),
  state: null as Record<string, unknown> | null,
}));
vi.mock("./workflow-state", () => ({ appBuilderWorkflowState: { get: () => mocks.state } }));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: () => mocks.candidate },
}));
vi.mock("../provisioning/hosted-operator-owner-context", () => ({
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
  createPostgresOperatorArtifactSelections: () => ({ record: mocks.record }),
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
      command: "mise run app:describe spend-review",
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
