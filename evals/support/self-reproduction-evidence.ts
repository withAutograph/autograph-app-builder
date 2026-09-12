import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

export const evidencePrefix = "SELF_REPRODUCTION_EVIDENCE ";

// Apply to structured receipts and native diagnostics before persistence. Never
// serialize the runtime environment or session continuation credentials.
export function sanitizeEvidence(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .replaceAll(/\bBearer\s+[^\s"',}]+/giu, "Bearer [REDACTED]")
      .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED JWT]")
      .replaceAll(
        /((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|authorization|cookie|continuationToken)["']?\s*[:=]\s*["']?)[^\s"',}]+/giu,
        "$1[REDACTED]",
      )
      .replaceAll(
        /([?&](?:token|key|signature|code|state|x-vercel-protection-bypass)=)[^&\s"']+/giu,
        "$1[REDACTED]",
      );
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:authorization|cookie|set-cookie|.*(?:token|secret|password)|api[_-]?key|credentials)$/iu.test(
          key,
        )
          ? "[REDACTED]"
          : sanitizeEvidence(item),
      ]),
    );
  return value;
}

export function digest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export function evidenceCompletion(exitCode: number | null, records: Record<string, unknown>[]) {
  if (exitCode !== 0) return { status: "failed", reason: "Native eval failed or was interrupted." };
  if (!records.some((record) => record.kind === "eval-completed"))
    return {
      status: "failed",
      reason: "Native eval exited without its completion receipt; evidence is incomplete.",
    };
  if (!records.some((record) => record.kind === "event"))
    return {
      status: "failed",
      reason: "Native eval produced no transcript/tool events; evidence is incomplete.",
    };
  return { status: "completed" };
}

/** Line framing prevents credentials split across stream chunks leaking to disk. */
export function evidenceSink(
  logPath: string,
  transcriptPath: string,
  records: Record<string, unknown>[],
) {
  let pending = "";
  function line(raw: string) {
    appendFileSync(logPath, `${sanitizeEvidence(raw)}\n`, { mode: 0o600 });
    const start = raw.indexOf(evidencePrefix);
    if (start === -1) return;
    try {
      const record = sanitizeEvidence(
        JSON.parse(raw.slice(start + evidencePrefix.length)),
      ) as Record<string, unknown>;
      if (
        !record ||
        Array.isArray(record) ||
        typeof record !== "object" ||
        typeof record.kind !== "string"
      )
        return;
      records.push(record);
      appendFileSync(transcriptPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      /* Truncated native records remain diagnostic output, never success. */
    }
  }
  return {
    write(chunk: string) {
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    },
    end() {
      if (pending) line(pending);
      pending = "";
    },
  };
}

export type CandidateExportFile = Readonly<{ path: string; content: string }>;

export function candidateExportFromEvidence(
  records: readonly Record<string, unknown>[],
): CandidateExportFile[] | undefined {
  for (const record of records.toReversed()) {
    const { event } = record;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const typedEvent = event as { type?: unknown; data?: unknown };
    if (
      typedEvent.type !== "action.result" ||
      !typedEvent.data ||
      typeof typedEvent.data !== "object"
    )
      continue;
    const data = typedEvent.data as { toolName?: unknown; result?: unknown };
    if (data.toolName !== "change_set_status" || !data.result || typeof data.result !== "object")
      continue;
    const files = (data.result as { exportFiles?: unknown }).exportFiles;
    if (!Array.isArray(files) || files.length === 0) continue;
    const validated: CandidateExportFile[] = [];
    const paths = new Set<string>();
    for (const file of files) {
      if (!file || typeof file !== "object" || Array.isArray(file)) return undefined;
      const { path, content } = file as { path?: unknown; content?: unknown };
      if (
        typeof path !== "string" ||
        typeof content !== "string" ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
        paths.has(path)
      )
        return undefined;
      paths.add(path);
      validated.push({ path, content });
    }
    return validated.toSorted((left, right) => left.path.localeCompare(right.path));
  }
  return undefined;
}
