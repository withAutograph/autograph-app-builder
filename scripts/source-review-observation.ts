import { createHash } from "node:crypto";
import { z } from "zod";

const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const countSchema = z.number().int().nonnegative();
const citationSchema = z.object({
  endLine: countSchema.optional(),
  excerptDigest: digestSchema.optional(),
  path: z.string().transform(hash),
  startLine: countSchema.optional(),
});
const assessmentSchema = z.object({
  bindingDigest: digestSchema.optional(),
  evidenceDigest: digestSchema.optional(),
  findings: z
    .array(
      z.object({
        citations: z.array(citationSchema),
        requirementQuoteDigest: digestSchema.optional(),
      }),
    )
    .default([]),
  modelId: z
    .string()
    .regex(/^openai\/gpt-[a-z0-9.-]+$/u)
    .optional(),
  reviewCompleted: z.boolean(),
  status: z.enum(["failed", "unassessed", "blocked"]),
  usage: z
    .object({
      inputTokens: countSchema.optional(),
      outputTokens: countSchema.optional(),
      totalTokens: countSchema.optional(),
    })
    .optional(),
});
const outputSchema = z.object({
  sourceAssessment: assessmentSchema.optional(),
  status: z.enum(["failed", "passed", "validated", "reviewed", "unavailable"]).optional(),
});
const actionResultSchema = z.object({
  data: z.object({
    result: z.object({
      callId: z.string(),
      kind: z.literal("tool-result"),
      output: jsonSchema,
      toolName: z.string(),
    }),
    sequence: countSchema,
    status: z.enum(["completed", "failed", "rejected"]),
    stepIndex: countSchema,
    turnId: z.string(),
  }),
  type: z.literal("action.result"),
});
interface ToolObservation {
  callDigest: string;
  turnDigest: string;
  sequence: number;
  stepIndex: number;
  runtimeStatus: "completed" | "failed" | "rejected";
  sourceAssessment?: z.infer<typeof assessmentSchema>;
  status: string;
  tool: string;
}

export const decodeOwnerStreamChunk = (bytes: Buffer): Json => {
  if (
    bytes[0] !== 0 ||
    bytes.readUInt32BE(1) !== bytes.length - 5 ||
    bytes.subarray(5, 9).toString() !== "devl"
  ) {
    throw new Error("unsupported stream frame");
  }
  const frame = z
    .tuple([z.tuple([z.literal("Uint8Array"), z.literal(1)]), z.string()])
    .parse(JSON.parse(bytes.subarray(9).toString()));
  return jsonSchema.parse(JSON.parse(Buffer.from(frame[1], "base64").toString()));
};

export const observeSourceReviews = (originalRequest: string | undefined, records: Json[]) => {
  const rows: ToolObservation[] = [];
  const paired = new Map<string, ToolObservation>();
  for (const record of records) {
    // Only direct runtime stream envelopes qualify. Never traverse inputs/messages or parse embedded text.
    const parsed = actionResultSchema.safeParse(record);
    if (parsed.success) {
      const { result } = parsed.data.data;

      const key = `${parsed.data.data.turnId}:${result.toolName}:${result.callId}`;
      if (
        paired.has(key) ||
        (result.toolName !== "accept_change_set" && result.toolName !== "validate_app_creation")
      ) {
        continue;
      }
      const output = outputSchema.safeParse(result.output);
      const row: ToolObservation = {
        callDigest: hash(result.callId),
        runtimeStatus: parsed.data.data.status,
        sequence: parsed.data.data.sequence,
        sourceAssessment: output.success ? output.data.sourceAssessment : undefined,
        status: output.success ? (output.data.status ?? "unassessed") : "unassessed",
        stepIndex: parsed.data.data.stepIndex,
        tool: result.toolName,
        turnDigest: hash(parsed.data.data.turnId),
      };
      paired.set(key, row);
      rows.push(row);
    }
  }
  return {
    kind: "owner-source-review-observation/v1",
    limits: [
      "Observation only; no internal tools invoked or runtime behavior credited.",
      "Request digest binds supplied original request; owner-event request equivalence is not inferred.",
      "Only direct canonical action.result envelopes qualify; turn and call IDs bind results. Input/write counts are unassessed without a supported runtime request envelope.",
      "Missing results, writes or source assessments remain unassessed; no source, messages, URLs or tokens exported.",
      "Tagged graph classes are not revived; only plain retained data is supported.",
    ],
    originalRequestDigest: originalRequest === undefined ? undefined : hash(originalRequest),
    rows,
    status:
      originalRequest !== undefined &&
      rows.some((row) => row.sourceAssessment?.reviewCompleted === true)
        ? "observed"
        : "unassessed",
  };
};
