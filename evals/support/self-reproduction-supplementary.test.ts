import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Observation } from "./self-reproduction-parity";
import {
  mergeSupplementaryObservation,
  writeSupplementaryAssessment,
} from "./self-reproduction-supplementary";

const observation = (passed: boolean, method: Observation["method"]): Observation => ({
  requirementId: "server-first",
  disposition: "observed",
  reason: "Evaluator finding",
  method,
  artifacts: ["source-evidence.json"],
  assertions: [
    {
      id: "request-data-on-server",
      passed,
      detail: "Actual source review",
      artifacts: ["source-evidence.json"],
    },
  ],
});
describe("supplementary assessment", () => {
  it("preserves failures when assertions conflict and does not turn source-only review into browser credit", () => {
    expect(
      mergeSupplementaryObservation(
        observation(false, "browser"),
        observation(true, "source-review"),
      ).assertions[0]?.passed,
    ).toBe(false);
    expect(
      mergeSupplementaryObservation(undefined, observation(true, "source-review")).method,
    ).toBe("source-review");
    const missing = {
      ...observation(true, "browser"),
      disposition: "missing-functionality" as const,
    };
    expect(
      mergeSupplementaryObservation(missing, observation(true, "source-review")).disposition,
    ).toBe("missing-functionality");
  });
  it("retains missing evidence as unassessed and leaves original inputs unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "supplementary-test-"));
    try {
      const run = join(root, "run");
      const review = join(root, "review");
      await mkdir(run);
      await mkdir(review);
      const side = {
        output: "available",
        reason: "Source retained",
        sourceRevision: "revision",
        observations: [],
      };
      const original = JSON.stringify({
        schemaVersion: "self-reproduction-parity/v1",
        runId: "original",
        producer: "evaluator",
        fixtureVersion: 1,
        reference: side,
        candidate: side,
      });
      await writeFile(join(run, "parity-evidence.json"), original);
      const captures = join(root, "captures");
      await mkdir(captures);
      const viewports = ["desktop", "desktop-wide", "desktop-window"];
      await Promise.all(
        viewports.map(async (name) => {
          await mkdir(join(run, "candidate-browser", name), { recursive: true });
          await writeFile(join(run, "candidate-browser", name, "root.png"), "candidate screenshot");
          await writeFile(join(captures, `${name}-0.png`), "reference screenshot");
        }),
      );
      await writeFile(
        join(captures, "capture-provenance.json"),
        JSON.stringify({
          authenticated: true,
          comparisonQualification:
            "Authenticated reference; candidate has no authentication. Layout diagnostics only.",
          captures: viewports.map((name) => ({
            viewport: { name, width: 1440, height: 900 },
            path: join(captures, `${name}-0.png`),
          })),
        }),
      );
      await writeFile(
        join(run, "report.json"),
        JSON.stringify({
          captures: [{ files: viewports.map((name) => `candidate-browser/${name}/root.png`) }],
        }),
      );
      await writeFile(join(run, "revisions.json"), "{}");
      await writeFile(
        join(review, "observations.json"),
        JSON.stringify({
          schemaVersion: "self-reproduction-source-review/v1",
          observations: { candidate: [observation(false, "source-review")] },
        }),
      );
      await writeFile(join(review, "source-evidence.json"), "");
      const result = await writeSupplementaryAssessment({
        runDirectory: run,
        sourceReviewDirectory: review,
        outputDirectory: join(root, "out"),
        referenceCapturesDirectory: captures,
      });
      expect(
        result.assessment.rows.find(
          (row) => row.side === "candidate" && row.requirementId === "server-first",
        )?.status,
      ).toBe("unassessed");
      expect(await readFile(join(run, "parity-evidence.json"), "utf-8")).toBe(original);
      expect(
        result.missingEvidence.some((item) => item.includes("nonempty contained regular file")),
      ).toBe(true);
      await expect(
        writeSupplementaryAssessment({
          runDirectory: run,
          sourceReviewDirectory: review,
          outputDirectory: join(import.meta.dirname, "forbidden-report-output"),
        }),
      ).rejects.toThrow("outside the App Builder source tree");
      expect(result.screenshotPairs.map(({ viewport }) => viewport)).toEqual(viewports);
      expect(
        result.screenshotPairs.every(({ qualification }) =>
          qualification.includes("candidate has no authentication"),
        ),
      ).toBe(true);
      const html = await readFile(join(root, "out", "index.html"), "utf-8");
      expect(html.indexOf("Initial screen comparison")).toBeLessThan(
        html.indexOf("All requirement outcomes"),
      );
      expect(html).not.toContain("<pre>");
      expect(html).toContain('href="source-review/source-evidence.json"');

      await expect(
        writeSupplementaryAssessment({
          runDirectory: run,
          sourceReviewDirectory: run,
          outputDirectory: join(root, "missing-review"),
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
