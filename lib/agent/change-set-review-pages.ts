import { createHash } from "node:crypto";

import {
  EVE_NATIVE_RESULT_PAGE_BYTES,
  largestUtf8PayloadChunk,
  serializedNativeActionResultBytes,
  fitOutputNativeFrame,
} from "../eve/payload-envelope";
import type { NativeActionResultMetadata } from "../eve/payload-envelope";
import type { NormalizedChangeSet } from "../repository/reviewed-change-set";
import type { OverlayChange } from "../repository/target-apply";

export interface ChangeSetReviewCursor {
  digest: string;
  offsetBytes: number;
  path: string;
  side?: "before" | "after";
  changeIndex?: number;
  changeSetDigest?: string;
}

export interface ChangeSetReviewPage {
  digest: string;
  changedContentDigest: string;
  postTreeDigest: string;
  preTreeDigest: string;
  sourceSha: string;
  sourceTree: string;
  sourceReceiptDigest: string;
  validationDigest: string;
  totalChanges: number;
  reviewed: boolean;
  contentSide: "before" | "after";
  reviewReference: { kind: "current-session-change-set"; digest: string; sessionId: string };
  publicationDestination?: {
    branch: string;
    headSha: string;
    headTree: string;
    repository: string;
  };
  changes: readonly OverlayChange[];
  approvedPaths: readonly string[];
  absentPaths: readonly string[];
  exportFiles: readonly { content: string; digest: string; offsetBytes: number; path: string }[];
  exportOmissions: readonly { path: string; reason: string }[];
  contentCursor?: ChangeSetReviewCursor;
}

export interface ChangeSetReviewPageInput {
  changeSet: Pick<
    NormalizedChangeSet,
    | "digest"
    | "changedContentDigest"
    | "postTreeDigest"
    | "preTreeDigest"
    | "sourceSha"
    | "sourceTree"
    | "sourceReceiptDigest"
    | "validationDigest"
    | "changes"
  >;
  sessionId: string;
  metadata: NativeActionResultMetadata;
  side: "before" | "after";
  reviewed: boolean;
  includeContent: boolean;
  cursor?: ChangeSetReviewCursor;
  publicationDestination?: ChangeSetReviewPage["publicationDestination"];
  readText: (path: string) => Promise<string | null>;
  isTextPath: (path: string) => boolean;
  maxBytes?: number;
}

/** Resolve every continuation within the current owner/session change set. */
export const resolveChangeSetReviewCursor = (
  input: Pick<ChangeSetReviewPageInput, "changeSet" | "cursor" | "side">,
) => {
  if (input.cursor === undefined) {
    return { index: 0, offsetBytes: 0 };
  }
  const { cursor } = input;
  if ((cursor.side ?? "after") !== input.side) {
    throw new Error(
      "The review cursor belongs to the other content side. Start this side from its first page.",
    );
  }
  if (cursor.changeSetDigest !== undefined && cursor.changeSetDigest !== input.changeSet.digest) {
    throw new Error(
      "The review cursor belongs to a changed review. Start the current side from its first page.",
    );
  }
  const index =
    cursor.changeIndex ??
    input.changeSet.changes.findIndex((change) => change.path === cursor.path);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    input.changeSet.changes[index]?.path !== cursor.path
  ) {
    throw new Error("The review cursor no longer identifies its recorded change path.");
  }
  if (!Number.isSafeInteger(cursor.offsetBytes) || cursor.offsetBytes < 0) {
    throw new Error("The review cursor byte offset is invalid.");
  }
  if (cursor.changeSetDigest !== undefined) {
    const change = input.changeSet.changes[index];
    const file = input.side === "before" ? change?.before : change?.after;
    if (cursor.digest !== (file?.digest ?? input.changeSet.digest)) {
      throw new Error("The review cursor digest no longer matches its immutable change side.");
    }
  }
  return { index, offsetBytes: cursor.offsetBytes };
};

const continuation = (
  input: ChangeSetReviewPageInput,
  index: number,
  offsetBytes = 0,
): ChangeSetReviewCursor | undefined => {
  const change = input.changeSet.changes[index];
  if (change === undefined) {
    return undefined;
  }
  const file = input.side === "before" ? change.before : change.after;
  return {
    changeIndex: index,
    changeSetDigest: input.changeSet.digest,
    digest: file?.digest ?? input.changeSet.digest,
    offsetBytes,
    path: change.path,
    side: input.side,
  };
};

const fitOrDeferReviewChange = (
  input: ChangeSetReviewPageInput,
  previous: ChangeSetReviewPage,
  candidate: ChangeSetReviewPage,
  index: number,
) => {
  const maxBytes = input.maxBytes ?? EVE_NATIVE_RESULT_PAGE_BYTES;
  if (
    serializedNativeActionResultBytes(candidate, input.metadata) > maxBytes &&
    previous.changes.length > 0
  ) {
    return {
      deferred: true,
      page: fitOutputNativeFrame(
        { ...previous, contentCursor: continuation(input, index) },
        input.metadata,
        maxBytes,
      ),
    };
  }
  return { deferred: false, page: fitOutputNativeFrame(candidate, input.metadata, maxBytes) };
};

interface ReviewChangeRead {
  input: ChangeSetReviewPageInput;
  previous: ChangeSetReviewPage;
  page: ChangeSetReviewPage;
  change: OverlayChange;
  index: number;
  offsetBytes: number;
}

const omittedChange = (read: ReviewChangeRead, reason: string) =>
  fitOrDeferReviewChange(
    read.input,
    read.previous,
    {
      ...read.page,
      exportOmissions: [...read.page.exportOmissions, { path: read.change.path, reason }],
    },
    read.index,
  );

