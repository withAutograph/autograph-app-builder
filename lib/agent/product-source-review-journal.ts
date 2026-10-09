import { z } from "zod";
import type { ProductSourceAssessment } from "./product-source-review";

export const sourceReviewPairKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string();
const digest = sourceReviewPairKeySchema;
const citation = z
  .strictObject({
    endLine: z.number().int().positive(),
    excerptDigest: digest,
    path: text,
    startLine: z.number().int().positive(),
  })
  .refine((value) => value.endLine >= value.startLine);
export const completedSourceAssessmentSchema = z.strictObject({
  basis: z.literal("source-review"),
  bindingDigest: digest,
  evidenceDigest: digest,
  evidenceNote: text,
  findings: z.array(
    z.strictObject({
      citations: z.array(citation).min(1),
      explanation: text,
      repair: text,
      requirement: text,
      requirementQuoteDigest: digest,
    }),
  ),
  modelId: text,
  omissions: z.array(text),
  reason: text,
  remainingRuntimeChecks: z.array(text),
  reviewCompleted: z.literal(true),
  status: z.enum(["failed", "unassessed"]),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export const sourceReviewJournalRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ assessment: completedSourceAssessmentSchema, kind: z.literal("completed") }),
  z.strictObject({ kind: z.literal("split-source") }),
  z.strictObject({ kind: z.literal("split-context") }),
]);
export type SourceReviewJournalRecord =
  | { kind: "completed"; assessment: ProductSourceAssessment }
  | { kind: "split-source" | "split-context" };
export interface SourceReviewJournal {
  read: (key: string) => Promise<SourceReviewJournalRecord | undefined>;
  put: (key: string, record: SourceReviewJournalRecord) => Promise<SourceReviewJournalRecord>;
}
/** Closed records contain validated sanitized conclusions and digest references only. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable records are validated by the closed schema before serialization.
export const serializeSourceReviewRecord = (record: unknown): string =>
  JSON.stringify(sourceReviewJournalRecordSchema.parse(record));
