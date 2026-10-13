/* oxlint-disable eslint/no-await-in-loop -- These fixtures model sequential transport latency and cancellation, so parallel reads would invalidate their behavior. */
import { setTimeout as waitFor } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { assessProductSourcePages } from "./product-source-review";
import type { ProductSourceReviewInput, SourceJudgment } from "./product-source-review";
import {
  createSourceReviewBatch,
  serializedSourceReviewBatchBytes,
  sourceReviewPromptBytes,
} from "./product-source-review-batches";
import type {
  SourceReviewBatch,
  SourceReviewBatchResult,
  SourceReviewInvocation,
} from "./product-source-review-batches";
import type { ProductReviewSourcePage } from "./product-source-review-pages";
import type {
  SourceReviewJournal,
  SourceReviewJournalRecord,
} from "./product-source-review-journal";

const input: Omit<ProductSourceReviewInput, "files"> = {
  appSpec: "Save records on the server",
  appSpecDigest: "spec",
  clarifications: [],
  omissions: [],
  originalRequest: "Save records",
  sourceDigest: "source",
};
const pages = (count: number): ProductReviewSourcePage[] =>
  Array.from({ length: count }, (_, index) => ({
    content: `fake save ${index}`,
    path: `apps/example/${index}.ts`,
    startColumn: 1,
    startLine: index + 1,
  }));
const stream = async function* stream(values: ProductReviewSourcePage[]) {
  yield* values;
};
const empty: SourceJudgment = { findings: [], remainingRuntimeChecks: [] };
const complete = (batch: SourceReviewBatch): SourceReviewBatchResult => ({
  judgments: batch.pairs.map(({ pairId }) => ({ judgment: empty, pairId })),
});
class Journal implements SourceReviewJournal {
  readonly records = new Map<string, SourceReviewJournalRecord>();
  async read(key: string) {
    return await Promise.resolve(this.records.get(key));
  }
  async put(key: string, record: SourceReviewJournalRecord) {
    const first = this.records.get(key) ?? record;
    this.records.set(key, first);
    return await Promise.resolve(first);
  }
}
const evidence = ({
  invocation: _invocation,
  ...assessment
}: Awaited<ReturnType<typeof assessProductSourcePages>>) => assessment;
const delay = async (milliseconds: number): Promise<void> => {
  await waitFor(milliseconds);
};
const deferred = <T = void>() => Promise.withResolvers<T>();

