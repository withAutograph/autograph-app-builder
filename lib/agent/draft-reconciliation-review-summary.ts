import type { OverlayChange } from "../repository/target-apply";

/** Response presentation target, independent of the number or size of reviewed changes. */
export const RECONCILIATION_CHANGE_PAGE_BYTES = 32 * 1024;

export interface ReconciliationChangeSummary {
  cursor: number;
  nextCursor: number | null;
  totalFiles: number;
  appOwnedFiles: number;
  nonAppFiles: number;
  counts: { added: number; modified: number; deleted: number };
  changes: OverlayChange[];
}

const changeMetadata = (change: OverlayChange): OverlayChange => ({
  kind: change.kind,
  path: change.path,
  ...(change.before === undefined
    ? {}
    : { before: { digest: change.before.digest, mode: change.before.mode } }),
  ...(change.after === undefined
    ? {}
    : { after: { digest: change.after.digest, mode: change.after.mode } }),
});

/** Optional change-index pages retain every path and never decide review or publication eligibility. */
export const summarizeReconciliationChanges = (
  changes: readonly OverlayChange[],
  appId: string,
  cursor = 0,
): ReconciliationChangeSummary => {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > changes.length) {
    throw new RangeError("The reconciliation change cursor is outside this inventory.");
  }
  const counts = { added: 0, modified: 0, deleted: 0 };
  let appOwnedFiles = 0;
  for (const change of changes) {
    counts[change.kind] += 1;
    if (change.path.startsWith(`apps/${appId}/`)) {
      appOwnedFiles += 1;
    }
  }
  const page: ReconciliationChangeSummary = {
    cursor,
    nextCursor: null,
    totalFiles: changes.length,
    appOwnedFiles,
    nonAppFiles: changes.length - appOwnedFiles,
    counts,
    changes: [],
  };
  for (let index = cursor; index < changes.length; index += 1) {
    const change = changes[index];
    page.changes.push(changeMetadata(change));
    page.nextCursor = index + 1 < changes.length ? index + 1 : null;
    if (
      Buffer.byteLength(JSON.stringify(page), "utf-8") > RECONCILIATION_CHANGE_PAGE_BYTES &&
      page.changes.length > 1
    ) {
      page.changes.pop();
      page.nextCursor = index;
      break;
    }
    // One indivisible metadata entry can exceed the target; return it intact and advance.
  }
  return page;
};
