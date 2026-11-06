import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runTrustedFrameworkEvidence } from "./self-reproduction-framework";
import type { TrustedFrameworkAdapter } from "./self-reproduction-framework";
import { frameworkMatrix } from "./self-reproduction-parity";
import type { Page } from "playwright";

type FrameworkRequirement = (typeof frameworkMatrix)[number]["id"];

const browser = () => {
  const close = vi.fn(async () => {});
  const page = {};
  const value = {
    newContext: async () => {
      await Promise.resolve();
      return { close, newPage: async () => await Promise.resolve(page) };
    },
  };
  return { close, page, value };
};

const adapter = {
  exerciseBrowser: async (page: Page, id: FrameworkRequirement) => {
    await Promise.resolve(page);
    const requirement = frameworkMatrix.find((row) => row.id === id);
    if (!requirement) {
      throw new Error(`Unknown framework requirement: ${id}`);
    }
    return {
      artifacts: [],
      assertions: requirement.assertions.map((assertion) => ({
        artifacts: [],
        detail: "Observed runtime behavior.",
        id: assertion,
        passed: true,
      })),
      reason: "Browser assertions completed.",
    };
  },
  instantNavigationRecipe: async () =>
    await Promise.resolve({
      artifacts: [],
      ready: true as const,
      recipe: {
        baseURL: "http://candidate.test",
        destinationPath: "/docs",
        linkSelector: "a[href='/docs']",
        resolvedSelector: "article",
        shellSelector: "main",
        sourcePath: "/",
      },
    }),
  reviewSource: async () =>
    await Promise.resolve({
      artifacts: [],
      assertions: [],
      ready: true as const,
      reason: "Reviewed against installed Next 16.3.4 docs.",
    }),
} satisfies TrustedFrameworkAdapter;

describe("trusted framework evidence", () => {
  it("combines source and browser evidence and uses instant navigation", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "self-reproduction-framework-"));
    const fixture = browser();
    const runInstant = vi.fn(async () => {
      await Promise.resolve();
    });
    const result = await runTrustedFrameworkEvidence({
      adapters: { candidate: adapter },
      browser: fixture.value,
      outputRoot,
      runInstant,
    });
    expect(result.observations.candidate).toHaveLength(frameworkMatrix.length);
    expect(result.observations.reference.every((row) => row.disposition === "not-run")).toBe(true);
    expect(
      result.observations.candidate.find((row) => row.requirementId === "instant-navigation"),
    ).toMatchObject({ disposition: "observed", method: "@next/playwright/instant" });
    expect(runInstant).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        await readFile(
          path.join(outputRoot, "parity/framework/instant-navigation/candidate.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({ producer: "evaluator", side: "candidate" });
  });

  it("does not credit source review when browser evidence is unavailable", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "self-reproduction-framework-missing-"));
    const fixture = browser();
    const result = await runTrustedFrameworkEvidence({
      adapters: {
        candidate: {
          ...adapter,
          instantNavigationRecipe: async () =>
            await Promise.resolve({
              disposition: "infrastructure-unavailable" as const,
              ready: false as const,
              reason: "Production instant-navigation runtime was unavailable.",
            }),
        },
      },
      browser: fixture.value,
      outputRoot,
      runInstant: vi.fn(async () => {
        await Promise.resolve();
      }),
    });
    expect(
      result.observations.candidate.find((row) => row.requirementId === "instant-navigation"),
    ).toMatchObject({ disposition: "infrastructure-unavailable", method: "none" });
  });
});

it("retains sanitized diagnostics and blocks an evaluator exception", async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "self-reproduction-framework-error-"));
  const result = await runTrustedFrameworkEvidence({
    adapters: {
      candidate: {
        ...adapter,
        reviewSource: async () => {
          await Promise.resolve();
          throw new Error("Fixture unavailable Bearer private-secret");
        },
      },
    },
    browser: browser().value,
    outputRoot,
  });
  expect(result.observations.candidate[0]).toMatchObject({
    disposition: "infrastructure-unavailable",
  });
  const diagnostic = await readFile(
    path.join(outputRoot, "parity/framework/server-first/candidate-error.json"),
    "utf-8",
  );
  expect(diagnostic).toContain("Fixture unavailable");
  expect(diagnostic).toContain("[REDACTED]");
  expect(diagnostic).not.toContain("private-secret");
});

it("keeps a missing browser fixture unassessed after a source review", async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "self-reproduction-framework-unbound-"));
  const result = await runTrustedFrameworkEvidence({
    adapters: {
      candidate: {
        ...adapter,
        exerciseBrowser: async () =>
          await Promise.resolve({
            artifacts: [],
            assertions: [],
            disposition: "not-run",
            reason: "Fixture not bound",
          }),
      },
    },
    browser: browser().value,
    outputRoot,
    runInstant: vi.fn(async () => {
      await Promise.resolve();
    }),
  });
  expect(
    result.observations.candidate.find((row) => row.requirementId === "server-first"),
  ).toMatchObject({ disposition: "not-run" });
});

it("retains an executed instant assertion failure as observed failure", async () => {
  const outputRoot = await mkdtemp(
    path.join(tmpdir(), "self-reproduction-framework-instant-failure-"),
  );
  const result = await runTrustedFrameworkEvidence({
    adapters: { candidate: adapter },
    browser: browser().value,
    outputRoot,
    runInstant: async () => {
      await Promise.resolve();
      throw new Error("Resolved content never appeared");
    },
  });
  expect(
    result.observations.candidate.find((row) => row.requirementId === "instant-navigation"),
  ).toMatchObject({
    assertions: [{ passed: false }],
    disposition: "observed",
  });
});
