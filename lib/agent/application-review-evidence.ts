import { createHash } from "node:crypto";
import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import type { OverlaySnapshot } from "../repository/target-apply";
import { safeSourcePath } from "../repository/source-path";
import { largestUtf8PayloadChunk } from "../eve/payload-envelope";
import { ApplicationReviewSelectionError } from "./application-source-review";
import type { ApplicationReviewEvidence } from "./application-source-review";
import type { ProductSourceReviewInput } from "./product-source-review";

const requirementPageCharacters = 16 * 1024;
const defaultSourceLines = 200;
/** Per-response transport size; source files and total review work have no such ceiling. */
export const APPLICATION_REVIEW_SOURCE_PAGE_BYTES = 16 * 1024;
type SourceCursor = NonNullable<Parameters<ApplicationReviewEvidence["readSource"]>[0]["cursor"]>;

/** Retain the existing source eligibility while excluding credential/provider state. */
const readableSource = (path: string): boolean =>
  safeSourcePath(path) &&
  /\.(?:[cm]?[jt]sx?|json|css|sql|cue)$/u.test(path) &&
  !/(?:^|\/)(?:node_modules|\.next|dist|coverage|\.git|\.vercel|\.ssh|\.aws|\.eve|\.app-builder)(?:\/|$)/u.test(
    path,
  ) &&
  !/(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials\.json|secrets\.json|service-account[^/]*\.json)$/iu.test(
    path,
  );

const verifiedSourceText = async (input: {
  sandbox: Pick<SandboxSession, "readFile">;
  path: string;
  digest: string;
  abortSignal?: AbortSignal;
}): Promise<string> => {
  input.abortSignal?.throwIfAborted();
  const stream = await input.sandbox.readFile({ path: input.path });
  if (stream === null) {
    throw new Error("Requested review source is unavailable.");
  }
  const reader = stream.getReader();
  const cancel = async () => {
    try {
      await reader.cancel();
    } catch {
      /* Preserve the original Stop reason. */
    }
  };
  const onAbort = () => {
    void cancel();
  };
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  try {
    for (;;) {
      input.abortSignal?.throwIfAborted();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Source bytes must be verified in stream order before exposing evidence.
      const next = await reader.read();
      input.abortSignal?.throwIfAborted();
      if (next.done) {
        break;
      }
      hash.update(next.value);
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    if (hash.digest("hex") !== input.digest) {
      throw new Error("Requested source changed since the review observation.");
    }
    return parts.join("");
  } finally {
    input.abortSignal?.removeEventListener("abort", onAbort);
    await reader.cancel();
  }
};

const requirementPageEnd = (text: string, cursor: number): number => {
  let end = Math.min(text.length, cursor + requirementPageCharacters);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) {
    end -= 1;
  }
  return end;
};

const sourceLineStarts = (text: string): number[] => {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
};
const sourcePosition = (starts: readonly number[], offset: number) => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
};
const sourceCursorOffset = (
  text: string,
  starts: readonly number[],
  cursor: SourceCursor,
): number => {
  const { line, column } = cursor;
  const invalidCoordinates = !Number.isInteger(line) || !Number.isInteger(column);
  const outsideFile = line < 1 || line > starts.length || column < 1;
  if (invalidCoordinates || outsideFile) {
    throw new ApplicationReviewSelectionError("Source cursor is outside its observed file.");
  }
  const offset = starts[line - 1] + column - 1;
  const lineEnd = starts[line] === undefined ? text.length : starts[line] - 1;
  if (
    offset > lineEnd ||
    (/[\uDC00-\uDFFF]/u.test(text[offset] ?? "") && /[\uD800-\uDBFF]/u.test(text[offset - 1] ?? ""))
  ) {
    throw new ApplicationReviewSelectionError(
      "Source cursor is outside a Unicode character boundary.",
    );
  }
  return offset;
};
interface SourceReadWindow {
  startOffset: number;
  endOffset: number;
}
const restoredSourceReadSchema = z.object({
  kind: z.literal("source"),
  path: z.string(),
  digest: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  contentDigest: z.string(),
});
type RestoredSourceRead = z.infer<typeof restoredSourceReadSchema>;

