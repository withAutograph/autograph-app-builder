import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { assessProductSourcePages } from "./product-source-review";
import { readProductReviewSourcePages } from "./product-source-review-pages";

const path = "apps/example/page.tsx";
const source = `${"const value = 1;\n".repeat(28_000)}FIXME: fake save\n`;
const digest = createHash("sha256").update(source).digest("hex");
const reader = (expectedDigest = digest) =>
  readProductReviewSourcePages({
    applyRoot: "/workspace/repository",
    changedPaths: [path],
    observed: {
      files: [{ digest: expectedDigest, mode: "644", path }],
      treeDigest: "tree",
    },
    sandbox: {
      // oxlint-disable-next-line eslint/require-await -- Preserve sandbox readFile contract.
      readFile: async () => new Blob([source]).stream(),
    },
  });

it("reviews current changed files without rereading unchanged app source", async () => {
  const changed = "export const changed = true;";
  const unchanged = "export const unchanged = true;";
  const changedPath = "apps/example/changed.ts";
  const unchangedPath = "apps/example/unchanged.ts";
  // oxlint-disable-next-line eslint/require-await -- Match the asynchronous sandbox readFile contract.
  const readFile = vi.fn(async () => new Blob([changed]).stream());
  const observed = readProductReviewSourcePages({
    applyRoot: "/workspace/repository",
    changedPaths: [changedPath],
    observed: {
      files: [
        {
          digest: createHash("sha256").update(changed).digest("hex"),
          mode: "644",
          path: changedPath,
        },
        {
          digest: createHash("sha256").update(unchanged).digest("hex"),
          mode: "644",
          path: unchangedPath,
        },
      ],
      treeDigest: "tree",
    },
    sandbox: { readFile },
  });
  const pages = [];
  for await (const page of observed.pages) {
    pages.push(page);
  }
  expect(pages.map((page) => page.path)).toEqual([changedPath]);
  expect(readFile).toHaveBeenCalledTimes(1);
});

it("reviews source above the former 400 KB ceiling in bounded pages with exact original citations", async () => {
  const observed = reader();
  let pages = 0;
  const onProgress = vi.fn();
  const assessment = await assessProductSourcePages(
    {
      appSpec: "Save the request durably.",
      appSpecDigest: "spec",
      clarifications: [],
      omissions: observed.omissions,
      originalRequest: "Save the request durably.",
      sourceDigest: "tree",
    },
    observed.pages,
    {
      generate(page) {
        pages += 1;
        const lines = page.content.split(/\r?\n/u);
        const relativeLine = lines.indexOf("FIXME: fake save") + 1;
        return {
          findings:
            relativeLine === 0
              ? []
              : [
                  {
                    citations: [
                      {
                        endLine: relativeLine,
                        excerpt: "FIXME: fake save",
                        path,
                        startLine: relativeLine,
                      },
                    ],
                    explanation: "The save is fake.",
                    repair: "Persist the request.",
                    requirement: "Durable save",
                    requirementQuote: "Save the request durably.",
                  },
                ],
          remainingRuntimeChecks: [],
        };
      },
      onProgress(progress) {
        onProgress(progress);
      },
    },
  );
  expect(pages).toBeGreaterThan(5);
  expect(assessment.reviewCompleted).toBe(true);
  expect(assessment.status).toBe("failed");
  expect(assessment.findings[0]?.citations[0]).toMatchObject({
    endLine: 28_001,
    path,
    startLine: 28_001,
  });
  expect(assessment.omissions).not.toContain(`${path}: model context omitted`);
  expect(onProgress).toHaveBeenCalledWith(
    expect.objectContaining({ path, phase: "context_started", startLine: 1 }),
  );
  expect(onProgress).toHaveBeenCalledWith(
    expect.objectContaining({ path, phase: "context_result", status: "failed" }),
  );
});

it("rejects a changed source digest after yielding pages", async () => {
  const observed = reader("0".repeat(64));
  await expect(async () => {
    for await (const page of observed.pages) {
      // The digest is verified after the final page.
      expect(page.path).toBe(path);
    }
  }).rejects.toThrow("Source changed during review");
});

