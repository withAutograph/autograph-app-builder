import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Observation } from "./self-reproduction-parity";
import {
  mergeSupplementaryObservation,
  writeSupplementaryAssessment,
} from "./self-reproduction-supplementary";

const observation = (passed: boolean, method: Observation["method"]): Observation => ({
  artifacts: ["source-evidence.json"],
  assertions: [
    {
      artifacts: ["source-evidence.json"],
      detail: "Actual source review",
      id: "request-data-on-server",
      passed,
    },
  ],
  disposition: "observed",
  method,
  reason: "Evaluator finding",
  requirementId: "server-first",
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
    const root = await mkdtemp(path.join(tmpdir(), "supplementary-test-"));
    try {
      const run = path.join(root, "run");
      const review = path.join(root, "review");
      await mkdir(run);
      await mkdir(review);
      const side = {
        observations: [],
        output: "available",
        reason: "Source retained",
        sourceRevision: "revision",
      };
      const original = JSON.stringify({
        candidate: side,
        fixtureVersion: 1,
        producer: "evaluator",
        reference: side,
        runId: "original",
        schemaVersion: "self-reproduction-parity/v1",
      });
      await writeFile(path.join(run, "parity-evidence.json"), original);
      const captures = path.join(root, "captures");
      await mkdir(captures);
      const viewports = ["desktop", "desktop-wide", "desktop-window"];
      await Promise.all(
        viewports.map(async (name) => {
          await mkdir(path.join(run, "candidate-browser", name), { recursive: true });
          await writeFile(
            path.join(run, "candidate-browser", name, "root.png"),
            "candidate screenshot",
          );
          await writeFile(path.join(captures, `${name}-0.png`), "reference screenshot");
        }),
      );
      await writeFile(
        path.join(captures, "capture-provenance.json"),
        JSON.stringify({
          authenticated: true,
          captures: viewports.map((name) => ({
            path: path.join(captures, `${name}-0.png`),
            viewport: { height: 900, name, width: 1440 },
          })),
          comparisonQualification:
            "Authenticated reference; candidate has no authentication. Layout diagnostics only.",
        }),
      );
      await writeFile(
        path.join(run, "report.json"),
        JSON.stringify({
          captures: [{ files: viewports.map((name) => `candidate-browser/${name}/root.png`) }],
        }),
      );
      await writeFile(path.join(run, "revisions.json"), "{}");
      await writeFile(
        path.join(review, "observations.json"),
        JSON.stringify({
          observations: { candidate: [observation(false, "source-review")] },
          schemaVersion: "self-reproduction-source-review/v1",
        }),
      );
      await writeFile(path.join(review, "source-evidence.json"), "");
      const result = await writeSupplementaryAssessment({
        outputDirectory: path.join(root, "out"),
        referenceCapturesDirectory: captures,
        runDirectory: run,
        sourceReviewDirectory: review,
      });
      expect(
        result.assessment.rows.find(
          (row) => row.side === "candidate" && row.requirementId === "server-first",
        )?.status,
      ).toBe("unassessed");
      expect(await readFile(path.join(run, "parity-evidence.json"), "utf-8")).toBe(original);
      expect(
        result.missingEvidence.some((item) => item.includes("nonempty contained regular file")),
      ).toBe(true);
      await expect(
        writeSupplementaryAssessment({
          outputDirectory: path.join(import.meta.dirname, "forbidden-report-output"),
          runDirectory: run,
          sourceReviewDirectory: review,
        }),
      ).rejects.toThrow("outside the App Builder source tree");
      expect(result.screenshotPairs.map(({ viewport }) => viewport)).toEqual(viewports);
      expect(
        result.screenshotPairs.every(({ qualification }) =>
          qualification.includes("candidate has no authentication"),
        ),
      ).toBe(true);
      const html = await readFile(path.join(root, "out", "index.html"), "utf-8");
      expect(html.indexOf("Initial screen comparison")).toBeLessThan(
        html.indexOf("All requirement outcomes"),
      );
      expect(html).not.toContain("<pre>");
      expect(html).toContain('href="source-review/source-evidence.json"');

      await expect(
        writeSupplementaryAssessment({
          outputDirectory: path.join(root, "missing-review"),
          runDirectory: run,
          sourceReviewDirectory: run,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