/** Rebuild a previously observed window only from matching, freshly verified source bytes. */
const restoredReadWindow = (
  text: string,
  starts: readonly number[],
  reference: RestoredSourceRead,
): SourceReadWindow | undefined => {
  if (reference.endLine < reference.startLine || reference.endLine > starts.length) {
    return undefined;
  }
  let startOffset: number;
  try {
    startOffset = sourceCursorOffset(text, starts, {
      line: reference.startLine,
      column: reference.startColumn,
    });
  } catch (error) {
    if (error instanceof ApplicationReviewSelectionError) {
      return undefined;
    }
    throw error;
  }
  const endOffset = starts[reference.endLine - 1] + reference.endColumn - 1;
  const lineEnd = starts[reference.endLine] ?? text.length;
  if (
    endOffset < startOffset ||
    endOffset > lineEnd ||
    (/[\uDC00-\uDFFF]/u.test(text[endOffset] ?? "") &&
      /[\uD800-\uDBFF]/u.test(text[endOffset - 1] ?? ""))
  ) {
    return undefined;
  }
  const last = endOffset === startOffset ? undefined : sourcePosition(starts, endOffset - 1);
  if (
    last !== undefined &&
    (last.line !== reference.endLine || last.column + 1 !== reference.endColumn)
  ) {
    return undefined;
  }
  const digest = createHash("sha256").update(text.slice(startOffset, endOffset)).digest("hex");
  return digest === reference.contentDigest ? { startOffset, endOffset } : undefined;
};
const mergeReadWindow = (
  windows: readonly SourceReadWindow[],
  added: SourceReadWindow,
): SourceReadWindow[] => {
  const merged: SourceReadWindow[] = [];
  for (const window of [...windows, added].toSorted(
    (left, right) => left.startOffset - right.startOffset,
  )) {
    const last = merged.at(-1);
    if (last !== undefined && last.endOffset >= window.startOffset) {
      last.endOffset = Math.max(last.endOffset, window.endOffset);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
};
const matchesReadWindow = (input: {
  text: string;
  starts: readonly number[];
  windows: readonly SourceReadWindow[];
  startLine: number;
  endLine: number;
  excerpt: string;
}): boolean =>
  input.windows.some((window) => {
    const content = input.text.slice(window.startOffset, window.endOffset);
    for (
      let index = content.indexOf(input.excerpt);
      index >= 0;
      index = content.indexOf(input.excerpt, index + 1)
    ) {
      if (
        sourcePosition(input.starts, window.startOffset + index).line === input.startLine &&
        sourcePosition(input.starts, window.startOffset + index + input.excerpt.length - 1).line ===
          input.endLine
      ) {
        return true;
      }
    }
    return false;
  });

/** Missing optional baseline metadata narrows context without blocking final review. */
export const applicationReviewVisibility = (input: {
  observedPaths: readonly string[];
  changedPaths: readonly string[];
  hasSelectedBaseline: boolean;
  unexposedReleasePrefixes?: readonly string[];
}) => {
  const { unexposedReleasePrefixes } = input;
  if (!input.hasSelectedBaseline) {
    return { paths: [...input.observedPaths], omissions: [] };
  }
  if (unexposedReleasePrefixes === undefined) {
    const changed = new Set(input.changedPaths);
    return {
      paths: input.observedPaths.filter((path) => changed.has(path)),
      omissions: [
        "Selected baseline visibility metadata is unavailable; review exposes the normalized changed paths only. Unchanged baseline context remains unassessed.",
      ],
    };
  }
  return {
    paths: input.observedPaths.filter(
      (path) =>
        !unexposedReleasePrefixes.some(
          (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
        ),
    ),
    omissions: [],
  };
};

type RequirementKind = ApplicationReviewEvidence["requirements"][number]["kind"];
const requirementKind = (id: string): RequirementKind => {
  if (id === "original") {
    return "original";
  }
  if (id === "app-spec") {
    return "app-spec";
  }
  return "clarification";
};

/** Exact evidence stays process-local; model reads never receive credentials or arbitrary paths. */
export const createApplicationReviewEvidence = (input: {
  reviewInput: ProductSourceReviewInput;
  observed: OverlaySnapshot;
  changedPaths: readonly string[];
  visiblePaths: readonly string[];
  applyRoot: string;
  sandbox: Pick<SandboxSession, "readFile">;
  appSpecParts?: () => AsyncIterable<string>;
  abortSignal?: AbortSignal;
  /** Server-created source references from the same review's private durable continuation. */
  restoredSourceReads?: readonly unknown[];
}): ApplicationReviewEvidence => {
  const visible = new Set(input.visiblePaths);
  const files = input.observed.files.filter(
    (file) => visible.has(file.path) && readableSource(file.path),
  );
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const sourceText = new Map<string, Promise<string>>();
  const lineStarts = new Map<string, number[]>();
  const readWindows = new Map<string, SourceReadWindow[]>();
  const restoredReads = new Map<string, Map<string, RestoredSourceRead>>();
  for (const candidate of input.restoredSourceReads ?? []) {
    const parsed = restoredSourceReadSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    const { path, digest } = parsed.data;
    if (fileByPath.get(path)?.digest === digest) {
      const entries = restoredReads.get(path) ?? new Map<string, RestoredSourceRead>();
      entries.set(JSON.stringify(parsed.data), parsed.data);
      restoredReads.set(path, entries);
    }
  }
  const loadVerifiedSource = async (path: string, digest: string): Promise<string> => {
    const text = await verifiedSourceText({
      sandbox: input.sandbox,
      path: `${input.applyRoot.replace(/^\/workspace\//u, "")}/${path}`,
      digest,
      abortSignal: input.abortSignal,
    });
    const references = restoredReads.get(path);
    if (references !== undefined) {
      const starts = sourceLineStarts(text);
      lineStarts.set(path, starts);
      let windows: SourceReadWindow[] = [];
      for (const reference of references.values()) {
        const window = restoredReadWindow(text, starts, reference);
        if (window !== undefined) {
          windows = mergeReadWindow(windows, window);
        }
      }
      readWindows.set(path, windows);
    }
    return text;
  };
  const loadSource = (path: string): Promise<string> => {
    const file = fileByPath.get(path);
    if (file === undefined) {
      throw new ApplicationReviewSelectionError("Requested path is not available review source.");
    }
    let pending = sourceText.get(path);
    if (pending === undefined) {
      pending = loadVerifiedSource(path, file.digest);
      sourceText.set(path, pending);
    }
    return pending;
  };
  const documents = new Map<string, () => Promise<string>>();
  documents.set("original", () => Promise.resolve(input.reviewInput.originalRequest ?? ""));
  for (const [index, text] of input.reviewInput.clarifications.entries()) {
    documents.set(`clarification-${index}`, () => Promise.resolve(text));
  }
  documents.set("app-spec", async () => {
    if (input.appSpecParts === undefined) {
      return input.reviewInput.appSpec;
    }
    const parts: string[] = [];
    for await (const part of input.appSpecParts()) {
      input.abortSignal?.throwIfAborted();
      parts.push(part);
    }
    return parts.join("");
  });
  const requirementText = new Map<string, Promise<string>>();
  const loadRequirement = (id: string): Promise<string> => {
    input.abortSignal?.throwIfAborted();
    const load = documents.get(id);
    if (load === undefined) {
      throw new ApplicationReviewSelectionError("Requested requirement document is unavailable.");
    }
    let pending = requirementText.get(id);
    if (pending === undefined) {
      pending = load();
      requirementText.set(id, pending);
    }
    return pending;
  };
  return {
    changedPaths: input.changedPaths,
    sourceFiles: files,
    requirements: [...documents.keys()].map((id, order) => ({
      id,
      kind: requirementKind(id),
      order,
    })),
    async readRedactionTexts() {
      input.abortSignal?.throwIfAborted();
      const texts = await Promise.all([...documents.keys()].map((id) => loadRequirement(id)));
      input.abortSignal?.throwIfAborted();
      return texts;
    },
    async readRequirements({ id, cursor = 0 }) {
      const text = await loadRequirement(id);
      input.abortSignal?.throwIfAborted();
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) {
        throw new ApplicationReviewSelectionError(
          "Requirement cursor is outside its exact document.",
        );
      }
      const end = requirementPageEnd(text, cursor);
      return { text: text.slice(cursor, end), ...(end < text.length ? { nextCursor: end } : {}) };
    },
    async readSource({ path, startLine = 1, endLine, cursor }) {
      const text = await loadSource(path);
      input.abortSignal?.throwIfAborted();
      const starts = lineStarts.get(path) ?? sourceLineStarts(text);
      lineStarts.set(path, starts);
      const position = cursor ?? { line: startLine, column: 1 };
      const startOffset = sourceCursorOffset(text, starts, position);
      const requestedEnd = cursor?.endLine ?? endLine;
      if (
        requestedEnd !== undefined &&
        (!Number.isInteger(requestedEnd) || requestedEnd < position.line)
      ) {
        throw new ApplicationReviewSelectionError("Source range is outside its observed file.");
      }
      const lastLine = Math.min(requestedEnd ?? starts.length, starts.length);
      const rangeEnd =
        requestedEnd !== undefined && starts[lastLine] !== undefined
          ? starts[lastLine] - 1
          : text.length;
      const windowEnd = Math.min(
        rangeEnd,
        starts[position.line - 1 + defaultSourceLines] ?? text.length,
      );
      const makePayload = (content: string) => {
        const endOffset = startOffset + content.length;
        const last = content.length === 0 ? position : sourcePosition(starts, endOffset - 1);
        const next = sourcePosition(starts, endOffset);
        return {
          path,
          digest: fileByPath.get(path)?.digest ?? "",
          content,
          startLine: position.line,
          startColumn: position.column,
          // Lines are inclusive; endColumn is exclusive after the final character on endLine.
          // A terminating newline occupies the final column; nextCursor advances to the next line.
          endLine: last.line,
          endColumn: content.length === 0 ? position.column : last.column + 1,
          totalLines: starts.length,
          ...(endOffset < rangeEnd
            ? {
                nextCursor: {
                  ...next,
                  ...(requestedEnd === undefined ? {} : { endLine: requestedEnd }),
                },
              }
            : {}),
        };
      };
      const result =
        startOffset === windowEnd
          ? makePayload("")
          : largestUtf8PayloadChunk({
              content: text.slice(startOffset, windowEnd),
              offsetBytes: 0,
              maxBytes: APPLICATION_REVIEW_SOURCE_PAGE_BYTES,
              makePayload,
            }).payload;
      readWindows.set(
        path,
        mergeReadWindow(readWindows.get(path) ?? [], {
          startOffset,
          endOffset: startOffset + result.content.length,
        }),
      );
      return result;
    },
    async verifyRequirementQuote({ documentId, quote }) {
      if (quote.length === 0) {
        return false;
      }
      const document = await loadRequirement(documentId);
      return document.includes(quote);
    },
    async verifySourceCitation({ path, startLine, endLine, excerpt }) {
      const invalidLines =
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine;
      if (!fileByPath.has(path) || invalidLines || excerpt.length === 0) {
        return false;
      }
      const text = await loadSource(path);
      input.abortSignal?.throwIfAborted();
      const lines = text.split(/\r?\n/u);
      if (endLine <= lines.length && lines.slice(startLine - 1, endLine).join("\n") === excerpt) {
        return true;
      }
      const starts = lineStarts.get(path) ?? sourceLineStarts(text);
      return matchesReadWindow({
        text,
        starts,
        windows: readWindows.get(path) ?? [],
        startLine,
        endLine,
        excerpt,
      });
    },
  };
};