it("splits a giant Unicode line without losing bytes or source coordinates", async () => {
  const content = `header\n${"🚀".repeat(30_000)}`;
  const observed = readProductReviewSourcePages({
    applyRoot: "/workspace/repository",
    changedPaths: [path],
    observed: {
      files: [
        {
          digest: createHash("sha256").update(content).digest("hex"),
          mode: "644",
          path,
        },
      ],
      treeDigest: "tree",
    },
    sandbox: {
      // oxlint-disable-next-line eslint/require-await -- Preserve sandbox readFile contract.
      readFile: async () => new Blob([content]).stream(),
    },
  });
  const pages = [];
  for await (const page of observed.pages) {
    pages.push(page);
  }
  expect(pages.map(({ content: part }) => part).join("")).toBe(content);
  expect(pages[0]).toMatchObject({ startColumn: 1, startLine: 1 });
  expect(pages[1]).toMatchObject({ startLine: 2 });
  expect(pages.every(({ content: part }) => !/[\uD800-\uDBFF]$/u.test(part))).toBe(true);
});

it("does not complete a paged review with an invented citation", async () => {
  const observed = reader();
  const assessment = await assessProductSourcePages(
    {
      appSpec: "Save the request durably.",
      appSpecDigest: "spec",
      clarifications: [],
      omissions: observed.omissions,
      originalRequest: "Save the request durably.",
      sourceDigest: "tree",
    },
    observed.pages,
    {
      generate: () => ({
        findings: [
          {
            citations: [{ endLine: 1, excerpt: "invented", path, startLine: 1 }],
            explanation: "An unsupported claim.",
            repair: "Repair it.",
            requirement: "Durable save",
            requirementQuote: "Save the request durably.",
          },
        ],
        remainingRuntimeChecks: [],
      }),
    },
  );
  expect(assessment.reviewCompleted).toBe(false);
  expect(assessment.findings).toEqual([]);
});

it("sends a large request history through bounded model contexts", async () => {
  const page = { content: "fake save", path, startColumn: 1, startLine: 3 };
  const seen: { kind: string; length: number; offset: number }[] = [];
  const requirement = "Must save durably";
  const assessment = await assessProductSourcePages(
    {
      appSpec: "p".repeat(45_000),
      appSpecDigest: "spec",
      clarifications: [`${"c".repeat(45_000)}${requirement}`],
      omissions: [],
      originalRequest: "r".repeat(45_000),
      sourceDigest: "tree",
    },
    (async function* pages() {
      yield page;
    })(),
    {
      generate(_page, context) {
        seen.push({ kind: context.kind, length: context.text.length, offset: context.startOffset });
        return {
          findings: context.text.includes(requirement)
            ? [
                {
                  citations: [{ endLine: 1, excerpt: "fake save", path, startLine: 1 }],
                  explanation: "The save is fake.",
                  repair: "Persist it.",
                  requirement: "Durable save",
                  requirementQuote: requirement,
                },
              ]
            : [],
          remainingRuntimeChecks: [],
        };
      },
    },
  );
  expect(seen.some((entry) => entry.kind === "request-history" && entry.offset > 0)).toBe(true);
  expect(seen.every((entry) => entry.length <= 16 * 1024)).toBe(true);
  expect(assessment.reviewCompleted).toBe(true);
  expect(assessment.findings[0]?.citations[0]?.startLine).toBe(3);
});

it("reads a large accepted AppSpec from scoped pages for every source page", async () => {
  const requirement = "The export must survive a restart.";
  const content = `${"A product requirement. ".repeat(6 * 10 ** 3)}${requirement}`;
  const seen: string[] = [];
  let reads = 0;
  const assessment = await assessProductSourcePages(
    {
      appSpec: "",
      appSpecDigest: "verified-spec-digest",
      clarifications: [],
      omissions: [],
      originalRequest: "Build an export.",
      sourceDigest: "source-tree",
    },
    (async function* pages() {
      yield { content: "fake export", path, startColumn: 1, startLine: 1 };
      yield { content: "fake export", path, startColumn: 1, startLine: 2 };
    })(),
    {
      generate(_page, context) {
        seen.push(context.text);
        return {
          findings: context.text.includes(requirement)
            ? [
                {
                  citations: [{ endLine: 1, excerpt: "fake export", path, startLine: 1 }],
                  explanation: "The export is only simulated.",
                  repair: "Persist the export.",
                  requirement: "Durable export",
                  requirementQuote: requirement,
                },
              ]
            : [],
          remainingRuntimeChecks: [],
        };
      },
      reviewAppSpecParts: () =>
        (async function* parts() {
          reads += 1;
          for (let offset = 0; offset < content.length; offset += 8 * 1024) {
            yield content.slice(offset, offset + 8 * 1024);
          }
        })(),
    },
  );
  expect(assessment.reviewCompleted).toBe(true);
  expect(assessment.status).toBe("failed");
  expect(reads).toBe(2);
  expect(seen.some((context) => context.includes(requirement))).toBe(true);
  expect(Math.max(...seen.map((context) => context.length))).toBeLessThanOrEqual(16 * 1024);
});

