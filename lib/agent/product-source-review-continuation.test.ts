import { describe, expect, it, vi } from "vitest";
import { assessProductSourcePages, sourceReviewPairKey } from "./product-source-review";
import type { ProductSourceReviewInput, SourceJudgment } from "./product-source-review";
import type { ProductReviewSourcePage } from "./product-source-review-pages";
import type {
  SourceReviewJournal,
  SourceReviewJournalRecord,
} from "./product-source-review-journal";

class Journal implements SourceReviewJournal {
  readonly records = new Map<string, SourceReviewJournalRecord>();
  async read(key: string) {
    return await Promise.resolve(this.records.get(key));
  }
  async put(key: string, record: SourceReviewJournalRecord) {
    const canonical = this.records.get(key) ?? record;
    this.records.set(key, canonical);
    return await Promise.resolve(canonical);
  }
}
const input: Omit<ProductSourceReviewInput, "files"> = {
  appSpec: "Implement every original outcome",
  appSpecDigest: "spec",
  clarifications: ["Keep the history"],
  omissions: [],
  originalRequest: "Save records on the server",
  sourceDigest: "source",
};
const firstPage: ProductReviewSourcePage = {
  content: "const first = true;",
  path: "apps/example/a.ts",
  startColumn: 1,
  startLine: 1,
};
const secondPage: ProductReviewSourcePage = {
  content: "const second = true;",
  path: "apps/example/b.ts",
  startColumn: 1,
  startLine: 1,
};
const pages = [firstPage, secondPage];
const stream = async function* stream(values = pages) {
  yield* values;
};
const empty: SourceJudgment = {
  findings: [],
  remainingRuntimeChecks: ["Execute independent readback"],
};

