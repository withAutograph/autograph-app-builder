import { describe, expect, it, vi } from "vitest";
import { assessProductSourcePages } from "./product-source-review";
import type { ProductSourceReviewInput, SourceJudgment } from "./product-source-review";
import type { ProductReviewSourcePage } from "./product-source-review-pages";
import type {
  SourceReviewJournal,
  SourceReviewJournalRecord,
} from "./product-source-review-journal";

class Journal implements SourceReviewJournal {
  readonly records = new Map<string, SourceReviewJournalRecord>();
  private readonly beforePut?: (key: string, record: SourceReviewJournalRecord) => Promise<void>;

  constructor(beforePut?: (key: string, record: SourceReviewJournalRecord) => Promise<void>) {
    this.beforePut = beforePut;
  }

  async read(key: string) {
    return await Promise.resolve(this.records.get(key));
  }

  async put(key: string, record: SourceReviewJournalRecord) {
    await this.beforePut?.(key, record);
    const result = this.records.get(key) ?? record;
    this.records.set(key, result);
    return await Promise.resolve(result);
  }
}

const makeInput = (overrides: Partial<Omit<ProductSourceReviewInput, "files">> = {}) => ({
  appSpec: "Preserve every requested outcome",
  appSpecDigest: "spec",
  clarifications: ["Keep the history"],
  omissions: [],
  originalRequest: "Save records on the server",
  sourceDigest: "source",
  ...overrides,
});

const makePages = (count: number): ProductReviewSourcePage[] =>
  Array.from({ length: count }, (_, index) => ({
    content: `const value${index} = true;`,
    path: `apps/example/${index}.ts`,
    startColumn: 1,
    startLine: index + 1,
  }));

const stream = async function* stream(values: ProductReviewSourcePage[]) {
  yield* values;
};

const deferred = <T = void>() => Promise.withResolvers<T>();

const judgment = (label: string): SourceJudgment => ({
  findings: [],
  remainingRuntimeChecks: [label],
});