describe("exhaustive source review batching", () => {
  it("serializes stable requirement context before changing source and pair references", () => {
    const context = {
      digest: "context",
      index: 0,
      kind: "request-history" as const,
      startOffset: 0,
      text: "Save records",
    };
    const first = createSourceReviewBatch(input, [{ context, id: "first", page: pages(1)[0] }]);
    const changed = createSourceReviewBatch({ ...input, sourceDigest: "changed" }, [
      { context, id: "changed", page: { ...pages(1)[0], content: "changed bytes" } },
    ]);
    expect(Object.keys(first)).toEqual([
      "reviewContexts",
      "appSpecDigest",
      "files",
      "sourceDigest",
      "pairs",
    ]);
    expect(JSON.stringify(first).split('"files":')[0]).toEqual(
      JSON.stringify(changed).split('"files":')[0],
    );
  });
  it("deduplicates evidence and reviews every page/context pair with fewer requests", async () => {
    const expanded = { ...input, appSpec: "Requirement. ".repeat(2000) };
    const values = pages(5);
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- This oracle documents the serial and batched parity fixture side by side.
    const pairJudgment = (
      page: ProductReviewSourcePage,
      context: { startOffset: number },
    ): SourceJudgment => ({
      findings: [],
      remainingRuntimeChecks: [`${page.path}:${context.startOffset}`],
    });
    const serial = await assessProductSourcePages(expanded, stream(values), {
      generate: pairJudgment,
    });
    const generateBatch = vi.fn((batch: SourceReviewBatch) => ({
      judgments: batch.pairs.toReversed().map(({ pairId, pageId, contextId }) => ({
        judgment: pairJudgment(
          batch.files.find((page) => page.pageId === pageId) ?? {
            content: "",
            path: "missing",
            startColumn: 1,
            startLine: 1,
          },
          batch.reviewContexts.find((context) => context.contextId === contextId) ?? {
            startOffset: -1,
          },
        ),
        pairId,
      })),
    }));
    const batched = await assessProductSourcePages(expanded, stream(values), { generateBatch });
    expect(evidence(batched)).toEqual(evidence(serial));
    expect(serial.invocation?.requestAttempts).toBe(10);
    expect(batched.invocation?.requestAttempts).toBe(1);
    expect(generateBatch.mock.calls[0][0].files).toHaveLength(5);
    expect(generateBatch.mock.calls[0][0].reviewContexts).toHaveLength(2);
    expect(generateBatch.mock.calls[0][0].pairs).toHaveLength(10);
  });

  it.each(["missing", "duplicate", "unknown"])(
    "rejects %s pair results without checkpointing a partial response",
    async (kind) => {
      const journal = new Journal();
      const result = await assessProductSourcePages(input, stream(pages(3)), {
        generateBatch(batch) {
          const output = complete(batch);
          if (kind === "missing") {
            output.judgments.pop();
          }
          if (kind === "duplicate") {
            const [first] = output.judgments;
            output.judgments[1] = first;
          }
          if (kind === "unknown") {
            output.judgments[1] = { judgment: empty, pairId: "invented" };
          }
          return output;
        },
        journal,
      });
      expect(result.reviewCompleted).toBe(false);
      expect(journal.records.size).toBe(0);
      expect(result.invocation).toMatchObject({ requestAttempts: 1, successfulRequests: 1 });
    },
  );

  it("checks citations against each exact page and checkpoints valid siblings before recovery", async () => {
    const journal = new Journal();
    const values = pages(3);
    const result = await assessProductSourcePages(input, stream(values), {
      generateBatch(batch) {
        const output = complete(batch);
        output.judgments[1].judgment = {
          findings: [
            {
              citations: [
                { endLine: 1, excerpt: values[0].content, path: values[0].path, startLine: 1 },
              ],
              explanation: "Save is fake",
              repair: "Persist it",
              requirement: "Durable save",
              requirementQuote: "Save records",
            },
          ],
          remainingRuntimeChecks: [],
        };
        return output;
      },
      journal,
    });
    expect(result.reviewCompleted).toBe(false);
    expect(journal.records.size).toBe(2);
    const resumed = vi.fn(complete);
    const recovered = await assessProductSourcePages(input, stream(values), {
      generateBatch: resumed,
      journal,
    });
    expect(recovered.reviewCompleted).toBe(true);
    expect(resumed.mock.calls[0][0].pairs).toHaveLength(1);
    expect(recovered.invocation).toMatchObject({ journalReuses: 2, requestAttempts: 1 });
  });

  it("replays every completed pair without treating historical tokens as fresh tokens", async () => {
    const journal = new Journal();
    const first = await assessProductSourcePages(input, stream(pages(4)), {
      generateBatch: (batch) => ({
        ...complete(batch),
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      }),
      journal,
    });
    const generateBatch = vi.fn(complete);
    const replay = await assessProductSourcePages(input, stream(pages(4)), {
      generateBatch,
      journal,
    });
    expect(evidence(replay)).toEqual(evidence(first));
    expect(first.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(first.invocation?.freshUsage).toEqual(first.usage);
    expect(replay.invocation).toEqual({
      freshUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      journalReuses: 4,
      requestAttempts: 0,
      requestsWithIncompleteUsage: 0,
      splits: 0,
      successfulRequests: 0,
    });
    expect(generateBatch).not.toHaveBeenCalled();
    const changed = await assessProductSourcePages(
      { ...input, sourceDigest: "changed" },
      stream(pages(4)),
      { generateBatch, journal },
    );
    expect(changed.invocation?.journalReuses).toBe(0);
    expect(generateBatch).toHaveBeenCalledTimes(1);
  });

  it("splits provider-rejected batches and singletons through durable safe continuations", async () => {
    const journal = new Journal();
    const values = pages(3).map((page) => ({ ...page, content: "🚀".repeat(200) }));
    const generateBatch = vi.fn((batch: SourceReviewBatch) => {
      if (batch.pairs.length > 1 || batch.files[0].content.length > 120) {
        throw new Error("maximum context length exceeded");
      }
      return complete(batch);
    });
    const result = await assessProductSourcePages(input, stream(values), {
      generateBatch,
      journal,
    });
    expect(result.reviewCompleted).toBe(true);
    expect(result.invocation?.splits).toBeGreaterThan(3);
    expect([...journal.records.values()].some((record) => record.kind === "split-source")).toBe(
      true,
    );
    expect(
      generateBatch.mock.calls.every(
        ([batch]) => serializedSourceReviewBatchBytes(batch) <= sourceReviewPromptBytes,
      ),
    ).toBe(true);
    generateBatch.mockClear();
    const replay = await assessProductSourcePages(input, stream(values), {
      generateBatch,
      journal,
    });
    expect(evidence(replay)).toEqual(evidence(result));
    expect(generateBatch).not.toHaveBeenCalled();
  });

  it("splits JSON-escaped oversized singletons before starting any provider request", async () => {
    const generateBatch = vi.fn(complete);
    const result = await assessProductSourcePages(
      { ...input, appSpec: "", originalRequest: "\u0001".repeat(16_000) },
      stream([{ ...pages(1)[0], content: "\u0002".repeat(16_000) }]),
      { generateBatch },
    );
    expect(result.reviewCompleted).toBe(true);
    expect(result.invocation?.splits).toBeGreaterThan(0);
    expect(
      generateBatch.mock.calls.every(
        ([batch]) => serializedSourceReviewBatchBytes(batch) <= sourceReviewPromptBytes,
      ),
    ).toBe(true);
  });

  it("packs multiple batches to cover all source while bounding every UTF8 prompt", async () => {
    const values = pages(20).map((page) => ({ ...page, content: "🚀".repeat(8000) }));
    const generateBatch = vi.fn(complete);
    const result = await assessProductSourcePages(input, stream(values), { generateBatch });
    expect(result.reviewCompleted).toBe(true);
    expect(generateBatch.mock.calls.length).toBeGreaterThan(1);
    expect(generateBatch.mock.calls.length).toBeLessThan(values.length);
    expect(generateBatch.mock.calls.reduce((sum, [batch]) => sum + batch.pairs.length, 0)).toBe(
      values.length,
    );
    expect(
      generateBatch.mock.calls.every(
        ([batch]) => serializedSourceReviewBatchBytes(batch) <= sourceReviewPromptBytes,
      ),
    ).toBe(true);
  });

  it("batches across ordinary delayed source and AppSpec reads", async () => {
    const delayed = async function* delayed() {
      for (const page of pages(4)) {
        await delay(15);
        yield page;
      }
    };
    const parts = async function* parts() {
      await delay(15);
      yield input.appSpec;
    };
    const generateBatch = vi.fn(complete);
    const result = await assessProductSourcePages({ ...input, appSpec: "" }, delayed(), {
      generateBatch,
      reviewAppSpecParts: parts,
    });
    expect(result.reviewCompleted).toBe(true);
    expect(generateBatch).toHaveBeenCalledTimes(1);
    expect(generateBatch.mock.calls[0][0].pairs).toHaveLength(4);
  });

  it("flushes a stalled partial batch at a bounded deadline and stops admission on failure", async () => {
    const readStarted = deferred();
    const readGate = deferred();
    const closed = deferred();
    const stalled = async function* stalled() {
      try {
        yield pages(1)[0];
        readStarted.resolve();
        await readGate.promise;
        yield pages(2)[1];
      } finally {
        closed.resolve();
      }
    };
    const generateBatch = vi.fn(() => {
      throw new Error("provider unavailable");
    });
    const started = Date.now();
    const result = await assessProductSourcePages(input, stalled(), { generateBatch });
    expect(result.reviewCompleted).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(generateBatch).toHaveBeenCalledTimes(1);
    await readStarted.promise;
    readGate.resolve();
    await closed.promise;
    expect(generateBatch).toHaveBeenCalledTimes(1);
  });

  it("anchors the fill deadline to the first pair instead of extending it per read", async () => {
    const delayed = async function* delayed() {
      for (const page of pages(5)) {
        await delay(90);
        yield page;
      }
    };
    const generateBatch = vi.fn(complete);
    const result = await assessProductSourcePages(input, delayed(), { generateBatch });
    expect(result.reviewCompleted).toBe(true);
    expect(generateBatch).toHaveBeenCalledTimes(2);
    expect(generateBatch.mock.calls[0][0].pairs).toHaveLength(3);
  });

  it("uses canonical first-writer pair results when concurrent batched retries overlap", async () => {
    const journal = new Journal();
    const gate = deferred();
    let started = 0;
    const generateBatch = async (batch: SourceReviewBatch) => {
      started += 1;
      const label = `request-${started}`;
      if (started === 2) {
        gate.resolve();
      }
      await gate.promise;
      return {
        judgments: batch.pairs.map(({ pairId }) => ({
          judgment: { ...empty, remainingRuntimeChecks: [label] },
          pairId,
        })),
      };
    };
    const [first, second] = await Promise.all([
      assessProductSourcePages(input, stream(pages(3)), { generateBatch, journal }),
      assessProductSourcePages(input, stream(pages(3)), { generateBatch, journal }),
    ]);
    expect(evidence(first)).toEqual(evidence(second));
    expect(journal.records.size).toBe(3);
  });

  it("joins a begun batched journal write on cancellation and admits no later commits", async () => {
    const abort = new AbortController();
    const begun = deferred();
    const gate = deferred();
    const journal = new Journal();
    const put = journal.put.bind(journal);
    journal.put = async (key, record) => {
      begun.resolve();
      await gate.promise;
      return await put(key, record);
    };
    const invocation = vi.fn<(value: SourceReviewInvocation) => void>();
    const run = assessProductSourcePages(input, stream(pages(3)), {
      abortSignal: abort.signal,
      generateBatch: complete,
      journal,
      onInvocation(value) {
        invocation(value);
      },
    });
    await begun.promise;
    abort.abort();
    let settled = false;
    const completion = run.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await expect(completion).rejects.toThrow();
    expect(journal.records.size).toBe(1);
    expect(invocation).toHaveBeenCalledWith(
      expect.objectContaining({ requestAttempts: 1, successfulRequests: 1 }),
    );
  });

  it("drains admitted batch requests and writes when a later source read fails", async () => {
    const begun = deferred();
    const gate = deferred();
    const journal = new Journal();
    const values = pages(5).map((page) => ({ ...page, content: "🚀".repeat(8000) }));
    const failed = async function* failed() {
      yield* values;
      await begun.promise;
      throw new Error("source failed");
    };
    const run = assessProductSourcePages(input, failed(), {
      async generateBatch(batch) {
        begun.resolve();
        await gate.promise;
        return complete(batch);
      },
      journal,
    });
    await begun.promise;
    let settled = false;
    const completion = run.finally(() => {
      settled = true;
    });
    await delay(5);
    expect(settled).toBe(false);
    gate.resolve();
    await expect(completion).rejects.toThrow("source failed");
    expect(journal.records.size).toBe(4);
  });
});
