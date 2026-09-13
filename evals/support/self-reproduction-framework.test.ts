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
    value: {
      newContext: () => Promise.resolve({ newPage: () => Promise.resolve(page), close }),
    } as never,
    page,
    close,
  };
}

const adapter = {
  reviewSource: () =>
    Promise.resolve({
      ready: true as const,
      reason: "Reviewed against installed Next 16.3.4 docs.",
      assertions: [],
      artifacts: [],
    }),
  exerciseBrowser: (_page: unknown, id: string) => {
    const requirement = frameworkMatrix.find((row) => row.id === id)!;
    return Promise.resolve({
      reason: "Browser assertions completed.",
      artifacts: [],
      assertions: requirement.assertions.map((assertion) => ({
        id: assertion,
        passed: true,
        detail: "Observed runtime behavior.",
        artifacts: [],
      })),
    });
  },
  instantNavigationRecipe: () =>
    Promise.resolve({
      ready: true as const,
      recipe: {
        baseURL: "http://candidate.test",
        destinationPath: "/docs",
        sourcePath: "/",
        linkSelector: "a[href='/docs']",
        shellSelector: "main",
        resolvedSelector: "article",
      },
      artifacts: [],
    }),
};

describe("trusted framework evidence", () => {
  it("combines source and browser evidence and uses instant navigation", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "self-reproduction-framework-"));
    const fixture = browser();
    const runInstant = vi.fn(() => Promise.resolve());
    const result = await runTrustedFrameworkEvidence({
      browser: fixture.value,
      outputRoot,
      adapters: { candidate: adapter as never },
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
      browser: fixture.value,
      outputRoot,
      adapters: {
        candidate: {
          ...adapter,
          instantNavigationRecipe: () =>
            Promise.resolve({
              ready: false as const,
              disposition: "infrastructure-unavailable" as const,
              reason: "Production instant-navigation runtime was unavailable.",
            }),
        } as never,
      },
      runInstant: vi.fn(() => Promise.resolve()),
    });
    expect(
      result.observations.candidate.find((row) => row.requirementId === "instant-navigation"),
    ).toMatchObject({ disposition: "infrastructure-unavailable", method: "none" });
  });
});
