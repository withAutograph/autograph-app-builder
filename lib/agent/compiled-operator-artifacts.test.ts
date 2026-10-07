/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, eslint/require-await, typescript/no-unsafe-type-assertion -- Controlled Eve/owner/DB ports isolate the production capture hook; real PostgreSQL storage has its separate owned fixture. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  compiledArtifactSandboxRelativePath,
  publishCompiledOperatorArtifactsForSession,
} from "./compiled-operator-artifacts";
import type { OperatorArtifactContext } from "../provisioning/hosted-operator-artifact-store";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";

const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
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
      return mocks.rows.get(`${ref}:${index}`);
    },
  }),
}));
vi.mock("../provisioning/hosted-operator-artifact-selection", () => ({
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
  beforeEach(() => {
    vi.clearAllMocks();
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
