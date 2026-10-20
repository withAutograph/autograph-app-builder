import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationReviewContextStore } from "./application-review-context-store";
import type { PreparedApplicationReviewContext } from "./application-review-context-store";
import type { ProductSourceAssessment } from "./product-source-review";
import { sourceReviewBindingDigest } from "./product-source-review";
import type {
  OperatorArtifactContext,
  OperatorArtifactChunk,
  OperatorArtifactStore,
} from "../provisioning/hosted-operator-artifact-store";
import { createLocalOperatorArtifactStorage } from "../provisioning/local-operator-artifact-store";
import { parsePrototypeArtifactPath } from "./prototype-artifacts";

const context: OperatorArtifactContext = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
  },
  target: { appId: "independent-app", sessionId: "original-native-parent" },
};
const prepared = (): PreparedApplicationReviewContext => ({
  version: 1,
  appId: context.target.appId,
  parentSessionId: context.target.sessionId,
  sandboxName: "server-captured-sandbox",
  applyRoot: "/workspace/repository",
  observed: {
    treeDigest: "observed-tree",
    files: [{ path: "new-folder/source.ts", mode: "644", digest: "observed-file" }],
  },
  normalizedChanges: [
    {
      kind: "added",
      path: "new-folder/source.ts",
      after: { mode: "644", digest: "observed-file" },
    },
  ],
  visiblePaths: ["new-folder/source.ts"],
  reviewKey: "a".repeat(64),
  reviewInput: {
    appSpec: "Complete specification with arbitrary customer business content.",
    appSpecDigest: "spec-digest",
    clarifications: ["Keep the original business scope."],
    omissions: [],
    originalRequest: "Review the complete original requirement.",
    sourceDigest: "observed-tree",
  },
});
const assessment = (value = prepared()): ProductSourceAssessment => ({
  basis: "source-review",
  bindingDigest: sourceReviewBindingDigest(value.reviewInput),
  evidenceDigest: "b".repeat(64),
  evidenceNote: "Source evidence only.",
  modelId: "independent-model",
  status: "unassessed",
  findings: [],
  reviewCompleted: true,
  reason: "Independent source review completed; native behavior remains unassessed.",
  omissions: [],
  remainingRuntimeChecks: ["Observe actual persistence."],
  invocation: {
    requestAttempts: 2,
    successfulRequests: 2,
    journalReuses: 0,
    splits: 0,
    requestsWithIncompleteUsage: 0,
    freshUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
  },
});
const fixture = () => {
  let owned = true;
  const rows = new Map<string, string>();
  const writes: OperatorArtifactChunk[] = [];
  const assertCurrentOwner = vi.fn(async () => {
    await Promise.resolve();
    if (!owned) {
      throw new Error("owner revoked");
    }
  });
  const key = (current: OperatorArtifactContext, ref: string, index: number) =>
    JSON.stringify([current.authority, current.target, ref, index]);
  const store: OperatorArtifactStore = {
    async put(current, chunk) {
      await Promise.resolve();
      writes.push(chunk);
      const row = key(current, chunk.artifactRef, chunk.chunkIndex);
      if (!rows.has(row)) {
        rows.set(row, chunk.content);
      }
    },
    read: async (current, ref, index) => {
      await Promise.resolve();
      return rows.get(key(current, ref, index));
    },
  };
  const factory = (current = context, abortSignal?: AbortSignal) =>
    createApplicationReviewContextStore({
      store,
      context: current,
      assertCurrentOwner,
      abortSignal,
    });
  return {
    rows,
    writes,
    key,
    store,
    factory,
    assertCurrentOwner,
    revoke: () => {
      owned = false;
    },
  };
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private prepared application-review context and outcomes", () => {
  it("publishes every opaque context chunk before completion and reads exact Unicode evidence after reconstruction", async () => {
    const f = fixture();
    const value = prepared();
    value.reviewInput.appSpec =
      "Business requirement: 密碼, passwords, 🔎 and independent routes. ".repeat(6000);
    const ref = await f.factory().publishContext(value);
    expect(f.writes.filter((chunk) => chunk.chunkIndex > 0).length).toBeGreaterThan(1);
    expect(f.writes.at(-1)?.chunkIndex).toBe(0);
    expect(ref).toMatch(
      /^_protected-operator\/artifacts\/source-review-context\/independent-app\/[a-f0-9]{64}$/u,
    );
    expect(() => parsePrototypeArtifactPath(ref)).toThrow();
    const restored = await f.factory().readContext(ref);
    expect(restored.reviewInput.appSpec).toBe(value.reviewInput.appSpec);
    expect(restored.observed.files).toEqual(value.observed.files);
    expect(restored.parentSessionId).toBe(context.target.sessionId);
    expect(await f.factory().publishContext(value)).toBe(ref);
  });

  it("stores bound terminal advisory outcomes without claiming review completion", async () => {
    const f = fixture();
    const store = f.factory();
    const value = prepared();
    const contextRef = await store.publishContext(value);
    const advisory: ProductSourceAssessment = {
      ...assessment(value),
      reviewCompleted: false,
      status: "blocked",
      reason: "Independent evidence was unavailable.",
    };
    const outcomeRef = await store.publishOutcome(contextRef, advisory);
    expect(await f.factory().readOutcome(outcomeRef)).toEqual({
      contextRef,
      reviewKey: value.reviewKey,
      assessment: advisory,
    });
    await expect(store.readContext(outcomeRef)).rejects.toThrow();
    await expect(store.readOutcome(contextRef)).rejects.toThrow();
  });

  it("rejects wrong app and original-parent session before publication", async () => {
    const f = fixture();
    await expect(
      f.factory().publishContext({ ...prepared(), appId: "foreign-app" }),
    ).rejects.toThrow();
    await expect(
      f.factory().publishContext({ ...prepared(), parentSessionId: "child-session" }),
    ).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });

  it("rejects foreign owner and parent scope even if a faulty store copies the same private chunks", async () => {
    const f = fixture();
    const ref = await f.factory().publishContext(prepared());
    const foreignOwner: OperatorArtifactContext = {
      ...context,
      authority: {
        issuer: "https://builder.example/api/auth",
        audience: "https://builder.example/mcp",
        workspaceId: "workspace",
        ownerUserId: "other-owner",
      },
    };
    const foreignSession: OperatorArtifactContext = {
      ...context,
      target: { ...context.target, sessionId: "other-parent" },
    };
    await Promise.all(
      [foreignOwner, foreignSession].map(async (foreign) => {
        for (const chunk of f.writes) {
          f.rows.set(f.key(foreign, ref, chunk.chunkIndex), chunk.content);
        }
        await expect(f.factory(foreign).readContext(ref)).rejects.toThrow();
      }),
    );
    const foreignApp: OperatorArtifactContext = {
      ...context,
      target: { ...context.target, appId: "another-app" },
    };
    await expect(f.factory(foreignApp).readContext(ref)).rejects.toThrow();
  });

  it("rejects an immutable winning chunk that differs from the publication acknowledgement", async () => {
    const f = fixture();
    f.store.put = async (current, chunk) => {
      await Promise.resolve();
      f.writes.push(chunk);
      f.rows.set(f.key(current, chunk.artifactRef, chunk.chunkIndex), "different-winning-content");
    };
    await expect(f.factory().publishContext(prepared())).rejects.toThrow();
    expect(f.writes.some((chunk) => chunk.chunkIndex === 0)).toBe(false);
  });

  it("keeps an interrupted partial context unavailable without completion metadata", async () => {
    const f = fixture();
    const put = f.store.put;
    f.store.put = async (current, chunk) => {
      if (chunk.chunkIndex === 0) {
        throw new Error("completion interrupted");
      }
      await put(current, chunk);
    };
    await expect(f.factory().publishContext(prepared())).rejects.toThrow("completion interrupted");
    const ref = f.writes[0].artifactRef;
    await expect(f.factory().readContext(ref)).rejects.toThrow();
  });

  it.each(["missing", "tampered"])("rejects a %s private context member", async (kind) => {
    const f = fixture();
    const ref = await f.factory().publishContext(prepared());
    const row = f.key(context, ref, 1);
    if (kind === "missing") {
      f.rows.delete(row);
    } else {
      f.rows.set(row, Buffer.from("tampered private bytes").toString("base64"));
    }
    await expect(f.factory().readContext(ref)).rejects.toThrow();
  });

  it("binds the outcome assessment to the original context requirements and source", async () => {
    const f = fixture();
    const ref = await f.factory().publishContext(prepared());
    const written = f.writes.length;
    await expect(
      f.factory().publishOutcome(ref, { ...assessment(), bindingDigest: "c".repeat(64) }),
    ).rejects.toThrow();
    expect(f.writes).toHaveLength(written);
    const outcomeRef = await f.factory().publishOutcome(ref, assessment());
    const decoded = await f.factory().readOutcome(outcomeRef);
    expect(decoded.contextRef).toBe(ref);
    expect(decoded.reviewKey).toBe(prepared().reviewKey);
    expect(decoded.assessment.bindingDigest).toBe(
      sourceReviewBindingDigest(prepared().reviewInput),
    );
  });

  it("requires current ownership before I/O and after a private chunk read", async () => {
    const f = fixture();
    const ref = await f.factory().publishContext(prepared());
    const read = f.store.read;
    f.store.read = async (current, value, index) => {
      const result = await read(current, value, index);
      f.revoke();
      return result;
    };
    await expect(f.factory().readContext(ref)).rejects.toThrow("owner revoked");
    const writes = f.writes.length;
    await expect(f.factory().publishContext(prepared())).rejects.toThrow("owner revoked");
    expect(f.writes).toHaveLength(writes);
  });

  it("honors Stop before and after a chunk write without publishing a completion", async () => {
    const f = fixture();
    const controller = new AbortController();
    const put = f.store.put;
    f.store.put = async (current, chunk) => {
      await put(current, chunk);
      controller.abort(new Error("Stop"));
    };
    await expect(f.factory(context, controller.signal).publishContext(prepared())).rejects.toThrow(
      "Stop",
    );
    expect(f.writes.some((chunk) => chunk.chunkIndex === 0)).toBe(false);
    const written = f.writes.length;
    await expect(f.factory(context, controller.signal).publishContext(prepared())).rejects.toThrow(
      "Stop",
    );
    expect(f.writes).toHaveLength(written);
  });

  it("uses the existing real private local store with only the new protected artifact kind", async () => {
    const stateRoot = await realpath(await mkdtemp(path.join(tmpdir(), "review-context-private-")));
    roots.push(stateRoot);
    const authority = { kind: "local" as const, ownerUid: process.getuid?.() ?? -1, stateRoot };
    const owned: OperatorArtifactContext = { authority, target: context.target };
    const assertCurrentOwner = async () => {
      await Promise.resolve();
    };
    const { store } = await createLocalOperatorArtifactStorage({ authority, assertCurrentOwner });
    const adapter = () =>
      createApplicationReviewContextStore({ store, context: owned, assertCurrentOwner });
    const ref = await adapter().publishContext(prepared());
    const restored = await adapter().readContext(ref);
    expect(restored.sandboxName).toBe(prepared().sandboxName);
    const outcomeRef = await adapter().publishOutcome(ref, assessment());
    const outcome = await adapter().readOutcome(outcomeRef);
    expect(outcome.assessment.reviewCompleted).toBe(true);
  });
});
