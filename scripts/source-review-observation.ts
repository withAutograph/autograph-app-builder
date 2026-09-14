import { createHash } from "node:crypto";
import { z } from "zod";

const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;
const graphSchema = z.array(jsonSchema);
const dictionarySchema = z.record(z.string(), jsonSchema);
const referenceSchema = z.number().int();
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
    status: z.string(),
    stepIndex: countSchema,
    turnId: z.string(),
  }),
  type: z.literal("action.result"),
});
interface ToolObservation {
  callDigest?: string;
  sourceAssessment?: z.infer<typeof assessmentSchema>;
  status: string;
  tool: string;
}

/** Parse retained data only; tagged classes are never instantiated. */
export const decodeOwnerGraph = (serialized: string): Json => {
  const parsed = z.union([graphSchema, z.literal(-1)]).parse(JSON.parse(serialized));
  if (parsed === -1) {
    return null;
  }
  const values = parsed;
  const cache = new Map<number, Json>();
  const resolveReference = (index: number, depth = 0): Json => {
    if (depth > 100) {
      throw new Error("unsupported graph depth");
    }
    if (index < 0) {
      return null;
    }
    if (!Number.isInteger(index) || index >= values.length) {
      throw new Error("invalid graph reference");
    }
    const cached = cache.get(index);
    if (cached !== undefined) {
      return cached;
    }
    const value = values[index];
    if (value === undefined) {
      throw new Error("missing graph value");
    }
    if (Array.isArray(value)) {
      // Tagged classes are outside the supported plain-data observation scope.
      if (z.string().safeParse(value[0]).success) {
        return null;
      }
      const result: Json[] = [];
      cache.set(index, result);
      for (const child of value) {
        result.push(resolveReference(referenceSchema.parse(child), depth + 1));
      }
      return result;
    }
    const dictionary = dictionarySchema.safeParse(value);
    if (!dictionary.success) {
      return value;
    }
    const result: z.infer<typeof dictionarySchema> = {};
    cache.set(index, result);
    for (const [key, child] of Object.entries(dictionary.data)) {
      Object.defineProperty(result, key, {
        enumerable: true,
        value: resolveReference(referenceSchema.parse(child), depth + 1),
      });
    }
    return result;
  };
  return resolveReference(0);
};

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
        sourceAssessment: output.success ? output.data.sourceAssessment : undefined,
        status: output.success ? (output.data.status ?? "unassessed") : "unassessed",
        tool: result.toolName,
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
