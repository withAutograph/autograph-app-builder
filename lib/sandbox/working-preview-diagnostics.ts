/** Private, bounded process output only. This is diagnostic evidence, not readiness proof. */
import { z } from "zod";

const previewDiagnosticPayloadSchema = z.looseObject({
  message: z.string().optional(),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
});
const previewDiagnosticStreamSchema = z.enum(["stdout", "stderr"]);

export const workingPreviewDiagnosticCollectorSource = String.raw`
import * as previewDiagnosticFs from "node:fs";
const previewDiagnosticTails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
const appendPreviewDiagnostic = (stream, chunk) => {
  if (launch.diagnosticsPath == null || launch.diagnosticsPath === "") return;
  const parsedStream = previewDiagnosticStreamSchema.safeParse(stream);
  if (!parsedStream.success) return;
  const streamName = parsedStream.data;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  previewDiagnosticTails[streamName] = Buffer.concat([
    previewDiagnosticTails[streamName], bytes.subarray(Math.max(0, bytes.length - 4096)),
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
  if (content === null || content === "" || content.length > 65_536) {
    return "";
  }
  let parsed: z.infer<typeof previewDiagnosticPayloadSchema>;
  try {
    parsed = previewDiagnosticPayloadSchema.parse(JSON.parse(content));
  } catch {
    return "";
  }
  const output = [parsed.message, parsed.stderr, parsed.stdout]
    .filter((value): value is string => value !== undefined)
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
