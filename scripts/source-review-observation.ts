import { createHash } from "node:crypto";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Decode the retained devalue graph without invoking class revivers or executable code. */
export function decodeOwnerGraph(values: unknown[]): unknown {
  const cache = new Map<number, unknown>();
  function resolve(index: number, depth = 0): unknown {
    if (depth > 100) {
      throw new Error("unsupported graph depth");
    }
    if (index < 0) {
      return undefined;
    }
    if (!Number.isInteger(index) || index >= values.length) {
      throw new Error("invalid graph reference");
    }
    if (cache.has(index)) {
      return cache.get(index);
    }
    const value = values[index];
    if (Array.isArray(value)) {
      if (typeof value[0] === "string") {
        return undefined;
      } // Unsupported tagged types are not revived.
      const result: unknown[] = [];
      cache.set(index, result);
      for (const child of value) {
        result.push(resolve(child as number, depth + 1));
      }
      return result;
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      cache.set(index, result);
      for (const [key, child] of Object.entries(value)) {
        result[key] = resolve(child as number, depth + 1);
      }
      return result;
    }
    return value;
  }
  return resolve(0);
}

export function observeSourceReviews(originalRequest: string | undefined, records: unknown[]) {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const calls = new Set<string>();
  function visit(value: unknown, depth = 0) {
    if (depth > 80) {
      return;
    }
    if (typeof value === "string" && value.length < 4_000_000 && /^[[{]/u.test(value)) {
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {
        /* Non-JSON message content stays private. */
      }
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    const v = object(value);
    const name = v.toolName ?? v.name;
    if (name === "accept_change_set" || name === "validate_app_creation") {
      const key =
        typeof v.toolCallId === "string"
          ? createHash("sha256").update(v.toolCallId).digest("hex")
          : undefined;
      const rawOutput = object(v.output ?? v.result);
      const output = rawOutput.type === "json" ? object(rawOutput.value) : rawOutput;
      if (key && calls.has(key) && Object.keys(output).length === 0) {
        return;
      }
      if (key && Object.keys(output).length) {
        calls.add(key);
      }
      const assessment = object(output.sourceAssessment);
      const usage = object(assessment.usage);
      const input = object(v.input ?? v.args);
      rows.push({
        callDigest: key,
        implementationWriteCount: Array.isArray(input.implementationFiles)
          ? input.implementationFiles.length
          : undefined,
        sourceAssessment: Object.keys(assessment).length
          ? {
              status: ["failed", "passed", "unavailable"].includes(String(assessment.status))
                ? assessment.status
                : "unassessed",
              reviewCompleted: assessment.reviewCompleted === true,
              modelId:
                typeof assessment.modelId === "string" &&
                /^openai\/gpt-[a-z0-9.-]+$/u.test(assessment.modelId)
                  ? assessment.modelId
                  : undefined,
              evidenceDigest: digest(assessment.evidenceDigest),
              bindingDigest: digest(assessment.bindingDigest),
              usage: {
                inputTokens: count(usage.inputTokens),
                outputTokens: count(usage.outputTokens),
                totalTokens: count(usage.totalTokens),
              },
              citations: Array.isArray(assessment.findings)
                ? assessment.findings.flatMap((f) =>
                    Array.isArray(object(f).citations)
                      ? (object(f).citations as unknown[]).map((c) => ({
                          pathDigest:
                            typeof object(c).path === "string"
                              ? createHash("sha256")
                                  .update(String(object(c).path))
                                  .digest("hex")
                              : undefined,
                          startLine: count(object(c).startLine),
                          endLine: count(object(c).endLine),
                          excerptDigest: digest(object(c).excerptDigest),
                        }))
                      : [],
                  )
                : [],
            }
          : { status: "unassessed", reason: "No retained source assessment on this tool result." },
        status: ["failed", "passed", "validated", "reviewed", "unavailable"].includes(
          String(output.status),
        )
          ? output.status
          : "unassessed",
        tool: name,
      });
    }
    for (const child of Array.isArray(value) ? value : Object.values(v)) {
      visit(child, depth + 1);
    }
  }
  records.forEach((record) => {
    visit(record);
  });
  return {
    kind: "owner-source-review-observation/v1",
    limits: [
      "Observation only; no internal tools invoked or runtime behavior credited.",
      "Request digest binds supplied original request; owner-event request equivalence is not inferred.",
      "Chronology follows retained record order; later review digests do not prove causal repair.",
      "Missing results, writes or source assessments remain unassessed; no source, messages, URLs or tokens exported.",
    ],
    originalRequestDigest: originalRequest
      ? createHash("sha256").update(originalRequest).digest("hex")
      : undefined,
    rows,
    status:
      originalRequest && rows.some((r) => object(r.sourceAssessment).reviewCompleted === true)
        ? "observed"
        : "unassessed",
  };
}
