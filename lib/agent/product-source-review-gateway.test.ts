/* oxlint-disable sonarjs/no-undefined-assignment -- Faithful SDK fixtures exercise provider fields whose documented type requires undefined. */
import { expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { assessProductSourcePages } from "./product-source-review";
import type { SourceReviewRequest } from "./product-source-review-batches";
import { serializeSourceReviewRecord } from "./product-source-review-journal";
import type {
  SourceReviewJournal,
  SourceReviewJournalRecord,
} from "./product-source-review-journal";

const batchSchema = z.object({
  files: z.array(z.object({ content: z.string(), path: z.string() })),
  pairs: z.array(z.object({ pairId: z.string() })),
  reviewContexts: z.array(z.object({ text: z.string() })),
});
// oxlint-disable-next-line sonarjs/max-union-size -- Each literal is one distinct local SDK response or failure fixture.
const localModel = (
  // oxlint-disable-next-line sonarjs/max-union-size -- Four documented provider outcomes are distinct SDK protocol fixtures.
  kind: "valid" | "invalid-output" | "provider-error" | "missing-usage" = "valid",
) =>
  new MockLanguageModelV4({
    async doGenerate(options) {
      if (kind === "provider-error") {
        throw new Error("provider unavailable");
      }
      const user = options.prompt.find((message) => message.role === "user");
      if (user?.role !== "user") {
        throw new Error("Missing user prompt");
      }
      const text = user.content.find((part) => part.type === "text");
      if (text?.type !== "text") {
        throw new Error("Missing prompt text");
      }
      const batch = batchSchema.parse(JSON.parse(text.text));
      return await Promise.resolve({
        content: [
          {
            text:
              kind === "invalid-output"
                ? "private invalid output"
                : JSON.stringify({
                    judgments: batch.pairs.map(({ pairId }) => ({
                      judgment: { findings: [], remainingRuntimeChecks: [] },
                      pairId,
                    })),
                  }),
            type: "text" as const,
          },
        ],
        finishReason: { raw: "stop", unified: "stop" as const },
        providerMetadata: {
          gateway: { generationId: "generation-1", privateValue: "must-not-log" },
        },
        response: { id: "response-1", modelId: "openai/gpt-6.1-sol", timestamp: new Date() },
        usage: {
          inputTokens: {
            cacheRead: 5,
            cacheWrite: 0,
            noCache: 10,
            total: kind === "missing-usage" ? undefined : 15,
          },
          outputTokens: { reasoning: 3, text: 2, total: kind === "missing-usage" ? undefined : 5 },
          raw: { privateValue: "must-not-log" },
        },
        warnings: [],
      });
    },
    modelId: "openai/gpt-6.1-sol",
    provider: "gateway",
  });
const input = {
  appSpec: "Save records",
  appSpecDigest: "spec",
  clarifications: [],
  omissions: [],
  originalRequest: "Save records",
  sourceDigest: "source",
};
const pages = async function* pages() {
  yield { content: "private source", path: "apps/example/page.ts", startColumn: 1, startLine: 1 };
};

const reviewPages = async function* reviewPages(count: number, content = "private source") {
  for (let index = 0; index < count; index += 1) {
    yield { content, path: `apps/example/${index}.ts`, startColumn: 1, startLine: index + 1 };
  }
};
const modelBatch = (options: Parameters<MockLanguageModelV4["doGenerate"]>[0]) => {
  const user = options.prompt.find((message) => message.role === "user");
  if (user?.role !== "user") {
    throw new Error("Missing user prompt");
  }
  const text = user.content.find((part) => part.type === "text");
  if (text?.type !== "text") {
    throw new Error("Missing prompt text");
  }
  return batchSchema.parse(JSON.parse(text.text));
};
const truncatedText = '{"judgments":[{"pairId":"maximum context length exceeded"';
const truncatingModel = (
  reject: (batch: z.infer<typeof batchSchema>) => boolean,
  finishReason: "length" | "stop" | "content-filter" = "length",
) => {
  const complete = localModel();
  return new MockLanguageModelV4({
    async doGenerate(options) {
      const result = await complete.doGenerate(options);
      return reject(modelBatch(options))
        ? {
            ...result,
            content: [{ text: truncatedText, type: "text" as const }],
            finishReason: { raw: finishReason, unified: finishReason },
          }
        : result;
    },
    modelId: "openai/gpt-6.1-sol",
    provider: "gateway",
  });
};
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

it("emits only allowlisted generation metadata and detailed usage without unsupported Gateway options", async () => {
  const model = localModel();
  const requests: SourceReviewRequest[] = [];
  const result = await assessProductSourcePages(input, pages(), {
    journal: {
      async put(_key, record) {
        expect(serializeSourceReviewRecord(record)).not.toMatch(/must-not-log|privateValue|raw/u);
        return await Promise.resolve(record);
      },
      async read() {
        await Promise.resolve();
      },
    },
    onRequest(request) {
      requests.push(request);
    },
    sessionId: "session-1",
    testModel: model,
  });
  expect(result.reviewCompleted).toBe(true);
  expect(model.doGenerateCalls[0].providerOptions?.gateway).toEqual({
    only: ["openai"],
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].sdkCallId).toBeTypeOf("string");
  expect(requests[0].gatewayGenerationId).toBe("generation-1");
  expect(requests[0].responseId).toBe("response-1");
  expect(requests[0].cacheReadTokens).toBe(5);
  expect(requests[0].reasoningTokens).toBe(3);
  expect(JSON.stringify(requests)).not.toMatch(/private|must-not-log/u);
  expect(result.invocation).toMatchObject({
    freshUsage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
    requestsWithIncompleteUsage: 0,
  });
});

it("retains billed response usage and generation metadata when structured output fails", async () => {
  const requests: SourceReviewRequest[] = [];
  const result = await assessProductSourcePages(input, pages(), {
    onRequest(request) {
      requests.push(request);
    },
    sessionId: "session-1",
    testModel: localModel("invalid-output"),
  });
  expect(result.reviewCompleted).toBe(false);
  expect(result.invocation).toMatchObject({
    freshUsage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
    requestAttempts: 1,
    requestsWithIncompleteUsage: 0,
    successfulRequests: 1,
  });
  expect(requests).toHaveLength(1);
});

it.each(["provider-error", "missing-usage"] as const)(
  "reports incomplete usage for %s without inventing billed tokens",
  async (kind) => {
    const result = await assessProductSourcePages(input, pages(), { testModel: localModel(kind) });
    expect(result.invocation).toMatchObject({
      freshUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      requestAttempts: 1,
      requestsWithIncompleteUsage: 1,
    });
  },
);

it("splits length-truncated SDK batches without losing pair coverage or fresh billed usage", async () => {
  const model = truncatingModel((batch) => batch.pairs.length > 2);
  const journal = new Journal();
  const requests: SourceReviewRequest[] = [];
  const result = await assessProductSourcePages(input, reviewPages(4), {
    journal,
    onRequest(request) {
      requests.push(request);
    },
    testModel: model,
  });
  expect(result.reviewCompleted).toBe(true);
  expect(model.doGenerateCalls.map((options) => modelBatch(options).pairs.length)).toEqual([
    4, 2, 2,
  ]);
  expect(journal.records.size).toBe(4);
  expect([...journal.records.values()].every((record) => record.kind === "completed")).toBe(true);
  expect(result.invocation).toMatchObject({
    freshUsage: { inputTokens: 45, outputTokens: 15, totalTokens: 60 },
    requestAttempts: 3,
    requestsWithIncompleteUsage: 0,
    splits: 1,
    successfulRequests: 3,
  });
  expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests)).not.toContain(truncatedText);
  const completedIds = model.doGenerateCalls
    .slice(1)
    .flatMap((options) => modelBatch(options).pairs.map(({ pairId }) => pairId));
  expect(new Set(completedIds)).toEqual(
    new Set(modelBatch(model.doGenerateCalls[0]).pairs.map(({ pairId }) => pairId)),
  );
});

