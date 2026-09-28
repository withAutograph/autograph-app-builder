import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { assessProductSourcePages } from "./product-source-review";
import { readProductReviewSourcePages } from "./product-source-review-pages";

const path = "apps/example/page.tsx";
const source = `${"const value = 1;\n".repeat(28_000)}FIXME: fake save\n`;
const digest = createHash("sha256").update(source).digest("hex");
const reader = (expectedDigest = digest) =>
  readProductReviewSourcePages({
    appId: "example",
    applyRoot: "/workspace/repository",
    changedPaths: [],
    observed: {
      files: [{ digest: expectedDigest, mode: "644", path }],
      treeDigest: "tree",
    },
    sandbox: {
      // oxlint-disable-next-line eslint/require-await -- Preserve sandbox readFile contract.
      readFile: async () => new Blob([source]).stream(),
    },
  });

it("reviews source above the former 400 KB ceiling in bounded pages with exact original citations", async () => {
  const observed = reader();
  let pages = 0;
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
    appId: "example",
    applyRoot: "/workspace/repository",
    changedPaths: [],
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