it("reviews ordinary chronological clarifications together for each source page", async () => {
  const contexts: string[] = [];
  const clarifications = Array.from({ length: 12 }, (_, index) => `Requirement ${index + 1}`);
  const assessment = await assessProductSourcePages(
    {
      appSpec: "Accepted plan",
      appSpecDigest: "spec",
      clarifications,
      omissions: [],
      originalRequest: "Original requirement",
      sourceDigest: "tree",
    },
    (async function* pages() {
      yield { content: "export const value = true;", path, startColumn: 1, startLine: 1 };
    })(),
    {
      generate(_page, context) {
        contexts.push(context.text);
        return { findings: [], remainingRuntimeChecks: [] };
      },
    },
  );
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toContain("Original request:\nOriginal requirement");
  for (const [index, clarification] of clarifications.entries()) {
    expect(contexts[0]).toContain(`Clarification ${index + 1}:\n${clarification}`);
  }
  expect(contexts[0]).toContain("Accepted AppSpec:\nAccepted plan");
  expect(assessment.reviewCompleted).toBe(true);
});

it("rejects a finding that quotes only a generated request-history label", async () => {
  const assessment = await assessProductSourcePages(
    {
      appSpec: "Accepted plan",
      appSpecDigest: "spec",
      clarifications: [],
      omissions: [],
      originalRequest: "Original requirement",
      sourceDigest: "tree",
    },
    (async function* pages() {
      yield { content: "fake save", path, startColumn: 1, startLine: 1 };
    })(),
    {
      generate: () => ({
        findings: [
          {
            citations: [{ endLine: 1, excerpt: "fake save", path, startLine: 1 }],
            explanation: "Unsupported claim",
            repair: "Repair",
            requirement: "Synthetic label",
            requirementQuote: "Original request:",
          },
        ],
        remainingRuntimeChecks: [],
      }),
    },
  );
  expect(assessment.reviewCompleted).toBe(false);
});

it("retries a provider context rejection with smaller source and requirement slices", async () => {
  let attempts = 0;
  const assessment = await assessProductSourcePages(
    {
      appSpec: "plan",
      appSpecDigest: "spec",
      clarifications: [],
      omissions: [],
      originalRequest: "r".repeat(1500),
      sourceDigest: "tree",
    },
    (async function* pages() {
      yield { content: "s".repeat(500), path, startColumn: 1, startLine: 1 };
    })(),
    {
      generate(page, context) {
        attempts += 1;
        if (page.content.length + context.text.length > 1000) {
          throw new Error("maximum context length exceeded");
        }
        return { findings: [], remainingRuntimeChecks: [] };
      },
    },
  );
  expect(attempts).toBeGreaterThan(3);
  expect(assessment.reviewCompleted).toBe(true);
});

it("reports a provider boundary when even the smallest review pair is rejected", async () => {
  const assessment = await assessProductSourcePages(
    {
      appSpec: "p",
      appSpecDigest: "spec",
      clarifications: [],
      omissions: [],
      originalRequest: "r",
      sourceDigest: "tree",
    },
    (async function* pages() {
      yield { content: "s", path, startColumn: 1, startLine: 7 };
    })(),
    {
      generate() {
        throw new Error("maximum context length exceeded");
      },
    },
  );
  expect(assessment).toMatchObject({ reviewCompleted: false, status: "blocked" });
  expect(assessment.reason).toContain(`${path}:7:1`);
  expect(assessment.reason).toContain("model provider rejected");
});
