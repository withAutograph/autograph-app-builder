import { expect, it } from "vitest";

import { scoreAdherence } from "./evidence";
import type { Observation } from "./evidence";
const row = (
  id: string,
  dimension: Observation["dimension"],
  verdict: Observation["verdict"]
): Observation => ({
  dimension,
  evidence: "static",
  id,
  provenance: "generated",
  summary: id,
  verdict,
});
it("uses equally weighted available dimensions and retains denominators", () => {
  const result = scoreAdherence([
    row("c", "component", "conforming"),
    row("a", "api", "nonconforming"),
    row("s1", "styling", "conforming"),
    row("s2", "styling", "nonconforming"),
  ]);
  expect(result.score).toBe(50);
  expect(result.status).toBe("complete");
  expect(result.dimensions.styling).toMatchObject({
    assessed: 2,
    percent: 50,
    total: 2,
  });
});
it("does not award shared, unknown, duplicated, or missing evidence credit", () => {
  const c = row("c", "component", "conforming");
  const result = scoreAdherence([
    c,
    c,
    { ...row("shared", "styling", "conforming"), provenance: "shared" },
    { ...row("unknown", "api", "conforming"), provenance: "unknown" },
  ]);
  expect(result.score).toBe(100);
  expect(result.status).toBe("partial");
  expect(result.dimensions.api.unassessed).toBe(1);
  expect(result.dimensions.styling.percent).toBeNull();
  expect(result.coveragePercent).toBe(50);
});
it("shows no fabricated score for absent evidence", () => {
  expect(scoreAdherence([], [], false)).toMatchObject({
    coveragePercent: null,
    score: null,
    status: "unassessed",
  });
  expect(scoreAdherence([row("x", "styling", "unassessed")])).toMatchObject({
    coveragePercent: 0,
    score: null,
    status: "unassessed",
  });
});
it("does not round sparse evidence down to zero coverage", () => {
  const observations = [
    row("known", "styling", "conforming"),
    ...Array.from({ length: 299 }, (_, i) =>
      row(`unknown-${i}`, "styling", "unassessed")
    ),
  ];
  expect(scoreAdherence(observations).coveragePercent).toBe(0.33);
});
