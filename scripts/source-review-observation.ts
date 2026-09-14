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
  findings: z.array(z.object({ citations: z.array(citationSchema) })).default([]),
  modelId: z
    .string()
    .regex(/^openai\/gpt-[a-z0-9.-]+$/u)
    .optional(),
  reviewCompleted: z.boolean(),
  status: z.enum(["failed", "passed", "unavailable"]),
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
const inputSchema = z.object({ implementationFiles: z.array(jsonSchema).optional() });
const fragmentSchema = z.object({
  args: jsonSchema.optional(),
  input: jsonSchema.optional(),
  name: z.string().optional(),
  output: jsonSchema.optional(),
  result: jsonSchema.optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
});
const wrapperSchema = z.object({ type: z.literal("json"), value: jsonSchema });
type Fragment = z.infer<typeof fragmentSchema>;
interface ToolObservation {
  callDigest?: string;
  implementationWriteCount?: number;
  sourceAssessment?: z.infer<typeof assessmentSchema>;
  status: string;
  tool: string;
}

/** Parse retained data only; tagged classes are never instantiated. */
export const decodeOwnerGraph = (serialized: string): Json => {
  const values = graphSchema.parse(JSON.parse(serialized));
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

const readFragment = (fragment: Fragment): ToolObservation | undefined => {
  const tool = fragment.toolName ?? fragment.name;
  if (tool !== "accept_change_set" && tool !== "validate_app_creation") {
    return undefined;
  }
  const raw = fragment.output ?? fragment.result;
  const wrapper = wrapperSchema.safeParse(raw);
  const output = outputSchema.safeParse(wrapper.success ? wrapper.data.value : raw);
  const input = inputSchema.safeParse(fragment.input ?? fragment.args);
  return {
    callDigest: fragment.toolCallId === undefined ? undefined : hash(fragment.toolCallId),
    implementationWriteCount: input.success ? input.data.implementationFiles?.length : undefined,
    sourceAssessment: output.success ? output.data.sourceAssessment : undefined,
    status: output.success ? (output.data.status ?? "unassessed") : "unassessed",
    tool,
  };
};

export const observeSourceReviews = (originalRequest: string | undefined, records: Json[]) => {
  const rows: ToolObservation[] = [];
  const paired = new Map<string, ToolObservation>();
  const seen = new Set<Json>();
  const retain = (row: ToolObservation) => {
    const key = row.callDigest === undefined ? undefined : `${row.tool}:${row.callDigest}`;
    const previous = key === undefined ? undefined : paired.get(key);
    if (previous === undefined) {
      rows.push(row);
      if (key !== undefined) {
        paired.set(key, row);
      }
    } else {
      previous.implementationWriteCount ??= row.implementationWriteCount;
      previous.sourceAssessment ??= row.sourceAssessment;
      if (previous.status === "unassessed") {
        previous.status = row.status;
      }
    }
  };
  const visit = (value: Json, depth = 0): void => {
    if (depth > 80 || seen.has(value)) {
      return;
    }
    seen.add(value);
    const text = z.string().max(4_000_000).regex(/^[[{]/u).safeParse(value);
    if (text.success) {
      try {
        visit(jsonSchema.parse(JSON.parse(text.data)), depth + 1);
      } catch {
        // Private non-JSON text is ignored.
      }
      return;
    }
    const fragment = fragmentSchema.safeParse(value);
    const row = fragment.success ? readFragment(fragment.data) : undefined;
    if (row !== undefined) {
      retain(row);
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, depth + 1);
      }
      return;
    }
    const dictionary = dictionarySchema.safeParse(value);
    if (dictionary.success) {
      for (const child of Object.values(dictionary.data)) {
        visit(child, depth + 1);
      }
    }
  };
  for (const record of records) {
    visit(record);
  }
  return {
    kind: "owner-source-review-observation/v1",
    limits: [
      "Observation only; no internal tools invoked or runtime behavior credited.",
      "Request digest binds supplied original request; owner-event request equivalence is not inferred.",
      "Rows pair only matching tool call IDs. Chronological adjacency or later evidence digests do not prove causal repair.",
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
