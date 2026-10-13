import { createHash } from "node:crypto";
import type { ProductReviewSourcePage } from "./product-source-review-pages";
import type { ProductSourceReviewInput, SourceJudgment } from "./product-source-review";

/** Bound one serialized provider prompt, never the amount of review work. */
export const sourceReviewPromptBytes = 128 * 1024;
export type SourceReviewContext = NonNullable<ProductSourceReviewInput["reviewContext"]>;
export interface SourceReviewBatchPair {
  id: string;
  page: ProductReviewSourcePage;
  context: SourceReviewContext;
}
export interface SourceReviewBatch {
  appSpecDigest: string;
  sourceDigest: string;
  files: (ProductReviewSourcePage & { pageId: string })[];
  reviewContexts: (SourceReviewContext & { contextId: string })[];
  pairs: { pairId: string; pageId: string; contextId: string }[];
}
export interface SourceReviewTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
export interface SourceReviewBatchResult {
  judgments: { pairId: string; judgment: SourceJudgment }[];
  usage?: SourceReviewTokenUsage;
}
export interface SourceReviewInvocation {
  requestAttempts: number;
  successfulRequests: number;
  journalReuses: number;
  splits: number;
  requestsWithIncompleteUsage: number;
  freshUsage: Required<SourceReviewTokenUsage>;
}
/** Allowlisted, bounded response metadata; never provider content or raw usage. */
export interface SourceReviewRequest {
  modelId: string;
  sdkCallId?: string;
  responseId?: string;
  gatewayGenerationId?: string;
  usage: SourceReviewTokenUsage;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  noCacheTokens?: number;
  reasoningTokens?: number;
  textTokens?: number;
}
export const emptySourceReviewInvocation = (): SourceReviewInvocation => ({
  freshUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  journalReuses: 0,
  requestAttempts: 0,
  requestsWithIncompleteUsage: 0,
  splits: 0,
  successfulRequests: 0,
});
export const addSourceReviewUsage = (
  invocation: SourceReviewInvocation | undefined,
  usage: SourceReviewTokenUsage,
): void => {
  if (invocation === undefined) {
    return;
  }
  invocation.freshUsage.inputTokens += usage.inputTokens ?? 0;
  invocation.freshUsage.outputTokens += usage.outputTokens ?? 0;
  invocation.freshUsage.totalTokens += usage.totalTokens ?? 0;
};
const fingerprint = (value: ProductReviewSourcePage | SourceReviewContext): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** References deduplicate evidence without omitting any requested pair. */
export const createSourceReviewBatch = (
  input: Pick<ProductSourceReviewInput, "appSpecDigest" | "sourceDigest">,
  pairs: readonly SourceReviewBatchPair[],
): SourceReviewBatch => {
  const files = new Map<string, SourceReviewBatch["files"][number]>();
  const contexts = new Map<string, SourceReviewBatch["reviewContexts"][number]>();
  const references = new Map<string, SourceReviewBatch["pairs"][number]>();
  for (const pair of pairs) {
    const pageId = fingerprint(pair.page);
    const contextId = fingerprint(pair.context);
    files.set(pageId, { ...pair.page, pageId });
    contexts.set(contextId, { ...pair.context, contextId });
    references.set(pair.id, { contextId, pageId, pairId: pair.id });
  }
  // oxlint-disable-next-line eslint/sort-keys -- Stable requirement context must precede changing source for provider prompt caching.
  return {
    reviewContexts: [...contexts.values()],
    appSpecDigest: input.appSpecDigest,
    files: [...files.values()],
    sourceDigest: input.sourceDigest,
    pairs: [...references.values()],
  };
};
export const serializedSourceReviewBatchBytes = (batch: SourceReviewBatch): number =>
  Buffer.byteLength(JSON.stringify(batch), "utf-8");