it.each(["source", "context"] as const)(
  "splits a length-truncated singleton through the existing durable %s continuation",
  async (kind) => {
    const model = truncatingModel(
      (batch) =>
        (kind === "source" ? batch.files[0].content.length : batch.reviewContexts[0].text.length) >
        80,
    );
    const journal = new Journal();
    const reviewInput =
      kind === "source" ? input : { ...input, appSpec: "", originalRequest: "s".repeat(256) };
    const source = kind === "source" ? "s".repeat(256) : "s";
    const result = await assessProductSourcePages(reviewInput, reviewPages(1, source), {
      journal,
      testModel: model,
    });
    expect(result.reviewCompleted).toBe(true);
    expect(
      [...journal.records.values()].some(
        (record) => record.kind === (kind === "source" ? "split-source" : "split-context"),
      ),
    ).toBe(true);
    expect(result.invocation?.splits).toBeGreaterThan(0);
    expect(result.invocation?.freshUsage.totalTokens).toBe(model.doGenerateCalls.length * 20);
    expect(result.invocation?.requestsWithIncompleteUsage).toBe(0);
    const previousCalls = model.doGenerateCalls.length;
    const replay = await assessProductSourcePages(reviewInput, reviewPages(1, source), {
      journal,
      testModel: model,
    });
    expect(replay.reviewCompleted).toBe(true);
    expect(replay.usage).toEqual(result.usage);
    expect(replay.invocation?.freshUsage.totalTokens).toBe(0);
    expect(model.doGenerateCalls).toHaveLength(previousCalls);
  },
);