describe("durable source review continuation", () => {
  it("reuses completed pairs after interruption and retains identical complete aggregation", async () => {
    const journal = new Journal();
    const aborted = new AbortController();
    const initial = vi.fn((page: ProductReviewSourcePage) => {
      if (page.path === pages[1]?.path) {
        aborted.abort();
        aborted.signal.throwIfAborted();
      }
      return empty;
    });
    await expect(
      assessProductSourcePages(input, stream(), {
        abortSignal: aborted.signal,
        generate: initial,
        journal,
      }),
    ).rejects.toThrow();
    expect(
      [...journal.records.values()].filter((record) => record.kind === "completed"),
    ).toHaveLength(1);
    const resumed = vi.fn(() => empty);
    const result = await assessProductSourcePages(input, stream(), { generate: resumed, journal });
    expect(resumed).toHaveBeenCalledTimes(1);
    const fresh = await assessProductSourcePages(input, stream(), { generate: () => empty });
    expect(result).toEqual(fresh);
    const replay = vi.fn(() => empty);
    expect(await assessProductSourcePages(input, stream(), { generate: replay, journal })).toEqual(
      fresh,
    );
    expect(replay).not.toHaveBeenCalled();
  });

  it("retains every streamed request/AppSpec/clarification context across retry", async () => {
    const journal = new Journal();
    const contexts: string[] = [];
    const specText = "entire accepted spec ".repeat(2000);
    const parts = async function* parts() {
      yield specText;
    };
    const generate = vi.fn((_page: ProductReviewSourcePage, context: { text: string }) => {
      contexts.push(context.text);
      return empty;
    });
    const result = await assessProductSourcePages(input, stream(), {
      generate,
      journal,
      reviewAppSpecParts: parts,
    });
    expect(contexts.join("")).toContain(input.originalRequest);
    expect(contexts.join("")).toContain(input.clarifications[0]);
    expect(contexts.join("")).toContain("entire accepted spec");
    expect(generate.mock.calls.some(([page]) => page.path === pages[0]?.path)).toBe(true);
    expect(generate.mock.calls.some(([page]) => page.path === pages[1]?.path)).toBe(true);
    const replay = vi.fn(() => empty);
    expect(
      await assessProductSourcePages(input, stream(), {
        generate: replay,
        journal,
        reviewAppSpecParts: parts,
      }),
    ).toEqual(result);
    expect(replay).not.toHaveBeenCalled();
  });

  it("persists provider split decisions and resumes completed children without repeating rejected parents", async () => {
    const journal = new Journal();
    const page = {
      content: "x".repeat(400),
      path: "apps/example/large.ts",
      startColumn: 1,
      startLine: 1,
    };
    const aborted = new AbortController();
    const first = vi.fn((part: ProductReviewSourcePage) => {
      if (part.content.length > 250) {
        throw new Error("maximum context length exceeded");
      }
      if (part.startColumn > 1) {
        aborted.abort();
        aborted.signal.throwIfAborted();
      }
      return empty;
    });
    await expect(
      assessProductSourcePages(input, stream([page]), {
        abortSignal: aborted.signal,
        generate: first,
        journal,
      }),
    ).rejects.toThrow();
    expect([...journal.records.values()].some((record) => record.kind === "split-source")).toBe(
      true,
    );
    const next = vi.fn(() => empty);
    const result = await assessProductSourcePages(input, stream([page]), {
      generate: next,
      journal,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(result.reviewCompleted).toBe(true);
    expect(next.mock.calls.length).toBeLessThan(first.mock.calls.length);
  });

  it("treats changed pages, contexts, omissions, or models as new cache identities", async () => {
    const journal = new Journal();
    await assessProductSourcePages(input, stream(), { generate: () => empty, journal });
    const changed = vi.fn(() => empty);
    const changedAssessment = await assessProductSourcePages(
      { ...input, omissions: ["temporarily unreadable path"] },
      stream(),
      { generate: changed, journal },
    );
    expect(changedAssessment.reviewCompleted).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    const refreshed = vi.fn(() => empty);
    await assessProductSourcePages(
      input,
      stream([{ ...pages[0], content: "new source" }, pages[1]]),
      { generate: refreshed, journal },
    );
    expect(refreshed).toHaveBeenCalledTimes(1);
    const base = { ...input, files: [] };
    const context = {
      digest: "context",
      index: 0,
      kind: "request-history" as const,
      startOffset: 0,
      text: "requirement",
    };
    expect(sourceReviewPairKey(base, pages[0], context, "model-a")).not.toBe(
      sourceReviewPairKey(base, pages[0], context, "model-b"),
    );
    expect(sourceReviewPairKey(base, pages[0], context)).not.toBe(
      sourceReviewPairKey(base, pages[0], { ...context, text: "changed requirement" }),
    );
  });

  it("does not persist a judgment when its invocation aborts before commit or fails validation", async () => {
    const journal = new Journal();
    const abort = new AbortController();
    await expect(
      assessProductSourcePages(input, stream([pages[0]]), {
        abortSignal: abort.signal,
        generate: () => {
          abort.abort();
          return empty;
        },
        journal,
      }),
    ).rejects.toThrow();
    expect(journal.records.size).toBe(0);
    const failed = await assessProductSourcePages(input, stream([pages[0]]), {
      generate: () => ({
        findings: [
          {
            citations: [],
            explanation: "bad",
            repair: "bad",
            requirement: "bad",
            requirementQuote: "invented",
          },
        ],
        remainingRuntimeChecks: [],
      }),
      journal,
    });
    expect(failed.reviewCompleted).toBe(false);
    expect(journal.records.size).toBe(0);
  });

  it("uses the same canonical first-writer result for concurrent valid retries", async () => {
    const journal = new Journal();
    let release: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new -- Both retries deliberately overlap at the same model boundary.
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const generate = async () => {
      started += 1;
      const invocation = started;
      if (invocation === 2) {
        release?.();
      }
      await ready;
      return { ...empty, remainingRuntimeChecks: [`result-${invocation}`] };
    };
    const [first, second] = await Promise.all([
      assessProductSourcePages(input, stream([pages[0]]), { generate, journal }),
      assessProductSourcePages(input, stream([pages[0]]), { generate, journal }),
    ]);
    expect(first).toEqual(second);
    expect(journal.records.size).toBe(1);
  });

  it("retains completed work after a partial source stream fails and replays every split requirement context", async () => {
    const journal = new Journal();
    const interrupted = async function* interrupted() {
      yield firstPage;
      throw new Error("source read interrupted");
    };
    await expect(
      assessProductSourcePages(input, interrupted(), { generate: () => empty, journal }),
    ).rejects.toThrow("source read interrupted");
    const resumed = vi.fn(() => empty);
    const result = await assessProductSourcePages(input, stream(), { generate: resumed, journal });
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(result.reviewCompleted).toBe(true);
    const contextJournal = new Journal();
    const expanded = {
      ...input,
      appSpec: "full requirement ".repeat(100),
      appSpecDigest: "expanded-spec",
    };
    const generate = vi.fn((_page: ProductReviewSourcePage, context: { text: string }) => {
      if (context.text.length > 350) {
        throw new Error("maximum context length exceeded");
      }
      return empty;
    });
    const assessed = await assessProductSourcePages(expanded, stream([firstPage]), {
      generate,
      journal: contextJournal,
    });
    expect(assessed.reviewCompleted).toBe(true);
    expect(
      [...contextJournal.records.values()].some((record) => record.kind === "split-context"),
    ).toBe(true);
    const replay = vi.fn(() => empty);
    expect(
      await assessProductSourcePages(expanded, stream([firstPage]), {
        generate: replay,
        journal: contextJournal,
      }),
    ).toEqual(assessed);
    expect(replay).not.toHaveBeenCalled();
  });

  it("stores only sanitized opinions and digest references instead of quoted requirements or source", async () => {
    const journal = new Journal();
    const request = input.originalRequest ?? "";
    const quote = firstPage.content;
    const prose = `${request} ${quote} Bearer private_credential`;
    const result = await assessProductSourcePages(input, stream([firstPage]), {
      generate: () => ({
        findings: [
          {
            citations: [{ endLine: 1, excerpt: quote, path: firstPage.path, startLine: 1 }],
            explanation: prose,
            repair: prose,
            requirement: prose,
            requirementQuote: request,
          },
        ],
        remainingRuntimeChecks: [prose],
      }),
      journal,
    });
    expect(result.reviewCompleted).toBe(true);
    const bytes = JSON.stringify([...journal.records.values()]);
    expect(bytes).not.toContain(request);
    expect(bytes).not.toContain(quote);
    expect(bytes).not.toContain("private_credential");
    expect(result.findings[0]?.citations[0]?.excerptDigest).toHaveLength(64);
    expect(result.findings[0]?.requirementQuoteDigest).toHaveLength(64);
  });
});