const textChangePage = async (read: ReviewChangeRead) => {
  const { input, previous, page, change, index, offsetBytes } = read;
  const file = input.side === "before" ? change.before : change.after;
  const content = await input.readText(change.path);
  if (content === null) {
    return omittedChange(read, "changed text file could not be read");
  }
  const digest = createHash("sha256").update(content, "utf-8").digest("hex");
  if (digest !== file?.digest) {
    throw new Error(
      `Reviewed file ${change.path} changed during export. Refresh the current review.`,
    );
  }
  if (input.cursor?.path === change.path && input.cursor.digest !== digest) {
    throw new Error("The review file cursor digest does not match the recorded side.");
  }
  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (offsetBytes > contentBytes) {
    throw new Error("The review cursor byte offset is beyond its recorded file.");
  }
  if (contentBytes === 0) {
    return fitOrDeferReviewChange(
      input,
      previous,
      {
        ...page,
        exportFiles: [...page.exportFiles, { content, digest, offsetBytes: 0, path: change.path }],
      },
      index,
    );
  }
  if (offsetBytes === contentBytes) {
    return { deferred: false, page };
  }
  const firstCodePoint = Buffer.from(content, "utf-8")
    .subarray(offsetBytes, offsetBytes + 4)
    .toString("utf-8")
    .codePointAt(0);
  if (firstCodePoint === undefined) {
    throw new Error("The review cursor cannot read its next character.");
  }
  const firstCharacter = String.fromCodePoint(firstCodePoint);
  const output = (piece: string, nextOffsetBytes: number): ChangeSetReviewPage => ({
    ...page,
    contentCursor:
      nextOffsetBytes < contentBytes
        ? continuation(input, index, nextOffsetBytes)
        : continuation(input, index + 1),
    exportFiles: [...page.exportFiles, { content: piece, digest, offsetBytes, path: change.path }],
  });
  const minimum = fitOrDeferReviewChange(
    input,
    previous,
    output(firstCharacter, offsetBytes + Buffer.byteLength(firstCharacter, "utf-8")),
    index,
  );
  if (minimum.deferred) {
    return minimum;
  }
  const maxBytes = input.maxBytes ?? EVE_NATIVE_RESULT_PAGE_BYTES;
  const chunk = largestUtf8PayloadChunk({
    content,
    makePayload: output,
    maxBytes,
    measurePayloadBytes: (candidate) =>
      serializedNativeActionResultBytes(candidate, input.metadata),
    offsetBytes,
  });
  return {
    deferred: chunk.nextOffsetBytes < contentBytes,
    page: fitOutputNativeFrame(chunk.payload, input.metadata, maxBytes),
  };
};

const contentChangePage = async (read: ReviewChangeRead) => {
  const file = read.input.side === "before" ? read.change.before : read.change.after;
  if (!read.input.includeContent || file === undefined) {
    return { deferred: false, page: read.page };
  }
  if (!read.input.isTextPath(read.change.path)) {
    return omittedChange(read, "changed non-text artifact");
  }
  return await textChangePage(read);
};

/** Page the complete selected diff without an aggregate app or file ceiling. */
export const readChangeSetReviewPage = async (
  input: ChangeSetReviewPageInput,
): Promise<ChangeSetReviewPage> => {
  const maxBytes = input.maxBytes ?? EVE_NATIVE_RESULT_PAGE_BYTES;
  const start = resolveChangeSetReviewCursor(input);
  let page: ChangeSetReviewPage = {
    absentPaths: [],
    approvedPaths: [],
    changedContentDigest: input.changeSet.changedContentDigest,
    changes: [],
    contentSide: input.side,
    digest: input.changeSet.digest,
    exportFiles: [],
    exportOmissions: [],
    postTreeDigest: input.changeSet.postTreeDigest,
    preTreeDigest: input.changeSet.preTreeDigest,
    publicationDestination: input.publicationDestination,
    reviewReference: {
      digest: input.changeSet.digest,
      kind: "current-session-change-set",
      sessionId: input.sessionId,
    },
    reviewed: input.reviewed,
    sourceReceiptDigest: input.changeSet.sourceReceiptDigest,
    sourceSha: input.changeSet.sourceSha,
    sourceTree: input.changeSet.sourceTree,
    totalChanges: input.changeSet.changes.length,
    validationDigest: input.changeSet.validationDigest,
  };
  for (let { index } = start; index < input.changeSet.changes.length; index += 1) {
    const change = input.changeSet.changes[index];
    if (change === undefined) {
      throw new Error("The recorded review change is unavailable.");
    }
    const file = input.side === "before" ? change.before : change.after;
    const metadataPage = fitOrDeferReviewChange(
      input,
      page,
      {
        ...page,
        absentPaths: file === undefined ? [...page.absentPaths, change.path] : page.absentPaths,
        approvedPaths: [...page.approvedPaths, change.path],
        changes: [...page.changes, change],
        contentCursor: continuation(input, index + 1),
      },
      index,
    );
    if (metadataPage.deferred) {
      return metadataPage.page;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Cursor order is the complete owner/session review read order.
    const read = await contentChangePage({
      change,
      index,
      input,
      offsetBytes: index === start.index ? start.offsetBytes : 0,
      page: metadataPage.page,
      previous: page,
    });
    if (read.deferred) {
      return read.page;
    }
    ({ page } = read);
  }
  return fitOutputNativeFrame(page, input.metadata, maxBytes);
};