it.each(["stop", "content-filter"] as const)(
  "blocks invalid SDK output ending in %s without a capacity split",
  async (finishReason) => {
    const model = truncatingModel(() => true, finishReason);
    const journal = new Journal();
    const result = await assessProductSourcePages(input, reviewPages(4), {
      journal,
      testModel: model,
    });
    expect(result.reviewCompleted).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.invocation).toMatchObject({
      freshUsage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
      requestAttempts: 1,
      splits: 0,
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(journal.records.size).toBe(0);
  },
);

it("passes caller cancellation alone to multi-pair SDK calls and preserves the singleton deadline", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  try {
    const caller = new AbortController();
    const batched = localModel();
    await assessProductSourcePages(input, reviewPages(4), {
      abortSignal: caller.signal,
      testModel: batched,
    });
    expect(batched.doGenerateCalls[0].abortSignal).toBe(caller.signal);
    expect(timeout).not.toHaveBeenCalled();
    const withoutCaller = localModel();
    await assessProductSourcePages(input, reviewPages(4), { testModel: withoutCaller });
    expect(withoutCaller.doGenerateCalls[0].abortSignal).toBeUndefined();
    expect(timeout).not.toHaveBeenCalled();
    const singleton = localModel();
    await assessProductSourcePages(input, pages(), {
      abortSignal: caller.signal,
      testModel: singleton,
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(120_000);
    expect(singleton.doGenerateCalls[0].abortSignal).not.toBe(caller.signal);
    expect(singleton.doGenerateCalls[0].abortSignal?.aborted).toBe(false);
  } finally {
    timeout.mockRestore();
  }
});

it("does not split or commit after caller cancellation of an admitted SDK batch", async () => {
  const caller = new AbortController();
  const started = Promise.withResolvers<boolean>();
  const response = Promise.withResolvers<boolean>();
  const lateSource = Promise.withResolvers<boolean>();
  const complete = localModel();
  const model = new MockLanguageModelV4({
    async doGenerate(options) {
      started.resolve(true);
      await response.promise;
      const result = await complete.doGenerate(options);
      return {
        ...result,
        content: [{ text: truncatedText, type: "text" as const }],
        finishReason: { raw: "length", unified: "length" as const },
      };
    },
  });
  const source = async function* source() {
    yield* reviewPages(3);
    await lateSource.promise;
    yield* reviewPages(3);
  };
  const journal = new Journal();
  const run = assessProductSourcePages(input, source(), {
    abortSignal: caller.signal,
    journal,
    testModel: model,
  });
  const completion = expect(run).rejects.toThrow("maximum context length exceeded");
  await started.promise;
  caller.abort(new Error("maximum context length exceeded"));
  response.resolve(true);
  lateSource.resolve(true);
  await completion;
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(journal.records.size).toBe(0);
});
