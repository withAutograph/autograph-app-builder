import { chmod, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSourceReviewJournal } from "./local-source-review-journal";
import { serializeSourceReviewRecord } from "./product-source-review-journal";
import type { ProductSourceAssessment } from "./product-source-review";

const completedAssessment: ProductSourceAssessment = {
  basis: "source-review",
  bindingDigest: "a".repeat(64),
  evidenceDigest: "b".repeat(64),
  evidenceNote: "Validated source evidence; runtime behavior remains unassessed.",
  findings: [],
  modelId: "review-model",
  omissions: [],
  reason: "No cited source contradiction was identified.",
  remainingRuntimeChecks: ["Execute the accepted product walkthrough."],
  reviewCompleted: true,
  status: "unassessed",
};

const roots: string[] = [];
const fixture = async (ownerScope = "owner", sessionId = "session") => {
  const stateRoot = await realpath(await mkdtemp(path.join(tmpdir(), "source-review-journal-")));
  roots.push(stateRoot);
  let authorized = true;
  return {
    revoke: () => {
      authorized = false;
    },
    stateRoot,
    store: await createLocalSourceReviewJournal({
      // oxlint-disable-next-line eslint/require-await -- Ownership has the same asynchronous contract as the runtime callback.
      async assertCurrentOwner() {
        if (!authorized) {
          throw new Error("ownership revoked");
        }
      },
      ownerScope,
      sessionId,
      stateRoot,
    }),
  };
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});
describe("private durable source review journal", () => {
  it("authorizes evidence without reading completed bytes and still checks owner and directory privacy", async () => {
    const { store, stateRoot, revoke } = await fixture();
    const key = "a".repeat(64);
    await store.put(key, { kind: "split-source" });
    const root = path.join(stateRoot, "source-review-journal");
    const [scope] = await readdir(root);
    await writeFile(path.join(root, scope, `${key}.json`), "incomplete record");
    await expect(store.assertCurrentOwner()).resolves.toBeUndefined();
    await expect(store.read(key)).rejects.toThrow();
    await chmod(stateRoot, 0o755);
    await expect(store.assertCurrentOwner()).rejects.toThrow("unavailable");
    await chmod(stateRoot, 0o700);
    revoke();
    await expect(store.assertCurrentOwner()).rejects.toThrow("ownership revoked");
  });
  it("retains a completed application assessment separately from immutable fragment provenance", async () => {
    const { store } = await fixture();
    const fragment = { assessment: completedAssessment, kind: "completed" as const };
    const application = { assessment: completedAssessment, kind: "application-completed" as const };
    const fragmentKey = "f".repeat(64);
    const applicationKey = "a".repeat(64);
    await store.put(fragmentKey, fragment);
    await store.put(applicationKey, application);
    expect(await store.read(applicationKey)).toEqual(application);
    expect(await store.read(fragmentKey)).toEqual(fragment);
    expect(await store.put(fragmentKey, application)).toEqual(fragment);
  });
  it("rechecks live ownership before reading or writing completed application evidence", async () => {
    const { store, revoke } = await fixture();
    const key = "a".repeat(64);
    const application = { assessment: completedAssessment, kind: "application-completed" as const };
    await store.put(key, application);
    revoke();
    await expect(store.read(key)).rejects.toThrow("ownership revoked");
    await expect(store.put(key, application)).rejects.toThrow("ownership revoked");
  });
  it("replays immutable decisions and rejects a conflicting retry", async () => {
    const { store } = await fixture();
    const key = "a".repeat(64);
    expect(await store.read(key)).toBeUndefined();
    await store.put(key, { kind: "split-source" });
    await store.put(key, { kind: "split-source" });
    expect(await store.read(key)).toEqual({ kind: "split-source" });
    expect(await store.put(key, { kind: "split-context" })).toEqual({ kind: "split-source" });
    await expect(store.read("../escape")).rejects.toThrow();
  });
  it("returns one canonical winner for overlapping valid retries", async () => {
    const { store } = await fixture();
    const key = "e".repeat(64);
    const winners = await Promise.all([
      store.put(key, { kind: "split-source" }),
      store.put(key, { kind: "split-context" }),
    ]);
    expect(winners[0]).toEqual(winners[1]);
    expect(await store.read(key)).toEqual(winners[0]);
  });
  it("isolates owners and sessions across reopening", async () => {
    const { store, stateRoot } = await fixture();
    const key = "b".repeat(64);
    await store.put(key, { kind: "split-context" });
    const create = async (ownerScope: string, sessionId: string) =>
      await createLocalSourceReviewJournal({
        async assertCurrentOwner() {},
        ownerScope,
        sessionId,
        stateRoot,
      });
    const reopened = await create("owner", "session");
    const otherOwner = await create("other", "session");
    const otherSession = await create("owner", "other");
    expect(await reopened.read(key)).toEqual({ kind: "split-context" });
    expect(await otherOwner.read(key)).toBeUndefined();
    expect(await otherSession.read(key)).toBeUndefined();
  });
  it("rejects relaxed permissions and symbolic link records", async () => {
    const { store, stateRoot } = await fixture();
    const key = "c".repeat(64);
    const root = path.join(stateRoot, "source-review-journal");
    const [scope] = await readdir(root);
    await symlink(path.join(stateRoot, "missing"), path.join(root, scope, `${key}.json`));
    await expect(store.read(key)).rejects.toThrow();
    await chmod(stateRoot, 0o755);
    await expect(store.read("d".repeat(64))).rejects.toThrow();
  });
  it("rejects incomplete assessments and raw evidence fields", () => {
    expect(() =>
      serializeSourceReviewRecord({
        assessment: { reviewCompleted: false },
        kind: "completed",
      }),
    ).toThrow();
    expect(() => serializeSourceReviewRecord({ kind: "split-source", source: "secret" })).toThrow();
    expect(() =>
      serializeSourceReviewRecord({
        assessment: { ...completedAssessment, reviewCompleted: false },
        kind: "application-completed",
      }),
    ).toThrow();
    expect(() =>
      serializeSourceReviewRecord({
        assessment: completedAssessment,
        kind: "application-completed",
        transcript: "private source and request text",
      }),
    ).toThrow();
    expect(() =>
      serializeSourceReviewRecord({
        assessment: { ...completedAssessment, source: "private source" },
        kind: "application-completed",
      }),
    ).toThrow();
  });
});
