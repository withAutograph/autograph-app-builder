import { createHash, randomUUID } from "node:crypto";

import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";

export type ValidationLogChannel = "stdout" | "stderr";

export interface ValidationLogReference {
  channel: ValidationLogChannel;
  digest: string;
  logId: string;
  bytes: number;
  chunkCount: number;
}

export interface ValidationLogKey {
  sessionId: string;
  attemptDigest: string;
  command: string;
  channel: ValidationLogChannel;
  logId: string;
}

export interface ValidationLogStore {
  putChunk: (
    key: ValidationLogKey,
    index: number,
    content: string,
    digest: string,
  ) => Promise<void>;
  publish: (key: ValidationLogKey, reference: ValidationLogReference) => Promise<void>;
  removeStaged: (key: ValidationLogKey) => Promise<void>;
  getReference: (key: ValidationLogKey) => Promise<ValidationLogReference | undefined>;
  getChunk: (
    key: ValidationLogKey,
    index: number,
  ) => Promise<{ content: string; digest: string } | undefined>;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");
const CHUNK_BYTES = 32 * 1024;
// Keep a suffix when streaming an unseparated line so a credential marker
// split at the operation boundary is recognized before any value is written.
const MAX_UNSEPARATED_LINE = 32 * 1024;
const LONG_LINE_SUFFIX = 128;
const sensitiveLongLine =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]|Bearer\s+|https?:\/\/[^\s/@]+:[^\s/@]+@|\b(?:gh[oprsu]_|github_pat_|sk-)/iu;

/** One channel is consumed serially; awaited chunk writes provide backpressure. */
export class ValidationLogWriter {
  readonly key: ValidationLogKey;
  private readonly store: ValidationLogStore;
  private readonly hash = createHash("sha256");
  private pending = "";
  private line = "";
  private lineBytes = 0;
  private redactingLongLine = false;
  private streamedLongLine = false;
  private byteLength = 0;
  private chunks = 0;
  private published = false;
  private excerpt = "";
  private omitted = false;

  constructor(store: ValidationLogStore, input: Omit<ValidationLogKey, "logId">) {
    this.store = store;
    this.key = { ...input, logId: randomUUID() };
  }

  private async emit(value: string): Promise<void> {
    this.pending += value;
    while (Buffer.byteLength(this.pending, "utf-8") >= CHUNK_BYTES) {
      let offset = 0;
      let bytes = 0;
      for (const character of this.pending) {
        const next = Buffer.byteLength(character, "utf-8");
        if (bytes + next > CHUNK_BYTES) {
          break;
        }
        bytes += next;
        offset += character.length;
      }
      const content = this.pending.slice(0, offset);
      this.pending = this.pending.slice(offset);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Acknowledged writes bound command-output memory.
      await this.writeChunk(content);
    }
  }

  private async writeChunk(content: string): Promise<void> {
    const digest = sha256(content);
    await this.store.putChunk(this.key, this.chunks, content, digest);
    this.hash.update(content, "utf-8");
    this.byteLength += Buffer.byteLength(content, "utf-8");
    this.chunks += 1;
  }

  private async finishLine(newline: boolean): Promise<void> {
    const value = this.redactingLongLine
      ? "[REDACTED: unseparated validation line]"
      : sanitizeValidationDiagnosticText(this.line);
    const rendered = value + (newline ? "\n" : "");
    await this.emit(rendered);
    // Receipt output is a convenience sample. Durable logs carry every line.
    if (!this.streamedLongLine && /apps\/|error|fail|TS\d+|cue:|cargo:|rustc:|mise/iu.test(value)) {
      const next = this.excerpt + rendered;
      if (Buffer.byteLength(next, "utf-8") <= CHUNK_BYTES) {
        this.excerpt = next;
      } else {
        this.omitted = true;
      }
    } else if (value.trim()) {
      this.omitted = true;
    }
    this.line = "";
    this.lineBytes = 0;
    this.redactingLongLine = false;
    this.streamedLongLine = false;
  }

