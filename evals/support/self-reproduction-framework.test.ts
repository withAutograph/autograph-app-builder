import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runTrustedFrameworkEvidence } from "./self-reproduction-framework";
import { frameworkMatrix } from "./self-reproduction-parity";

function browser() {
  const close = vi.fn(() => Promise.resolve());
  const page = {};
  return {
    close,
    page,
    value: {
      newContext: () => Promise.resolve({ close, newPage: () => Promise.resolve(page) }),
    } as never,
  };
}

const adapter = {
  exerciseBrowser: (_page: unknown, id: string) => {
    const requirement = frameworkMatrix.find((row) => row.id === id)!;
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
    const outputRoot = await mkdtemp(join(tmpdir(), "self-reproduction-framework-"));
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
          join(outputRoot, "parity/framework/instant-navigation/candidate.json"),
          "utf-8",
        ),
      ),
    ).toMatchObject({ producer: "evaluator", side: "candidate" });
  });

  it("does not credit source review when browser evidence is unavailable", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "self-reproduction-framework-missing-"));
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
