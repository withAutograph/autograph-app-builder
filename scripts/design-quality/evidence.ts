export type Dimension = "component" | "api" | "styling";
export type Observation = {
  id: string;
  dimension: Dimension;
  verdict: "conforming" | "nonconforming" | "unassessed";
  provenance: "generated" | "shared" | "unknown";
  evidence: "static" | "browser";
  summary: string;
  source?: { path: string; line: number; column?: number };
  capture?: string;
  region?: { x: number; y: number; width: number; height: number };
  classification?: string;
  originCandidate?: {
    /** Reviewer-facing source candidate; never score provenance. */
    provenance: "generated" | "shared";
    reason: string;
    source: { path: string; line: number; column?: number };
  };
};

export const evaluatorVersion = 3;
export const dimensions: Dimension[] = ["component", "api", "styling"];

export function scoreAdherence(
  observations: Observation[],
  limitations: string[] = [],
  sourceAvailable = true,
) {
  // Shared-library styles describe the foundation, not authored app compliance.
  // Never deduce conformity from unknown provenance or duplicated observations.
  const unique = [...new Map(observations.map((o) => [o.id, o])).values()];
  const scores = Object.fromEntries(
    dimensions.map((dimension) => {
      const rows = unique.filter(
        (o) => o.dimension === dimension && o.provenance !== "shared",
      );
      const conforming = rows.filter(
        (o) => o.verdict === "conforming" && o.provenance === "generated",
      ).length;
      const nonconforming = rows.filter(
        (o) => o.verdict === "nonconforming" && o.provenance === "generated",
      ).length;
      const assessed = conforming + nonconforming;
      const unassessed = rows.length - assessed;
      return [
        dimension,
        {
          conforming,
          nonconforming,
          unassessed,
          assessed,
          total: rows.length,
          percent: assessed ? (100 * conforming) / assessed : null,
          coveragePercent: rows.length ? (100 * assessed) / rows.length : null,
          staticCount: rows.filter((o) => o.evidence === "static").length,
          browserCount: rows.filter((o) => o.evidence === "browser").length,
        },
      ];
    }),
  ) as Record<
    Dimension,
    {
      conforming: number;
      nonconforming: number;
      unassessed: number;
      assessed: number;
      total: number;
      percent: number | null;
      coveragePercent: number | null;
      staticCount: number;
      browserCount: number;
    }
  >;
  const available = Object.values(scores).filter((d) => d.percent !== null);
  const total = Object.values(scores).reduce((n, d) => n + d.total, 0);
  const assessed = Object.values(scores).reduce((n, d) => n + d.assessed, 0);
  return {
    version: evaluatorVersion,
    status: !available.length
      ? "unassessed"
      : !sourceAvailable ||
          available.length < dimensions.length ||
          assessed < total ||
          limitations.length
        ? "partial"
        : "complete",
    score: available.length
      ? Math.round(
          available.reduce((n, d) => n + d.percent!, 0) / available.length,
        )
      : null,
    coveragePercent: total
      ? Math.round((10_000 * assessed) / total) / 100
      : null,
    dimensions: scores,
    observations: unique,
    limitations,
    method:
      "Equal average of available dimension percentages; each is conforming / assessed. Shared-library observations are excluded. Unknown provenance is unassessed. Static JSX is not proof of rendering. Coverage describes inspected evidence, not the entire app.",
  };
}
export type Adherence = ReturnType<typeof scoreAdherence>;