describe("concurrent product source review", () => {
  it("keeps serial and concurrent aggregation identical and in input order", async () => {
    const pages = makePages(3);
    const contexts = ["x".repeat(20_000), "y".repeat(20_000), "z".repeat(2000)];
    const reviewAppSpecParts = async function* reviewAppSpecParts() {
      yield* contexts;
    };
    const input = makeInput({ appSpec: "", appSpecDigest: "many-contexts" });
    const run = async (concurrency: number) =>
      await assessProductSourcePages(input, stream(pages), {
        concurrency,
        generate: (page, context) => ({
          findings: [
            {
              citations: [
                {
                  endLine: 1,
                  excerpt: page.content,
                  path: page.path,
                  startLine: 1,
                },
              ],
              explanation: `Pair at ${context.startOffset}`,
              repair: "Keep this value durable.",
              requirement: `Requirement at ${context.startOffset}`,
              requirementQuote: context.text.slice(-24),
            },
          ],
          remainingRuntimeChecks: [`${page.path}:${context.startOffset}`],
        }),
        reviewAppSpecParts,
      });

    const serial = await run(1);
    const concurrent = await run(4);
    expect(concurrent).toEqual(serial);
    expect(concurrent.reviewCompleted).toBe(true);
    expect(concurrent.remainingRuntimeChecks).toHaveLength(9);
    expect(concurrent.findings).toHaveLength(9);
    expect(concurrent.findings.map((finding) => finding.citations[0]?.startLine)).toEqual(
      pages.flatMap((page) => Array.from({ length: 3 }, () => page.startLine)),
    );
  });

  it("preserves pair order when provider calls finish in reverse order", async () => {
    const pages = makePages(3);
    const gates = pages.map(() => deferred());
    const started = deferred();
    const completed: string[] = [];
    let starts = 0;
    const run = assessProductSourcePages(makeInput(), stream(pages), {
      concurrency: 3,
      generate: async (page) => {
        const gate = gates[pages.indexOf(page)];
        if (gate === undefined) {
          throw new Error("Unexpected source page.");
        }
        starts += 1;
        if (starts === 3) {
          started.resolve();
        }
        await gate.promise;
        completed.push(page.path);
        return judgment(page.path);
      },
    });
    await started.promise;
    for (const index of [2, 1, 0]) {
      gates[index]?.resolve();
    }
    const result = await run;
    expect(completed).toEqual(pages.toReversed().map((page) => page.path));
    expect(result.remainingRuntimeChecks).toEqual(pages.map((page) => page.path));
  });

  it("caps in-flight work at the configured default of four", async () => {
    const pages = makePages(7);
    const gates = pages.map(() => deferred());
    const started = deferred();
    let active = 0;
    let maximum = 0;
    let starts = 0;
    const run = assessProductSourcePages(makeInput(), stream(pages), {
      generate: async (page) => {
        const gate = gates[pages.indexOf(page)];
        if (gate === undefined) {
          throw new Error("Unexpected source page.");
        }
        active += 1;
        starts += 1;
        maximum = Math.max(maximum, active);
        if (starts === 4) {
          started.resolve();
        }
        await gate.promise;
        active -= 1;
        return judgment(page.path);
      },
    });
    await started.promise;
    expect(maximum).toBe(4);
    for (const gate of gates.slice(0, 4)) {
      gate.resolve();
    }
    await vi.waitFor(() => {
      expect(starts).toBeGreaterThan(4);
    });
    expect(maximum).toBeLessThanOrEqual(4);
    for (const gate of gates) {
      gate.resolve();
    }
    const result = await run;
    expect(result.reviewCompleted).toBe(true);
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it("stops admitting work after a pair fails and keeps completed sibling pairs resumable", async () => {
    const pages = makePages(4);
    const journal = new Journal();
    const firstStarted = deferred();
    const siblingStarted = deferred();
    const failStarted = deferred();
    const firstGate = deferred();
    const siblingGate = deferred();
    const failGate = deferred();
    const generate = vi.fn(async (page: ProductReviewSourcePage) => {
      const index = pages.indexOf(page);
      if (index === 0) {
        firstStarted.resolve();
        await firstGate.promise;
        return judgment("completed-first");
      }
      if (index === 1) {
        siblingStarted.resolve();
        await siblingGate.promise;
        return judgment("completed-sibling");
      }
      failStarted.resolve();
      await failGate.promise;
      throw new Error("provider failed");
    });
    const run = assessProductSourcePages(makeInput(), stream(pages), {
      concurrency: 3,
      generate,
      journal,
    });
    await Promise.all([firstStarted.promise, siblingStarted.promise, failStarted.promise]);
    firstGate.resolve();
    siblingGate.resolve();
    await vi.waitFor(() => {
      expect(journal.records.size).toBe(2);
    });
    failGate.resolve();
    const result = await run;
    expect(result.reviewCompleted).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("Independent source review was unavailable");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(
      [...journal.records.values()].filter((record) => record.kind === "completed"),
    ).toHaveLength(2);

    const resumed = vi.fn(() => judgment("remaining"));
    const resumedResult = await assessProductSourcePages(makeInput(), stream(pages), {
      concurrency: 3,
      generate: resumed,
      journal,
    });
    expect(resumed).toHaveBeenCalledTimes(2);
    expect(resumedResult.reviewCompleted).toBe(true);
    expect(resumedResult.remainingRuntimeChecks).toEqual([
      "completed-first",
      "completed-sibling",
      "remaining",
    ]);
  });

  it("drains in-flight journal writes after a source iterator fails", async () => {
    const pages = makePages(3);
    const putStarted = deferred();
    const putGate = deferred();
    const journal = new Journal(async () => {
      putStarted.resolve();
      await putGate.promise;
    });
    const interrupted = async function* interrupted() {
      yield* pages;
      await putStarted.promise;
      throw new Error("source iterator failed");
    };
    const run = assessProductSourcePages(makeInput(), interrupted(), {
      concurrency: 4,
      generate: (page) => judgment(page.path),
      journal,
    });
    await putStarted.promise;
    let returned = false;
    const settled = run.finally(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    putGate.resolve();
    await expect(settled).rejects.toThrow("source iterator failed");
    expect(
      [...journal.records.values()].filter((record) => record.kind === "completed"),
    ).toHaveLength(3);
  });

  it("waits for a begun journal commit on cancellation and commits no later results", async () => {
    const pages = makePages(3);
    const abort = new AbortController();
    const putStarted = deferred();
    const putGate = deferred();
    const journal = new Journal(async (_key, record) => {
      if (record.kind === "completed") {
        putStarted.resolve();
        await putGate.promise;
      }
    });
    const secondStarted = deferred();
    const secondGate = deferred();
    const generate = vi.fn(async (page: ProductReviewSourcePage) => {
      if (pages.indexOf(page) === 1) {
        secondStarted.resolve();
        await secondGate.promise;
      }
      return judgment(page.path);
    });
    const run = assessProductSourcePages(makeInput(), stream(pages), {
      abortSignal: abort.signal,
      concurrency: 2,
      generate,
      journal,
    });
    await Promise.all([putStarted.promise, secondStarted.promise]);
    abort.abort();
    secondGate.resolve();
    let returned = false;
    const settled = run.finally(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    putGate.resolve();
    await expect(settled).rejects.toThrow();
    expect(
      [...journal.records.values()].filter((record) => record.kind === "completed"),
    ).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("uses separate journals for separate owners and changed source keys", async () => {
    const pages = makePages(1);
    const firstOwner = new Journal();
    const secondOwner = new Journal();
    const firstGenerate = vi.fn(() => judgment("first"));
    const secondGenerate = vi.fn(() => judgment("second"));
    await assessProductSourcePages(makeInput(), stream(pages), {
      generate: firstGenerate,
      journal: firstOwner,
    });
    await assessProductSourcePages(makeInput(), stream(pages), {
      generate: secondGenerate,
      journal: secondOwner,
    });
    expect(firstGenerate).toHaveBeenCalledTimes(1);
    expect(secondGenerate).toHaveBeenCalledTimes(1);
    const changed = vi.fn(() => judgment("changed-source"));
    await assessProductSourcePages(makeInput({ sourceDigest: "new-source" }), stream(pages), {
      generate: changed,
      journal: firstOwner,
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("preserves recursive source and requirement split coverage and durable replay", async () => {
    const input = makeInput({ appSpec: "full requirement ".repeat(100) });
    const pages = makePages(2).map((page) => ({ ...page, content: "x".repeat(400) }));
    const journal = new Journal();
    const generate = vi.fn((page: ProductReviewSourcePage, context: { text: string }) => {
      if (page.content.length > 250 || context.text.length > 350) {
        throw new Error("maximum context length exceeded");
      }
      return judgment(page.path);
    });
    const serial = await assessProductSourcePages(input, stream(pages), {
      concurrency: 1,
      generate,
    });
    generate.mockClear();
    const concurrent = await assessProductSourcePages(input, stream(pages), { generate, journal });
    expect(concurrent).toEqual(serial);
    expect(concurrent.reviewCompleted).toBe(true);
    expect([...journal.records.values()].some((record) => record.kind === "split-source")).toBe(
      true,
    );
    expect([...journal.records.values()].some((record) => record.kind === "split-context")).toBe(
      true,
    );
    const replay = vi.fn(() => judgment("unreachable"));
    expect(
      await assessProductSourcePages(input, stream(pages), { generate: replay, journal }),
    ).toEqual(concurrent);
    expect(replay).not.toHaveBeenCalled();
  });

  it("snapshots each pair's omissions before reading ahead to later source", async () => {
    const pages = makePages(2);
    const run = async (concurrency: number) => {
      const omissions: string[] = [];
      const journal = new Journal();
      const selected = async function* selected() {
        yield pages[0];
        omissions.push("unavailable dependency");
        yield pages[1];
      };
      const assessment = await assessProductSourcePages(makeInput({ omissions }), selected(), {
        concurrency,
        generate: (page) => judgment(page.path),
        journal,
      });
      return { assessment, records: journal.records };
    };
    expect(await run(4)).toEqual(await run(1));
  });

  it("reports a failed pair while a later source read stalls and ignores its late result", async () => {
    const pages = makePages(2);
    const readStarted = deferred();
    const readGate = deferred();
    const failed = deferred();
    const closed = deferred();
    const selected = async function* selected() {
      try {
        yield pages[0];
        readStarted.resolve();
        await readGate.promise;
        yield pages[1];
      } finally {
        closed.resolve();
      }
    };
    const onProgress = vi.fn<(progress: { phase: string }) => void>();
    const generate = vi.fn(async () => {
      await failed.promise;
      throw new Error("provider unavailable");
    });
    const run = assessProductSourcePages(makeInput(), selected(), { generate, onProgress });
    await readStarted.promise;
    failed.resolve();
    const result = await run;
    expect(result.reviewCompleted).toBe(false);
    expect(result.status).toBe("blocked");
    const progressCount = onProgress.mock.calls.length;
    readGate.resolve();
    await closed.promise;
    expect(generate).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(progressCount);
  });

  it("cancels during a stalled AppSpec read after draining the active pair", async () => {
    const abort = new AbortController();
    const readStarted = deferred();
    const readGate = deferred();
    const modelGate = deferred();
    const modelStarted = deferred();
    const closed = deferred();
    const parts = async function* parts() {
      try {
        yield "x".repeat(20_000);
        readStarted.resolve();
        await readGate.promise;
        yield "late requirements";
      } finally {
        closed.resolve();
      }
    };
    const onProgress = vi.fn<(progress: { phase: string }) => void>();
    const journal = new Journal();
    const generate = vi.fn(async () => {
      modelStarted.resolve();
      await modelGate.promise;
      return judgment("requires runtime proof");
    });
    const run = assessProductSourcePages(makeInput(), stream(makePages(1)), {
      abortSignal: abort.signal,
      generate,
      journal,
      onProgress,
      reviewAppSpecParts: parts,
    });
    await Promise.all([readStarted.promise, modelStarted.promise]);
    abort.abort();
    let returned = false;
    const settled = run.finally(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    modelGate.resolve();
    await expect(settled).rejects.toThrow();
    const progressCount = onProgress.mock.calls.length;
    readGate.resolve();
    await closed.promise;
    expect(journal.records.size).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(progressCount);
  });
});
