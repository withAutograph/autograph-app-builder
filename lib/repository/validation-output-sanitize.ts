const ansiPattern = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const sensitiveAssignmentPattern =
  /(?<name>authorization|cookie|password|passwd|secret|token|api[-_]?key)(?<separator>\s*[:=]\s*)(?<value>[^\s,;]+)/giu;
const bearerPattern = /Bearer\s+[^\s,;]+/giu;
const credentialUrlPattern = /(?<scheme>https?:\/\/)[^\s/@]+:[^\s/@]+@/giu;
const credentialPrefixPattern =
  /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu;

/** Redact complete provider output before any durable diagnostic write. */
export const sanitizeValidationDiagnosticText = (value: string): string =>
  value
    .replaceAll(ansiPattern, "")
    .replaceAll(/\p{Cc}/gu, (character) =>
      character === "\t" || character === "\n" || character === "\r" ? character : "",
    )
    .replaceAll(credentialUrlPattern, "$<scheme>[REDACTED]@")
    .replaceAll(bearerPattern, "Bearer [REDACTED]")
    .replaceAll(sensitiveAssignmentPattern, "$<name>$<separator>[REDACTED]")
    .replaceAll(credentialPrefixPattern, "[REDACTED]")
    .replaceAll(/(?:\/workspace\/repository\/)?(?=apps\/)/gu, "");
