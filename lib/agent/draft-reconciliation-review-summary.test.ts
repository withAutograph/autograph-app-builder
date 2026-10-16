import { describe, expect, it } from "vitest";

import type { OverlayChange } from "../repository/target-apply";
import {
  RECONCILIATION_CHANGE_PAGE_BYTES,
  summarizeReconciliationChanges,
} from "./draft-reconciliation-review-summary";

const before = { digest: "a".repeat(64), mode: "644" };
const after = { digest: "b".repeat(64), mode: "755" };
const added = (path: string): OverlayChange => ({ kind: "added", path, after });
const modified = (path: string): OverlayChange => ({ kind: "modified", path, before, after });
const deleted = (path: string): OverlayChange => ({ kind: "deleted", path, before });

const readInventory = (changes: readonly OverlayChange[], appId: string) => {
  const collected: OverlayChange[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = summarizeReconciliationChanges(changes, appId, cursor);
    expect(Buffer.byteLength(JSON.stringify(page), "utf-8")).toBeLessThanOrEqual(
      RECONCILIATION_CHANGE_PAGE_BYTES,
    );
    expect(page.totalFiles).toBe(changes.length);
    expect(page.changes.length).toBeGreaterThan(0);
    collected.push(...page.changes);
    if (page.nextCursor !== null) {
      expect(page.nextCursor).toBeGreaterThan(cursor);
      expect(page.nextCursor).toBe(cursor + page.changes.length);
    }
    cursor = page.nextCursor;
  }
  return collected;
};

describe("reconciliation review metadata pages", () => {
  it("reports the complete small inventory and exact ownership and kind counts", () => {
    const changes = [
      added("apps/custom-app/app/page.tsx"),
      modified("packages/shared/runtime.ts"),
      deleted("apps/custom-app-old/removed.ts"),
    ];
    expect(summarizeReconciliationChanges(changes, "custom-app")).toEqual({
      cursor: 0,
      nextCursor: null,
      totalFiles: 3,
      appOwnedFiles: 1,
      nonAppFiles: 2,
      counts: { added: 1, modified: 1, deleted: 1 },
      changes,
    });
  });

  it("bounds a huge inventory and makes every entry available through optional index pages", () => {
    const changes = Array.from({ length: 12_000 }, (_, index) => {
      const path = `${index % 2 === 0 ? "apps/custom-app" : "packages/platform"}/file-${index}.ts`;
      if (index % 3 === 0) {
        return added(path);
      }
      if (index % 3 === 1) {
        return modified(path);
      }
      return deleted(path);
    });
    const first = summarizeReconciliationChanges(changes, "custom-app");
    expect(first.changes.length).toBeLessThan(changes.length);
    expect(first).toMatchObject({
      cursor: 0,
      totalFiles: 12_000,
      appOwnedFiles: 6000,
      nonAppFiles: 6000,
      counts: { added: 4000, modified: 4000, deleted: 4000 },
    });
    expect(readInventory(changes, "custom-app")).toEqual(changes);
  });

  it("retains archive, binary and platform metadata without path heuristics or raw content", () => {
    const changes = [
      added("apps/custom-app/releases/one/source.tar.gz"),
      modified("apps/custom-app/public/chart.png"),
      deleted(".config/catalog.json"),
      { ...added("packages/platform/fixture.bin"), content: "raw content must stay private" },
    ];
    const page = summarizeReconciliationChanges(changes, "custom-app");
    expect(page.appOwnedFiles).toBe(2);
    expect(page.nonAppFiles).toBe(2);
    expect(page.changes.map(({ path }) => path)).toEqual(changes.map(({ path }) => path));
    expect(page.changes[0]?.after).toEqual(after);
    expect(page.changes[1]?.before).toEqual(before);
    expect(JSON.stringify(page)).not.toContain("raw content must stay private");
  });

  it("keeps overlapping base and head inventories independent and reports inherited platform changes", () => {
    const base = [modified("apps/custom-app/server/action.ts")];
    const head = [added("packages/platform/new.ts"), ...base];
    expect(summarizeReconciliationChanges(base, "custom-app")).toMatchObject({
      totalFiles: 1,
      nonAppFiles: 0,
      changes: base,
    });
    expect(summarizeReconciliationChanges(head, "custom-app")).toMatchObject({
      totalFiles: 2,
      appOwnedFiles: 1,
      nonAppFiles: 1,
      changes: head,
    });
  });

  it("measures escaped UTF-8 presentation bytes and completes at the terminal cursor", () => {
    const changes = Array.from({ length: 100 }, (_, index) =>
      modified(`apps/custom-app/${'🙂"\\'.repeat(60)}-${index}.ts`),
    );
    expect(readInventory(changes, "custom-app")).toEqual(changes);
    expect(summarizeReconciliationChanges(changes, "custom-app", changes.length)).toMatchObject({
      cursor: changes.length,
      nextCursor: null,
      changes: [],
    });
    expect(summarizeReconciliationChanges([], "custom-app")).toMatchObject({
      totalFiles: 0,
      appOwnedFiles: 0,
      nonAppFiles: 0,
      changes: [],
      nextCursor: null,
    });
  });

  it("returns an indivisible oversized entry intact and still advances without a path gate", () => {
    const change = added(`apps/custom-app/${"x".repeat(RECONCILIATION_CHANGE_PAGE_BYTES)}.ts`);
    const changes = [change, deleted("packages/platform/old.ts")];
    const page = summarizeReconciliationChanges(changes, "custom-app");
    expect(page.changes).toEqual([change]);
    expect(page.nextCursor).toBe(1);
    expect(summarizeReconciliationChanges(changes, "custom-app", 1).changes).toEqual([changes[1]]);
  });
});
