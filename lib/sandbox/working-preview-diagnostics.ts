/** Private, bounded process output only. This is diagnostic evidence, not readiness proof. */
export const workingPreviewDiagnosticCollectorSource = String.raw`
import * as previewDiagnosticFs from "node:fs";
const previewDiagnosticTails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
const appendPreviewDiagnostic = (stream, chunk) => {
  if (!launch.diagnosticsPath || !(stream in previewDiagnosticTails)) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  previewDiagnosticTails[stream] = Buffer.concat([
    previewDiagnosticTails[stream], bytes.subarray(Math.max(0, bytes.length - 4096)),
  ]).subarray(-4096);
  try {
    previewDiagnosticFs.writeFileSync(launch.diagnosticsPath, JSON.stringify({
      stdout: previewDiagnosticTails.stdout.toString("utf8"),
      stderr: previewDiagnosticTails.stderr.toString("utf8"),
    }), { mode: 0o600 });
  } catch { /* Diagnostic persistence must not crash the application supervisor. */ }
};
`;

const sanitize = (value: string): string =>
  value
    // oxlint-disable-next-line eslint/no-control-regex -- Strip terminal escape sequences from untrusted process output.
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll(/[^\t\n\r\u0020-\u007E]/gu, "")
    .replaceAll(/\b(?:https?|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/giu, "[URL REDACTED]")
    .replaceAll(/\bBearer\s+[^\s"',;]+/giu, "Bearer [REDACTED]")
    .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[JWT REDACTED]")
    .replaceAll(
      /\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|AUTHORIZATION|COOKIE)[A-Z_]*)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu,
      "[CREDENTIAL REDACTED]",
    );

/** Best-effort common-secret redaction; arbitrary application logging may still contain sensitive text. */
export const workingPreviewDiagnosticExcerpt = (content: string | null): string => {
  if (!content || content.length > 65_536) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "";
  }
  const fields = parsed as Record<string, unknown>;
  const output = [fields.stderr, fields.stdout]
    .filter((value): value is string => typeof value === "string")
    .map((value) => sanitize(value.slice(-8192)))
    .join("\n");
  return output
    .split("\n")
    .filter((line) =>
      /error|exception|failed|cannot|can't|not found|^\s+at\s|\bE[A-Z]{3,}\b/iu.test(line),
    )
    .join("\n")
    .slice(-4096)
    .trim();
};
