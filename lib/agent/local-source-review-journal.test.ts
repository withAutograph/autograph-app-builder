import { chmod, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSourceReviewJournal } from "./local-source-review-journal";
import { serializeSourceReviewRecord } from "./product-source-review-journal";

const roots: string[] = [];
const fixture = async (ownerScope = "owner", sessionId = "session") => {
  const stateRoot = await realpath(await mkdtemp(path.join(tmpdir(), "source-review-journal-")));
  roots.push(stateRoot);
  return {
    stateRoot,
    store: await createLocalSourceReviewJournal({
      async assertCurrentOwner() {},
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
  });
});
