const controlCharacters = /\p{Cc}/gu;
const urls = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu;
const bearerValues = /\bBearer\s+[^\s,;]+/giu;
const jwtValues = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu;
const sensitiveAssignments =
  /\b(?<key>[A-Za-z0-9_.-]*(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|signing[-_]?key|credential|database[-_]?url|connection[-_]?string)[A-Za-z0-9_.-]*)\b(?<separator>\s*[:=]\s*)(?<value>"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/giu;
const standaloneCredentials =
  /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu;
const structuredOutputRedacted = "[structured output redacted]";

const structuredStart = (line: string): number | undefined => {
  const openingDelimiter = (from: number): number | undefined => {
    const brace = line.indexOf("{", from);
    const bracket = line.indexOf("[", from);
    if (brace === -1) {
      return bracket === -1 ? undefined : bracket;
    }
    if (bracket === -1) {
      return brace;
    }
    return Math.min(brace, bracket);
  };

  const first = line.search(/\S/u);
  if (first >= 0 && (line[first] === "{" || line[first] === "[")) {
    return first;
  }

  const label = /\b(?:payload|receipt|response|body|details|error)\b/iu.exec(line);
  if (label) {
    const labeledPayload = openingDelimiter(label.index + label[0].length);
    if (labeledPayload !== undefined) {
      return labeledPayload;
    }
  }

  const colon = /:\s*/u.exec(line);
  if (colon) {
    const colonPayload = openingDelimiter(colon.index + colon[0].length);
    if (colonPayload !== undefined) {
      return colonPayload;
    }
  }
  return undefined;
};

interface StructuredScanState {
  depth: number;
  escaped: boolean;
  quote: "'" | '"' | null;
}

const scanStructuredCharacter = (character: string, state: StructuredScanState): boolean => {
  if (state.quote !== null) {
    if (state.escaped) {
      state.escaped = false;
    } else if (character === "\\") {
      state.escaped = true;
    } else if (character === state.quote) {
      state.quote = null;
    }
  } else if (character === '"' || character === "'") {
    state.quote = character;
  } else if (character === "{" || character === "[") {
    state.depth += 1;
  } else if (character === "}" || character === "]") {
    state.depth -= 1;
  }
  return state.depth === 0;
};

const structuredEndLine = (
  lines: string[],
  startLine: number,
  startColumn: number,
): number | undefined => {
  const state: StructuredScanState = { depth: 0, escaped: false, quote: null };
  for (let lineIndex = startLine; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const columnStart = lineIndex === startLine ? startColumn : 0;
    for (let column = columnStart; column < line.length; column += 1) {
      if (scanStructuredCharacter(line[column], state)) {
        return lineIndex;
      }
    }
  }
  return undefined;
};

const removeStructuredPayloads = (value: string): string => {
  const lines = value.split("\n");
  const safeLines: string[] = [];
  let skipThroughLine = -1;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lineIndex > skipThroughLine) {
      const line = lines[lineIndex];
      const start = structuredStart(line);
      if (start === undefined) {
        safeLines.push(line);
      } else {
        safeLines.push(structuredOutputRedacted);
        const endLine = structuredEndLine(lines, lineIndex, start);
        if (endLine === undefined) {
          break;
        }
        skipThroughLine = endLine;
      }
    }
  }
  return safeLines.join("\n");
};

const terminalStyle = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

/** Only the compiler's server-selected task decorator is metadata, not payload. */
const compilerTaskOutput = (value: string): string =>
  value
    .replaceAll(terminalStyle, "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      const prefix = "[app:compile]";
      if (!trimmed.startsWith(prefix)) {
        return line;
      }
      const body = trimmed.slice(prefix.length);
      return body === "" || /^[ \t]/u.test(body) ? body.slice(1) : line;
    })
    .join("\n");

/** Keep command diagnostics useful while excluding URLs, credentials, tokens, and structured payloads. */
export const safeCommandOutput = (
  value: string,
  options?: { taskLabel: "app:compile" },
): string => {
  const diagnostic = options?.taskLabel === "app:compile" ? compilerTaskOutput(value) : value;
  const cleaned = removeStructuredPayloads(
    diagnostic.replaceAll(controlCharacters, (character) =>
      character === "\n" || character === "\t" ? character : "",
    ),
  )
    .replaceAll(urls, "[URL REDACTED]")
    .replaceAll(bearerValues, "Bearer [REDACTED]")
    .replaceAll(jwtValues, "[JWT REDACTED]")
    .replaceAll(sensitiveAssignments, "$<key>$<separator>[REDACTED]")
    .replaceAll(standaloneCredentials, "[REDACTED]");

  return cleaned
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("{") ||
        /^\[\s*(?:\{|\]|"|-?\d|true\b|false\b|null\b)/u.test(trimmed)
      ) {
        return structuredOutputRedacted;
      }
      return line.replaceAll(
        /\b(?:payload|receipt|response|body)\s*[:=]\s*[{[][^\n]*/giu,
        structuredOutputRedacted,
      );
    })
    .join("\n")
    .trim();
};

export interface BoundedCommandDiagnostic {
  diagnostic: string;
  length: number;
  present: boolean;
  truncated: boolean;
}

/** A bounded diagnostic is a summary, never a transcript of command output. */
export const boundedCommandDiagnostic = (
  value: string,
  maximumLength = 800,
): BoundedCommandDiagnostic => {
  const safe = safeCommandOutput(value);
  const truncated = safe.length > maximumLength;
  const diagnostic = truncated ? `${safe.slice(0, maximumLength)}… [truncated]` : safe;
  return { diagnostic, length: safe.length, present: safe.length > 0, truncated };
};
