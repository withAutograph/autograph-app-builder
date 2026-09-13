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
      await writeFile(join(run, "report.json"), "{}");
      await writeFile(join(run, "revisions.json"), "{}");
      await writeFile(
        join(review, "observations.json"),
        JSON.stringify({
          schemaVersion: "self-reproduction-source-review/v1",
          observations: { candidate: [observation(false, "source-review")] },
        }),
      );
      const result = await writeSupplementaryAssessment({
        runDirectory: run,
        sourceReviewDirectory: review,
        outputDirectory: join(root, "out"),
      });
      expect(
        result.assessment.rows.find(
          (row) => row.side === "candidate" && row.requirementId === "server-first",
        )?.status,
      ).toBe("unassessed");
      expect(await readFile(join(run, "parity-evidence.json"), "utf-8")).toBe(original);
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
