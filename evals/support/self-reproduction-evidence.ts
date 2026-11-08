import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const redactedPrefix = "$<prefix>[REDACTED]";

export const evidencePrefix = "SELF_REPRODUCTION_EVIDENCE ";

// Apply to structured receipts and native diagnostics before persistence. Never
// serialize the runtime environment or session continuation credentials.
export function sanitizeEvidence(value: string): string;
// oxlint-disable-next-line anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters -- Preserve arbitrary evidence values while redacting them. Preserve the existing unknown input contract.
export function sanitizeEvidence(value: unknown): unknown;
// eslint-disable-next-line eslint/func-style, anti-slop/no-unknown-returns -- Preserve arbitrary evidence values while redacting them. Preserve function declaration hoisting and initialization timing.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
export function sanitizeEvidence(value: unknown): unknown {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof value === "object" && value !== null) {
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

// eslint-disable-next-line eslint/func-style, anti-slop/no-unsafe-dictionary-type -- Preserve function declaration hoisting and initialization timing.; Preserve the existing open-ended value contract.
export function evidenceCompletion(exitCode: number | null, records: Record<string, unknown>[]) {
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
export function evidenceSink(
  logPath: string,
  transcriptPath: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  records: Record<string, unknown>[],
) {
  let pending = "";
  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function line(raw: string) {
    appendFileSync(logPath, `${sanitizeEvidence(raw)}\n`, { mode: 0o600 });
    const start = raw.indexOf(evidencePrefix);
    if (start === -1) {
      return;
    }
    try {
      const record = sanitizeEvidence(
        JSON.parse(raw.slice(start + evidencePrefix.length)),
        // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
      ) as Record<string, unknown>;
      if (
        !record ||
        Array.isArray(record) ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
        typeof record !== "object" ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
        typeof record.kind !== "string"
      ) {
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
      if (pending) {
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function changeSetStatusOutput(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  record: Record<string, unknown>,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
): Record<string, unknown> | undefined {
  const event = record.event as
    | {
        type?: unknown;
        data?: {
          toolName?: unknown;
          // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
          result?: { toolName?: unknown; output?: unknown } | Record<string, unknown>;
        };
      }
    | undefined;
  if (event?.type !== "action.result" || !event.data?.result) {
    return undefined;
  }
  const { toolName: resultToolName } = event.data.result;
  if (resultToolName === "change-set-status" || resultToolName === "change_set_status") {
    const { output } = event.data.result;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    return typeof output === "object" && output !== null && !Array.isArray(output)
      ? // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
        (output as Record<string, unknown>)
      : undefined;
  }
  const { toolName } = event.data;
  return toolName === "change-set-status" || toolName === "change_set_status"
    ? event.data.result
    : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function candidateExportProvenanceFromEvidence(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  records: readonly Record<string, unknown>[],
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function candidateExportFromEvidence(
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  records: readonly Record<string, unknown>[],
): CandidateExportFile[] | undefined {
  for (const record of records.toReversed()) {
    const files = changeSetStatusOutput(record)?.exportFiles;
    if (!Array.isArray(files) || files.length === 0) {
      continue;
    }
    const validated: CandidateExportFile[] = [];
    const paths = new Set<string>();
    for (const file of files) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
      if (typeof file !== "object" || file === null || Array.isArray(file)) {
        return undefined;
      }
      const { path, content } = file as { path?: unknown; content?: unknown };
      if (
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
        typeof path !== "string" ||
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
        typeof content !== "string" ||
        path.startsWith("/") ||
        path.includes("\\")
      ) {
        return undefined;
      }
      if (
        path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
        paths.has(path)
      ) {
        return undefined;
      }
      paths.add(path);
      validated.push({ content, path });
    }
    const appRoots = new Set(
      validated.flatMap((file) => {
        const match = /^(?<appRoot>apps\/[^/]+)\/next\.config\.(?:[cm]?[jt]s)$/u.exec(file.path);
        const appRoot = match?.groups?.appRoot;
        return appRoot !== undefined && appRoot !== "" ? [appRoot] : [];
      }),
    );
    if (appRoots.size === 1) {
      const [appRoot] = appRoots;
      const prefix = `${appRoot}/`;
      return validated
        .flatMap((file) =>
          file.path.startsWith(prefix) ? [{ ...file, path: file.path.slice(prefix.length) }] : [],
        )
        .toSorted((left, right) => left.path.localeCompare(right.path));
    }
    return validated.toSorted((left, right) => left.path.localeCompare(right.path));
  }
  return undefined;
}
