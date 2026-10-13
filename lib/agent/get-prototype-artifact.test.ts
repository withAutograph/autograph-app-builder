/* oxlint-disable anti-slop/no-module-mocking -- Replace only terminal hosted PostgreSQL access so the real getter, Eve state, authority parsing, and artifact verification run. */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAuthContext } from "eve/context";
import type { ToolContext } from "eve/tools";

import getPrototypeArtifact from "../../agent/tools/get_prototype_artifact";
import { appBuilderWorkflowState, APP_BUILDER_WORKFLOW_VERSION } from "./workflow-state";
import type {
  AppBuilderWorkflowState,
  PrototypeArtifactV2,
  StoredPrototypeArtifact,
} from "./workflow-state";
import { recordPrototypeArtifactRevision } from "./prototype-artifacts";
import { LEGACY_SOURCE_RECEIPT_VERSION } from "../repository/source-receipt";
import { SUPPORTED_TEMPLATE_ADAPTER } from "../repository/supported-template";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import type { SourceReceipt } from "../repository/source-receipt";
import type { PrototypeChunkKey } from "./postgres-prototype-chunks";

interface DatabaseStub {
  database: string;
}

const mocks = vi.hoisted(() => {
  const chunks = new Map<string, string>();
  const getChunk = vi.fn(
    // oxlint-disable-next-line eslint/require-await -- Preserve the async PostgreSQL read contract.
    async (_database: DatabaseStub, key: PrototypeChunkKey) =>
      await Promise.resolve(
        chunks.get(JSON.stringify([key.path, key.transferDigest, key.chunkIndex])),
      ),
  );
  const openDatabase = vi.fn((): DatabaseStub => ({ database: "test" }));
  return { chunks, getChunk, openDatabase };
});

vi.mock("@/lib/mcp/hosted-route", () => ({
  openHostedPostgresDatabase: mocks.openDatabase,
}));
vi.mock("./postgres-prototype-chunks", () => ({
  getPrototypeChunk: mocks.getChunk,
  putPrototypeChunk: vi.fn(),
}));

const digest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");
const path = "prototype/spend-review/decisions.md";
const sessionId = "session-1";
const authContext: SessionAuthContext = {
  attributes: {
    "mcp:audience": "https://builder.example/mcp",
    "mcp:scopes": ["autograph:session"],
    "mcp:workspace-id": "workspace-1",
  },
  authenticator: "mcp-oauth-jwks",
  issuer: "https://builder.example/api/auth",
  principalId: "user-1",
  principalType: "user",
  subject: "user-1",
};
const context: ToolContext = {
  abortSignal: new AbortController().signal,
  callId: "read-artifact",
  getSandbox: async () =>
    await Promise.reject(new Error("The artifact getter must not open a sandbox.")),
  getToken: async () => await Promise.resolve({ token: "unused" }),
  requireAuth: () => {
    throw new Error("The artifact getter must not request additional authorization.");
  },
  session: {
    auth: { current: authContext, initiator: authContext },
    id: sessionId,
    turn: { id: "turn-1", sequence: 0 },
  },
  toolName: "get_prototype_artifact",
};

const workspace: PreparedSandboxWorkspace = {
  adapter: SUPPORTED_TEMPLATE_ADAPTER,
  eligibilityDigest: "eligibility",
  sourcePath: "/workspace/repository",
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
  workspaceDigest: "workspace",
  workspaceId: "workspace-1",
  workspacePath: "/workspace/repository",
};
const sourceReceipt: SourceReceipt = {
  adapter: SUPPORTED_TEMPLATE_ADAPTER,
  contractDigest: "contract",
  digest: "source",
  eligibilityDigest: "eligibility",
  releaseEnabled: false,
  sourceKind: "existing-repository",
  sourcePath: "/workspace/repository",
  sourceSha: workspace.sourceSha,
  sourceTree: workspace.sourceTree,
  version: LEGACY_SOURCE_RECEIPT_VERSION,
};

const preparedState = (artifacts: readonly StoredPrototypeArtifact[]): AppBuilderWorkflowState => ({
  artifacts,
  phase: "prepared",
  preparedByCallId: "prepared",
  sourceReceipt,
  version: APP_BUILDER_WORKFLOW_VERSION,
  workspace,
});

const v2Artifact = (contentChunks: readonly string[]): PrototypeArtifactV2 => {
  const content = contentChunks.join("");
  const artifactDigest = digest(content);
  return {
    appId: "spend-review",
    chunkCount: contentChunks.length,
    contentBytes: Buffer.byteLength(content, "utf-8"),
    digest: artifactDigest,
    mediaType: "text/markdown",
    path,
    recordedByCallId: "recorded",
    revision: digest(JSON.stringify({ digest: artifactDigest, mediaType: "text/markdown", path })),
    sessionId,
    version: 2,
  };
};

