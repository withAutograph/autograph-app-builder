import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceReviewJournalForSession } from "./source-review-journal-runtime";

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
