import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sourceReviewJournalForSession,
  sourceReviewContextStoreForSession,
} from "./source-review-journal-runtime";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});
const local = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "source-journal-runtime-")));
  roots.push(root);
  await mkdir(path.join(root, "runs"), { mode: 0o700 });
  for (const [key, value] of Object.entries({
    APP_BUILDER_DEV_RUNS_ROOT: path.join(root, "runs"),
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_HOSTED_ADAPTER: "0",
  })) {
    vi.stubEnv(key, value);
  }
};
describe("server-selected source review persistence", () => {
  it("reuses native empty authentication within one stable session", async () => {
    await local();
    const key = "a".repeat(64);
    const first = await sourceReviewJournalForSession({ sessionAuth: {}, sessionId: "session" });
    await first.put(key, { kind: "split-source" });
    const resumed = await sourceReviewJournalForSession({ sessionAuth: {}, sessionId: "session" });
    const other = await sourceReviewJournalForSession({ sessionAuth: {}, sessionId: "other" });
    expect(await resumed.read(key)).toEqual({ kind: "split-source" });
    expect(await other.read(key)).toBeUndefined();
    await expect(
      sourceReviewJournalForSession({ sessionAuth: { current: {} }, sessionId: "session" }),
    ).rejects.toThrow();
  });
  it("fails closed when hosted persistence or authority is absent", async () => {
    vi.stubEnv("APP_BUILDER_EXECUTION_MODE", "production");
    vi.stubEnv("DATABASE_URL", "");
    await expect(
      sourceReviewJournalForSession({ sessionAuth: {}, sessionId: "session" }),
    ).rejects.toThrow();
  });
});

it("stores prepared review context under the original native session and selected app", async () => {
  await local();
  const first = await sourceReviewContextStoreForSession({
    appId: "example",
    sessionAuth: {},
    sessionId: "native-parent",
  });
  const prepared = {
    version: 1 as const,
    appId: "example",
    parentSessionId: "native-parent",
    sandboxName: "server-selected",
    applyRoot: "/workspace/repository",
    observed: { files: [], treeDigest: "tree" },
    normalizedChanges: [],
    visiblePaths: [],
    reviewKey: "a".repeat(64),
    reviewInput: {
      appSpec: "Full requested behavior",
      appSpecDigest: "spec",
      clarifications: [],
      omissions: [],
      originalRequest: "Original brief",
      sourceDigest: "tree",
    },
  };
  const ref = await first.publishContext(prepared);
  const resumed = await sourceReviewContextStoreForSession({
    appId: "example",
    sessionAuth: {},
    sessionId: "native-parent",
  });
  expect(await resumed.readContext(ref)).toEqual(prepared);
  const other = await sourceReviewContextStoreForSession({
    appId: "example",
    sessionAuth: {},
    sessionId: "other-parent",
  });
  await expect(other.readContext(ref)).rejects.toThrow();
  const otherApp = await sourceReviewContextStoreForSession({
    appId: "different",
    sessionAuth: {},
    sessionId: "native-parent",
  });
  await expect(otherApp.readContext(ref)).rejects.toThrow();
  const controller = new AbortController();
  const cancelled = await sourceReviewContextStoreForSession({
    appId: "example",
    sessionAuth: {},
    sessionId: "native-parent",
    abortSignal: controller.signal,
  });
  controller.abort(new Error("Stopped"));
  await expect(cancelled.readContext(ref)).rejects.toThrow("Stopped");
});