describe("get_prototype_artifact", () => {
  const getWorkflowState = vi.spyOn(appBuilderWorkflowState, "get");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chunks.clear();
    getWorkflowState.mockReturnValue({
      phase: "empty",
      version: APP_BUILDER_WORKFLOW_VERSION,
    });
  });

  it("starts a durable v2 read at zero when offsetBytes is omitted and continues from nextOffsetBytes", async () => {
    const contentChunks = ["# Decisions\n\n", "Use local data.\n"];
    const artifact = v2Artifact(contentChunks);
    for (const [chunkIndex, content] of contentChunks.entries()) {
      mocks.chunks.set(JSON.stringify([path, artifact.digest, chunkIndex]), content);
    }
    getWorkflowState.mockReturnValue(preparedState([artifact]));

    await expect(
      getPrototypeArtifact.execute(
        { digest: artifact.digest, path, revision: artifact.revision },
        {
          ...context,
          session: { ...context.session, id: "another-session" },
        },
      ),
    ).rejects.toThrow("stale or unavailable");
    expect(mocks.getChunk).not.toHaveBeenCalled();

    await expect(
      getPrototypeArtifact.execute(
        { digest: "0".repeat(64), path, revision: artifact.revision },
        context,
      ),
    ).rejects.toThrow("stale or unavailable");
    expect(mocks.getChunk).not.toHaveBeenCalled();

    const first = await getPrototypeArtifact.execute(
      { digest: artifact.digest, path, revision: artifact.revision },
      context,
    );
    expect(first).toMatchObject({
      byteOffset: 0,
      chunkDigest: digest(contentChunks[0] ?? ""),
      complete: false,
      content: contentChunks[0],
      digest: artifact.digest,
      nextOffsetBytes: Buffer.byteLength(contentChunks[0] ?? "", "utf-8"),
      revision: artifact.revision,
    });

    const second = await getPrototypeArtifact.execute(
      {
        digest: artifact.digest,
        offsetBytes: Buffer.byteLength(contentChunks[0] ?? "", "utf-8"),
        path,
        revision: artifact.revision,
      },
      context,
    );
    expect(second).toMatchObject({
      byteOffset: Buffer.byteLength(contentChunks[0] ?? "", "utf-8"),
      complete: true,
      content: contentChunks[1],
      digest: artifact.digest,
      nextOffsetBytes: artifact.contentBytes,
      revision: artifact.revision,
    });
    expect(mocks.openDatabase).toHaveBeenCalledWith("");
    expect(mocks.getChunk.mock.calls[0]?.[0]).toEqual({ database: "test" });
    const firstKey = mocks.getChunk.mock.calls[0]?.[1];
    expect(firstKey?.path).toBe(path);
    expect(firstKey?.principal.ownerUserId).toBe("user-1");
    expect(firstKey?.principal.workspaceId).toBe("workspace-1");
    expect(firstKey?.sessionId).toBe(sessionId);
    expect(firstKey?.transferDigest).toBe(artifact.digest);
  });

  it("still requires the v2 revision and keeps the inline v1 full-read behavior", async () => {
    const content = "# Inline decisions\n";
    const artifact = v2Artifact([content]);
    mocks.chunks.set(JSON.stringify([path, artifact.digest, 0]), content);
    getWorkflowState.mockReturnValue(preparedState([artifact]));

    await expect(
      getPrototypeArtifact.execute(
        { digest: artifact.digest, path, revision: "f".repeat(64) },
        context,
      ),
    ).rejects.toThrow("stale or unavailable");
    expect(mocks.getChunk).not.toHaveBeenCalled();

    await expect(
      getPrototypeArtifact.execute({ digest: artifact.digest, path }, context),
    ).rejects.toThrow("exact revision");
    expect(mocks.getChunk).not.toHaveBeenCalled();

    const legacy = recordPrototypeArtifactRevision({
      artifacts: [],
      callId: "legacy-record",
      content,
      mediaType: "text/markdown",
      path,
      sessionId,
    }).artifact;
    getWorkflowState.mockReturnValue(preparedState([legacy]));

    await expect(
      getPrototypeArtifact.execute({ digest: legacy.digest, path }, context),
    ).resolves.toMatchObject({
      content,
      digest: legacy.digest,
      path,
      revision: legacy.revision,
    });
    expect(mocks.openDatabase).not.toHaveBeenCalled();
  });
});
