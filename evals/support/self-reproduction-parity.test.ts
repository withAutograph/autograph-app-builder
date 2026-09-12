import { describe, expect, it } from "vitest";
import {
  assessParity,
  parityEvidenceSchema,
  parityVersion,
  requirements,
} from "./self-reproduction-parity";
import type { ParityEvidence } from "./self-reproduction-parity";
import { independenceAssertions } from "./self-reproduction-independence";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function fixture(): ParityEvidence {
  return {
    schemaVersion: parityVersion,
    runId: "fixture-run",
    producer: "evaluator",
    fixtureVersion: 1,
    reference: {
      output: "available",
      reason: "Reference checkout",
      sourceRevision: "reference-revision",
      observations: [],
    },
    candidate: {
      output: "available",
      reason: "Exported candidate",
      sourceRevision: "candidate-revision",
      observations: [],
    },
  };
}
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function observed(input: ParityEvidence, id: string) {
  const row = requirements.find((item) => item.id === id)!;
  input.candidate.observations.push({
    requirementId: id,
    disposition: "observed",
    reason: "Executed fixture",
    method: row.kind === "framework" ? "source-and-browser" : "browser",
    artifacts: ["receipts/result.json"],
    assertions: row.assertions.map((assertion) => ({
      id: assertion,
      passed: true,
      detail: "Observed expected transition",
      artifacts: ["receipts/result.json"],
    })),
  });
  return input.candidate.observations.at(-1)!;
}
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function status(input: ParityEvidence, id: string, retained = true) {
  return (await assessParity(input, () => Promise.resolve(retained))).rows.find(
    (row) => row.side === "candidate" && row.requirementId === id,
  )?.status;
}

describe("evaluator-owned parity assessment", () => {
  it("distinguishes missing generated output from unavailable infrastructure", async () => {
    const input = fixture();
    input.candidate.output = "missing";
    expect(await status(input, "app-creation")).toBe("failed");
    input.candidate.output = "infrastructure-unavailable";
    expect(await status(input, "app-creation")).toBe("blocked");
  });
  it.each(["anonymous-entry", "durable-draft", "independent-child"])(
    "fails observed inert controls, persistence loss or reference leakage: %s",
    async (id) => {
      const input = fixture();
      const observation = observed(input, id);
      observation.assertions.at(-1)!.passed = false;
      expect(await status(input, id)).toBe("failed");
    },
  );
  it("requires every assertion and retained evidence before passing", async () => {
    const input = fixture();
    const observation = observed(input, "durable-draft");
    expect(await status(input, "durable-draft")).toBe("passed");
    expect(await status(input, "durable-draft", false)).toBe("unassessed");
    observation.assertions.pop();
    expect(await status(input, "durable-draft")).toBe("unassessed");
  });
  it("never credits config-only or non-instant navigation proof", async () => {
    const input = fixture();
    const observation = observed(input, "instant-navigation");
    expect(await status(input, "instant-navigation")).toBe("unassessed");
    observation.method = "@next/playwright/instant";
    expect(await status(input, "instant-navigation")).toBe("passed");
    observation.method = "source-review";
    expect(await status(input, "instant-navigation")).toBe("unassessed");
  });
  it("requires a capture as well as behavioral evidence", async () => {
    const input = fixture();
    const id = "capture/desktop/keyboard";
    const observation = observed(input, id);
    expect(await status(input, id)).toBe("unassessed");
    observation.artifacts.push("parity/captures/keyboard.png");
    expect(await status(input, id)).toBe("passed");
  });
  it("retains all requirements independently on both sides without an aggregate verdict", async () => {
    const report = await assessParity(fixture(), () => Promise.resolve(false));
    expect(report.rows).toHaveLength(requirements.length * 2);
    expect(report.rows.every((row) => row.status === "unassessed")).toBe(true);
    expect(report).not.toHaveProperty("passed");
  });
  it("rejects candidate-owned receipts, duplicate rows and escaping artifact paths", () => {
    expect(parityEvidenceSchema.safeParse({ ...fixture(), producer: "candidate" }).success).toBe(
      false,
    );
    const input = fixture();
    const observation = observed(input, "durable-draft");
    observation.artifacts = ["../reference/secrets"];
    expect(parityEvidenceSchema.safeParse(input).success).toBe(false);
    observation.artifacts = ["receipt.json"];
    input.candidate.observations.push(observation);
    expect(parityEvidenceSchema.safeParse(input).success).toBe(false);
  });
  it("detects reference leakage in server egress, not just browser requests", async () => {
    const input = fixture();
    const observation = observed(input, "independent-child");
    observation.assertions = independenceAssertions({
      referenceOrigins: ["http://localhost:3000"],
      browserOrigins: ["http://localhost:3001"],
      serverOrigins: ["http://localhost:3000/api/create"],
      referenceSourceExposed: false,
      children: [{ artifactReadable: true, depth: 1 }],
      artifacts: ["receipts/egress.json"],
    });
    expect(await status(input, "independent-child")).toBe("failed");
  });
  it("cannot prove independence without server visibility and generator-input provenance", async () => {
    const input = fixture();
    observed(input, "independent-child").assertions = independenceAssertions({
      referenceOrigins: ["http://localhost:3000"],
      browserOrigins: ["http://localhost:3001"],
      children: [{ artifactReadable: true, depth: 1 }],
      artifacts: ["receipts/egress.json"],
    });
    expect(await status(input, "independent-child")).toBe("unassessed");
  });
  it("does not prove isolation against an unspecified reference backend", () => {
    const assertions = independenceAssertions({
      referenceOrigins: [],
      browserOrigins: [],
      serverOrigins: [],
      referenceSourceExposed: false,
      children: [{ artifactReadable: true, depth: 1 }],
      artifacts: ["receipts/egress.json"],
    });
    expect(assertions.some((item) => item.id === "no-reference-backend")).toBe(false);
  });
});
