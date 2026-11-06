import { createHash } from "node:crypto";
import { z } from "zod";
import { safeSourcePath } from "./source-path";
import { compareOverlayPaths } from "./target-apply";
import type { OverlayChange } from "./target-apply";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";

type DigestMaterial =
  | readonly OverlayChange[]
  | Omit<PublishedDraftRepairReview, "digest">
  | Omit<PublishedDraftRepairReview, "digest" | "changeSetDigest" | "reviewedByCallId">;
type CanonicalChange = OverlayChange;
const repairKind = "published-draft-repair" as const;
const hash = (value: DigestMaterial) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const file = z.strictObject({ digest, mode: z.enum(["644", "755"]) });
const change = z.strictObject({
  after: file.optional(),
  before: file.optional(),
  kind: z.enum(["added", "modified", "deleted"]),
  path: z.string().refine(safeSourcePath),
});
const schema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  appSpecDigest: digest,
  approvedPaths: z.array(z.string()),
  changeSetDigest: digest,
  changedContentDigest: digest,
  changes: z.array(change),
  digest,
  headSha: objectId,
  headTree: objectId,
  kind: z.literal(repairKind),
  originReviewDigest: digest,
  originSourceReceiptDigest: digest,
  publicationDigest: digest,
  repairSourceDigest: digest,
  resolvedTree: objectId,
  reviewedByCallId: z.string().min(1),
  validationDigest: digest,
  version: z.literal(1),
});

/** Actual validated app-only Git delta against the owned draft head, not a fresh-source apply receipt. */
export type PublishedDraftRepairReview = z.infer<typeof schema>;
export type DraftUpdateReview = ReviewedChangeSetReceipt | PublishedDraftRepairReview;
export const isPublishedDraftRepairReview = (
  review: DraftUpdateReview,
): review is PublishedDraftRepairReview => "kind" in review && review.kind === repairKind;

type Input = Omit<
  PublishedDraftRepairReview,
  | "kind"
  | "version"
  | "digest"
  | "approvedPaths"
  | "changeSetDigest"
  | "changedContentDigest"
  | "changes"
> & {
  changes: readonly OverlayChange[];
};

const inputSchema = schema.omit({
  approvedPaths: true,
  changeSetDigest: true,
  changedContentDigest: true,
  digest: true,
  kind: true,
  version: true,
});

const canonicalChanges = (changes: readonly OverlayChange[]) =>
  changes
    .map(({ kind, path, before, after }) => {
      const canonicalChange: CanonicalChange = { kind, path };
      if (before !== undefined) {
        canonicalChange.before = before;
      }
      if (after !== undefined) {
        canonicalChange.after = after;
      }
      return canonicalChange;
    })
    .toSorted((a, b) => compareOverlayPaths(a.path, b.path));

export const assertPublishedDraftRepairReview = (input: PublishedDraftRepairReview): void => {
  const review = schema.parse(input);
  const { digest: claimed, changeSetDigest, reviewedByCallId: _call, ...changeSet } = review;
  void _call;
  const validChanges = review.changes.every((entry, index) => {
    let validKind: boolean;
    if (entry.kind === "added") {
      validKind = entry.before === undefined && entry.after !== undefined;
    } else if (entry.kind === "deleted") {
      validKind = entry.before !== undefined && entry.after === undefined;
    } else {
      validKind = entry.before !== undefined && entry.after !== undefined;
    }
    const previous = review.changes[index - 1];
    const ordered = previous === undefined || compareOverlayPaths(previous.path, entry.path) < 0;
    return validKind && entry.path.startsWith(`apps/${review.appId}/`) && ordered;
  });
  const { digest: _digest, ...unsigned } = review;
  void _digest;
  const matches = [
    validChanges,
    claimed === hash(unsigned),
    changeSetDigest === hash(changeSet),
    review.changedContentDigest === hash(review.changes),
    JSON.stringify(review.approvedPaths) === JSON.stringify(review.changes.map(({ path }) => path)),
  ].every(Boolean);
  if (!matches) {
    throw new Error("The owned draft repair review is incomplete or changed.");
  }
};

export const createPublishedDraftRepairReview = (input: Input): PublishedDraftRepairReview => {
  const { changes, reviewedByCallId, ...evidence } = inputSchema.parse({
    ...input,
    changes: canonicalChanges(input.changes),
  });
  const changeSet = {
    approvedPaths: changes.map(({ path }) => path),
    changedContentDigest: hash(changes),
    changes,
    ...evidence,
    kind: repairKind,
    version: 1 as const,
  };
  const unsigned = { ...changeSet, changeSetDigest: hash(changeSet), reviewedByCallId };
  const review = schema.parse({ ...unsigned, digest: hash(unsigned) });
  assertPublishedDraftRepairReview(review);
  return review;
};
