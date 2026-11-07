import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { z } from "zod";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
interface JsonObject {
  [key: string]: JsonValue;
}
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);
type EvidenceRecord = JsonObject;
const statusEventSchema = z.looseObject({
  data: z.looseObject({
    result: z.looseObject({ output: jsonValueSchema, toolName: z.string().optional() }).optional(),
    toolName: z.string().optional(),
  }),
  type: z.string(),
});

export const evidencePrefix = "SELF_REPRODUCTION_EVIDENCE ";
const redactedPrefix = "$<prefix>[REDACTED]";

// Apply to structured receipts and native diagnostics before persistence. Never
// serialize the runtime environment or session continuation credentials.
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function sanitizeEvidence(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(/\bBearer\s+[^\s"',}]+/giu, "Bearer [REDACTED]")
      .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED JWT]")
      .replaceAll(
        /(?<prefix>[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z_]*["']?\s*[:=]\s*["']?)[^\s"',}]+/gu,
        redactedPrefix,
      )
      .replaceAll(
        /(?<prefix>["'](?:authorization|cookie|continuationToken|[^"']*(?:token|secret|password)|api[_-]?key)["']\s*:\s*["'])[^"']+/giu,
        redactedPrefix,
      )
      .replaceAll(
        /(?<prefix>[?&](?:token|key|signature|code|state|x-vercel-protection-bypass)=)[^&\s"']+/giu,
        redactedPrefix,
      );
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeEvidence);
  }
  if (value !== null && typeof value === "object") {
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
  }
  return value;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function digest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function evidenceCompletion(exitCode: number | null, records: EvidenceRecord[]) {
  if (exitCode !== 0) {
    return { reason: "Native eval failed or was interrupted.", status: "failed" };
  }
  if (!records.some((record) => record.kind === "eval-completed")) {
    return {
      reason: "Native eval exited without its completion receipt; evidence is incomplete.",
      status: "failed",
    };
  }
  if (!records.some((record) => record.kind === "event")) {
    return {
      reason: "Native eval produced no transcript/tool events; evidence is incomplete.",
      status: "failed",
    };
  }
  return { status: "completed" };
}

/** Line framing prevents credentials split across stream chunks leaking to disk. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function evidenceSink(logPath: string, transcriptPath: string, records: EvidenceRecord[]) {
  let pending = "";
  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function line(raw: string) {
    const sanitizedLine = z.string().parse(sanitizeEvidence(raw));
    appendFileSync(logPath, `${sanitizedLine}\n`, { mode: 0o600 });
    const start = raw.indexOf(evidencePrefix);
    if (start === -1) {
      return;
    }
    try {
      const parsedRecord = jsonValueSchema.safeParse(
        JSON.parse(raw.slice(start + evidencePrefix.length)),
      );
      if (!parsedRecord.success || Array.isArray(parsedRecord.data) || parsedRecord.data === null) {
        return;
      }
      const sanitizedRecord = jsonObjectSchema.safeParse(sanitizeEvidence(parsedRecord.data));
      if (!sanitizedRecord.success) {
        return;
      }
      const record = sanitizedRecord.data;
      const kind = z.string().safeParse(record.kind);
      if (!kind.success) {
        return;
      }
      records.push(record);
      appendFileSync(transcriptPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      /* Truncated native records remain diagnostic output, never success. */
    }
  }
  return {
    end() {
      if (pending.length > 0) {
        line(pending);
      }
      pending = "";
    },
    write(chunk: string) {
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    },
  };
}

export type CandidateExportFile = Readonly<{ path: string; content: string }>;

const isStatusTool = (value: JsonValue | undefined) => {
  const name = z.string().safeParse(value);
  return name.success && (name.data === "change-set-status" || name.data === "change_set_status");
};

const changeSetStatusOutput = (record: EvidenceRecord): EvidenceRecord | undefined => {
  const parsedEvent = statusEventSchema.safeParse(record.event);
  if (!parsedEvent.success || parsedEvent.data.type !== "action.result") {
    return undefined;
  }
  const { data: dataValue } = parsedEvent.data;
  const resultValue = dataValue.result;
  if (!resultValue) {
    return undefined;
  }
  const outputIsStatus = isStatusTool(resultValue.toolName);
  if (!outputIsStatus && !isStatusTool(dataValue.toolName)) {
    return undefined;
  }
  const candidate = outputIsStatus ? resultValue.output : resultValue;
  const parsed = jsonObjectSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function candidateExportProvenanceFromEvidence(
  records: readonly EvidenceRecord[],
): "native reviewed change-set-status export" | "native unreviewed validation-failed export" {
  for (const record of records.toReversed()) {
    const output = changeSetStatusOutput(record);
    if (Array.isArray(output?.exportFiles)) {
      return output?.status === "validation_failed"
        ? "native unreviewed validation-failed export"
        : "native reviewed change-set-status export";
    }
  }
  return "native reviewed change-set-status export";
}

const parseCandidateFiles = (files: JsonValue[]): CandidateExportFile[] | undefined => {
  const validated: CandidateExportFile[] = [];
  const paths = new Set<string>();
  for (const file of files) {
    const parsedFile = jsonObjectSchema.safeParse(file);
    if (!parsedFile.success) {
      return undefined;
    }
    const path = z.string().safeParse(parsedFile.data.path);
    const content = z.string().safeParse(parsedFile.data.content);
    if (!path.success || !content.success) {
      return undefined;
    }
    const filePath = path.data;
    if (
      filePath.startsWith("/") ||
      filePath.includes("\\") ||
      filePath
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      paths.has(filePath)
    ) {
      return undefined;
    }
    paths.add(filePath);
    validated.push({ content: content.data, path: filePath });
  }
  return validated;
};

const candidateAppRoots = (files: CandidateExportFile[]): Set<string> => {
  const roots = new Set<string>();
  for (const file of files) {
    const match = /^(?<appRoot>apps\/[^/]+)\/next\.config\.(?:[cm]?[jt]s)$/u.exec(file.path);
    const appRoot = z.string().safeParse(match?.groups?.appRoot);
    if (appRoot.success) {
      roots.add(appRoot.data);
    }
  }
  return roots;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function candidateExportFromEvidence(
  records: readonly EvidenceRecord[],
): CandidateExportFile[] | undefined {
  for (const record of records.toReversed()) {
    const files = changeSetStatusOutput(record)?.exportFiles;
    if (!Array.isArray(files) || files.length === 0) {
      continue;
    }
    const validated = parseCandidateFiles(files);
    if (!validated) {
      return undefined;
    }
    const appRoots = candidateAppRoots(validated);
    if (appRoots.size === 1) {
      const appRoot = appRoots.values().next().value;
      if (appRoot !== undefined && appRoot.length > 0) {
        const prefix = `${appRoot}/`;
        const appFiles: CandidateExportFile[] = [];
        for (const file of validated) {
          if (file.path.startsWith(prefix)) {
            appFiles.push({ ...file, path: file.path.slice(prefix.length) });
          }
        }
        return appFiles.toSorted((left, right) => left.path.localeCompare(right.path));
      }
    }
    return validated.toSorted((left, right) => left.path.localeCompare(right.path));
  }
  return undefined;
}
