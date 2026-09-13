import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runTrustedFrameworkEvidence } from "./self-reproduction-framework";
import { frameworkMatrix } from "./self-reproduction-parity";

const browser = () => {
  const close = vi.fn(() => Promise.resolve());
  const page = {};
  return {
    close,
    page,
    value: {
      newContext: () => Promise.resolve({ close, newPage: () => Promise.resolve(page) }),
    } as never,
  };
};

const adapter = {
  exerciseBrowser: (_page: unknown, id: string) => {
    const requirement = frameworkMatrix.find((row) => row.id === id);
    if (!requirement) throw new Error(`Unknown framework requirement: ${id}`);
    return Promise.resolve({
      artifacts: [],
      assertions: requirement.assertions.map((assertion) => ({
        artifacts: [],
        detail: "Observed runtime behavior.",
        id: assertion,
        passed: true,
      })),
      reason: "Browser assertions completed.",
    });
  },
  instantNavigationRecipe: () =>
    Promise.resolve({
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
  reviewSource: () =>
    Promise.resolve({
      artifacts: [],
      assertions: [],
      ready: true as const,
      reason: "Reviewed against installed Next 16.3.4 docs.",
    }),
};

describe("trusted framework evidence", () => {
  it("combines source and browser evidence and uses instant navigation", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "self-reproduction-framework-"));
    const fixture = browser();
    const runInstant = vi.fn(() => Promise.resolve());
    const result = await runTrustedFrameworkEvidence({
      adapters: { candidate: adapter as never },
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
          instantNavigationRecipe: () =>
            Promise.resolve({
              disposition: "infrastructure-unavailable" as const,
              ready: false as const,
              reason: "Production instant-navigation runtime was unavailable.",
            }),
        } as never,
      },
      browser: fixture.value,
      outputRoot,
      runInstant: vi.fn(() => Promise.resolve()),
    });
    expect(
      result.observations.candidate.find((row) => row.requirementId === "instant-navigation"),
    ).toMatchObject({ disposition: "infrastructure-unavailable", method: "none" });
  });
});

it("retains sanitized diagnostics and blocks an evaluator exception", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "self-reproduction-framework-error-"));
  const result = await runTrustedFrameworkEvidence({
    browser: browser().value,
    outputRoot,
    adapters: {
      candidate: {
        ...adapter,
        reviewSource: () => Promise.reject(new Error("Fixture unavailable Bearer private-secret")),
      } as never,
    },
  });
  expect(result.observations.candidate[0]).toMatchObject({
    disposition: "infrastructure-unavailable",
  });
  const diagnostic = await readFile(
    join(outputRoot, "parity/framework/server-first/candidate-error.json"),
    "utf-8",
  );
  expect(diagnostic).toContain("Fixture unavailable");
  expect(diagnostic).toContain("[REDACTED]");
  expect(diagnostic).not.toContain("private-secret");
});

it("keeps a missing browser fixture unassessed after a source review", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "self-reproduction-framework-unbound-"));
  const result = await runTrustedFrameworkEvidence({
    browser: browser().value,
    outputRoot,
    adapters: {
      candidate: {
        ...adapter,
        exerciseBrowser: () =>
          Promise.resolve({
            disposition: "not-run",
            reason: "Fixture not bound",
            assertions: [],
            artifacts: [],
          }),
      } as never,
    },
    runInstant: vi.fn(() => Promise.resolve()),
  });
  expect(
    result.observations.candidate.find((row) => row.requirementId === "server-first"),
  ).toMatchObject({ disposition: "not-run" });
});

it("retains an executed instant assertion failure as observed failure", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "self-reproduction-framework-instant-failure-"));
  const result = await runTrustedFrameworkEvidence({
    browser: browser().value,
    outputRoot,
    adapters: { candidate: adapter as never },
    runInstant: () => Promise.reject(new Error("Resolved content never appeared")),
  });
  expect(
    result.observations.candidate.find((row) => row.requirementId === "instant-navigation"),
  ).toMatchObject({
    disposition: "observed",
    assertions: [{ passed: false }],
  });
});