  async append(value: string): Promise<void> {
    if (this.published) {
      throw new Error("Validation log is already published.");
    }
    for (const character of value) {
      if (character === "\n") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Lines are sanitized and written in order.
        await this.finishLine(true);
      } else if (!this.redactingLongLine) {
        this.line += character;
        this.lineBytes += Buffer.byteLength(character, "utf-8");
        if (this.lineBytes > MAX_UNSEPARATED_LINE) {
          if (sensitiveLongLine.test(this.line)) {
            this.line = "";
            this.lineBytes = 0;
            this.redactingLongLine = true;
          } else {
            let end = this.line.length - LONG_LINE_SUFFIX;
            if (/^[\uD800-\uDBFF]$/u.test(this.line[end - 1] ?? "")) {
              end -= 1;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- Awaited writes preserve backpressure.
            await this.emit(sanitizeValidationDiagnosticText(this.line.slice(0, end)));
            this.line = this.line.slice(end);
            this.lineBytes = Buffer.byteLength(this.line, "utf-8");
            this.streamedLongLine = true;
          }
          this.omitted = true;
        }
      }
    }
  }

  async finish(): Promise<{
    reference: ValidationLogReference;
    excerpt: string;
    omitted: boolean;
  }> {
    if (this.line.length > 0 || this.redactingLongLine) {
      await this.finishLine(false);
    }
    if (this.pending.length > 0) {
      await this.writeChunk(this.pending);
      this.pending = "";
    }
    const reference = {
      bytes: this.byteLength,
      channel: this.key.channel,
      chunkCount: this.chunks,
      digest: this.hash.digest("hex"),
      logId: this.key.logId,
    } as const;
    await this.store.publish(this.key, reference);
    this.published = true;
    return { excerpt: this.excerpt.trim(), omitted: this.omitted, reference };
  }

  async abort(): Promise<void> {
    await this.store.removeStaged(this.key);
  }
}

/** Cursor binds a page to the immutable manifest; one page reads one chunk. */
// oxlint-disable-next-line eslint/func-style -- Exported async reader is a stable contract entrypoint.
export async function readValidationLogPage(input: {
  store: ValidationLogStore;
  key: ValidationLogKey;
  digest: string;
  cursor?: string;
}) {
  const reference = await input.store.getReference(input.key);
  if (reference === undefined || reference.digest !== input.digest) {
    throw new Error("The validation log is unavailable for this session or digest.");
  }
  const invalidBytes = !Number.isSafeInteger(reference.bytes) || reference.bytes < 0;
  const invalidChunks = !Number.isSafeInteger(reference.chunkCount) || reference.chunkCount < 0;
  if (invalidBytes || invalidChunks || (reference.bytes === 0) !== (reference.chunkCount === 0)) {
    throw new Error("The validation log manifest failed integrity verification.");
  }
  const index = input.cursor === undefined ? 0 : Number(input.cursor.split(":")[1]);
  const staleCursor = input.cursor !== undefined && input.cursor !== `${reference.digest}:${index}`;
  if (staleCursor || !Number.isSafeInteger(index) || index < 0 || index > reference.chunkCount) {
    throw new Error("The validation log cursor is stale or invalid.");
  }
  if (index === reference.chunkCount) {
    return {
      chunkIndex: reference.chunkCount,
      complete: true,
      content: "",
      digest: reference.digest,
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- No further page exists.
      nextCursor: undefined,
      totalBytes: reference.bytes,
    };
  }
  const chunk = await input.store.getChunk(input.key, index);
  if (chunk === undefined || sha256(chunk.content) !== chunk.digest) {
    throw new Error("The stored validation log chunk failed integrity verification.");
  }
  const nextCursor =
    index + 1 === reference.chunkCount ? undefined : `${reference.digest}:${index + 1}`;
  return {
    chunkIndex: index,
    complete: nextCursor === undefined,
    content: chunk.content,
    digest: reference.digest,
    nextCursor,
    totalBytes: reference.bytes,
  };
}
