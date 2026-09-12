import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  calculateCompensation,
  initialCompensationState,
  reduceCompensationState,
  validateCompensation,
  type CompensationFixture,
} from "./compensation-state";
import { loadDesignQualityExample } from "./input";
import {
  deriveSpendPreview,
  initialSpendState,
  reduceSpendState,
  spendActionModel,
  type SpendFixture,
} from "./spend-import-state";

async function fixture<T>(id: string): Promise<T> {
  return JSON.parse(
    await readFile(resolve(`docs/design-quality-cases/${id}/fixtures.json`), "utf-8"),
  ) as T;
}

describe("spend import example", () => {
  it("derives preview rows and the saved outcome from the edited mapping", async () => {
    const data = await fixture<SpendFixture>("spend-import-review");
    let state = initialSpendState(data);
    expect(deriveSpendPreview(data, state.mapping)).toMatchObject({
      ready: 38,
      needsReview: 4,
    });

    state = reduceSpendState(state, {
      type: "mapping-changed",
      source: "Supplier",
      target: "ignore",
    });
    const changed = deriveSpendPreview(data, state.mapping);
    expect(changed).toMatchObject({ ready: 0, needsReview: 42 });
    expect(changed.rows[0]).toMatchObject({
      vendor: "Not mapped",
      result: "Needs review",
    });

    state = reduceSpendState(state, { type: "preview-requested" });
    state = reduceSpendState(state, { type: "save-requested", fixture: data });
    expect(state.saved).toMatchObject({
      imported: 0,
      reviewQueue: 42,
      mapping: { Supplier: "ignore" },
    });
    expect(state.saved?.message).toContain("42 rows remain in human review");
  });

  it("keeps decision state, counts, visible result, and action availability synchronized", async () => {
    const data = await fixture<SpendFixture>("spend-import-review");
    let state = initialSpendState(data);
    state = reduceSpendState(state, { type: "preview-requested" });
    state = reduceSpendState(state, { type: "save-requested", fixture: data });
    state = reduceSpendState(state, { type: "review-requested" });
    expect(spendActionModel(state).applyEnabled).toBe(false);

    state = reduceSpendState(state, {
      type: "match-selected",
      id: "nsc-1008",
    });
    expect(spendActionModel(state).applyEnabled).toBe(true);
    state = reduceSpendState(state, { type: "decision-applied" });

    expect(state.saved).toMatchObject({ imported: 39, reviewQueue: 3 });
    expect(spendActionModel(state)).toEqual({
      saveEnabled: false,
      applyEnabled: false,
      result: "Simulated decision recorded.",
    });
  });
});

describe("compensation planning example", () => {
  it("recalculates current and proposed totals from editable assumptions", async () => {
    const data = await fixture<CompensationFixture>("compensation-planning");
    let state = initialCompensationState(data);
    expect(calculateCompensation(state.assumptions)).toMatchObject({
      currentTotal: 204_428,
      proposedBase: 165_680,
      proposedTotal: 219_155,
    });

    state = reduceCompensationState(state, {
      type: "assumption-changed",
      field: "plannedIncrease",
      value: 0.1,
    });
    state = reduceCompensationState(state, {
      type: "assumption-changed",
      field: "employerTaxRate",
      value: 0.08,
    });
    expect(calculateCompensation(state.assumptions)).toMatchObject({
      currentTotal: 204_960,
      proposedBase: 167_200,
      proposedTotal: 221_376,
    });
  });

  it("requires valid applied assumptions before a planning decision", async () => {
    const data = await fixture<CompensationFixture>("compensation-planning");
    let state = initialCompensationState(data);
    state = reduceCompensationState(state, { type: "recommend" });
    expect(state.decision).toBe("recommended");

    state = reduceCompensationState(state, {
      type: "assumption-changed",
      field: "plannedIncrease",
      value: 2,
    });
    expect(state).toMatchObject({
      assumptionsApplied: false,
      decision: "none",
    });
    expect(validateCompensation(state.assumptions).plannedIncrease).toBe(
      "Enter a percentage from -100 to 100.",
    );
    expect(calculateCompensation(state.assumptions)).toBeUndefined();

    state = reduceCompensationState(state, { type: "assumptions-applied" });
    state = reduceCompensationState(state, { type: "recommend" });
    expect(state).toMatchObject({
      assumptionsApplied: false,
      decision: "none",
    });
  });
});

describe("renderer inputs", () => {
  it.each(["spend-import-review", "compensation-planning"] as const)(
    "assembles and validates the %s public-component fixture",
    async (id) => {
      const input = await loadDesignQualityExample(id);
      expect(input.files.map(({ path }) => path)).toContain(input.manifest.screens[0]?.entry);
      expect(input.catalogGaps).toEqual([]);
    },
  );
});
