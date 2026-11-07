import { chmod, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalPrivateComputeJournal } from "./private-compute-journal";
import type { PrivateComputeActivation } from "./private-compute-profile";

const record: PrivateComputeActivation = {
  appId: "example",
  phase: "configuring",
  profileId: "private-checks-16gib-v1",
  proposalDigest: "a".repeat(64),
  sandboxId: "same-sandbox",
  sessionId: "actual-session",
  workspaceDrive: "same-drive",
};
describe("durable private compute resource journal", () => {
  it("awaits immutable persistence, rehydrates pending intent in a new instance, and denies stale/competing CAS", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "private-compute-journal-"));
    const root = await realpath(temporary);
    await chmod(root, 0o700);
    const input = {
      assertCurrent: () => {},
      authority: { kind: "local" as const, ownerUid: process.getuid?.() ?? -1, stateRoot: root },
      sandboxId: record.sandboxId,
      workspaceDrive: "same-drive",
    };
    try {
      const first = await createLocalPrivateComputeJournal(input);
      const empty = await first.read();
      await first.append(record, empty);
      const restarted = await createLocalPrivateComputeJournal(input);
      const restartedRead = await restarted.read();
      expect(restartedRead.record).toEqual(record);
      await expect(
        restarted.append({ ...record, proposalDigest: "b".repeat(64) }, empty),
      ).rejects.toThrow("advanced");
      const current = await restarted.read();
      const third = await createLocalPrivateComputeJournal(input);
      const writes = await Promise.allSettled([
        restarted.append({ ...record, phase: "resuming" }, current),
        third.append({ ...record, phase: "resuming" }, current),
      ]);
      expect(writes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(writes.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const next = await createLocalPrivateComputeJournal(input);
      const nextRead = await next.read();
      expect(nextRead.revision).toBe(2);
      await expect(
        createLocalPrivateComputeJournal({
          ...input,
          authority: { ...input.authority, ownerUid: input.authority.ownerUid + 1 },
        }),
      ).rejects.toThrow("another local owner");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
