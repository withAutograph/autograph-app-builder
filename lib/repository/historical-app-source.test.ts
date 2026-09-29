import { describe, expect, it } from "vitest";

import {
  historicalAppSourceObservationSchema,
  historicalAppSourceSelectorSchema,
} from "./historical-app-source";

describe("historical App source contracts", () => {
  it("accepts only immutable commit or merged PR selectors", () => {
    expect(
      historicalAppSourceSelectorSchema.parse({ commitSha: "a".repeat(40), kind: "commit" }),
    ).toEqual({ commitSha: "a".repeat(40), kind: "commit" });
    expect(
      historicalAppSourceSelectorSchema.parse({ kind: "merged-pr", pullRequestNumber: 1 }),
    ).toEqual({ kind: "merged-pr", pullRequestNumber: 1 });
    expect(() =>
      historicalAppSourceSelectorSchema.parse({
        commitSha: "A".repeat(40),
        kind: "commit",
      }),
    ).toThrow();
    expect(() =>
      historicalAppSourceSelectorSchema.parse({
        kind: "merged-pr",
        pullRequestNumber: 0,
      }),
    ).toThrow();
    expect(() =>
      historicalAppSourceSelectorSchema.parse({
        commitSha: "a".repeat(40),
        kind: "commit",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("keeps the historical observation closed and metadata only", () => {
    expect(
      historicalAppSourceObservationSchema.parse({
        commitSha: "a".repeat(40),
        name: "demo",
        owner: "owner",
        repositoryId: "100",
        treeSha: "b".repeat(64),
      }),
    ).toMatchObject({ repositoryId: "100" });
    expect(() =>
      historicalAppSourceObservationSchema.parse({
        commitSha: "a".repeat(40),
        content: "source bytes",
        name: "demo",
        owner: "owner",
        repositoryId: "100",
        treeSha: "b".repeat(64),
      }),
    ).toThrow();
  });
});
