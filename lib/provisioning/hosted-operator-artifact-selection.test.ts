import { describe, expect, it } from "vitest";
import { selectExactCompiledOperatorRelease } from "./hosted-operator-artifact-selection";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";

const release = (letter: string): CompiledOperatorReleaseSelection => ({
  appId: "spend-review",
  appSpecDigest: letter.repeat(64),
  artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${letter.repeat(64)}`,
  manifestSha256: letter.repeat(64),
  releaseId: `review-v${letter}`,
  schemaSha256: letter.repeat(64),
  version: 1,
});
describe("exact retained compiled release identity", () => {
  it("selects the recorded predecessor rather than the earliest or latest release", () => {
    const oldest = release("a");
    const predecessor = release("b");
    const latest = release("c");
    expect(
      selectExactCompiledOperatorRelease([oldest, latest, predecessor], {
        releaseId: predecessor.releaseId,
        schemaSha256: predecessor.schemaSha256,
      }),
    ).toEqual(predecessor);
    expect(
      selectExactCompiledOperatorRelease([latest, oldest, predecessor], {
        artifactRef: predecessor.artifactRef,
      }),
    ).toEqual(predecessor);
  });
  it("does not substitute newly overwritten bytes with the same release ID and a different hash", () => {
    const latest = release("c");
    expect(
      selectExactCompiledOperatorRelease([latest], {
        releaseId: latest.releaseId,
        schemaSha256: "b".repeat(64),
      }),
    ).toBeUndefined();
  });
  it("allows a retained content-addressed artifact after normal AppSpec changes", () => {
    const original = release("b");
    const repeated = { ...original, appSpecDigest: "c".repeat(64) };
    expect(
      selectExactCompiledOperatorRelease([repeated, original], {
        artifactRef: original.artifactRef,
      }),
    ).toEqual(original);
    expect(
      selectExactCompiledOperatorRelease([original, repeated], {
        appSpecDigest: repeated.appSpecDigest,
        artifactRef: original.artifactRef,
      }),
    ).toEqual(repeated);
  });
  it("rejects distinct artifacts matching an incomplete installed predecessor identity", () => {
    const first = release("b");
    const distinct = {
      ...first,
      artifactRef: release("c").artifactRef,
      manifestSha256: "c".repeat(64),
    };
    expect(() =>
      selectExactCompiledOperatorRelease([first, distinct], {
        releaseId: first.releaseId,
        schemaSha256: first.schemaSha256,
      }),
    ).toThrow("artifact is unavailable");
    expect(
      selectExactCompiledOperatorRelease([first, distinct], {
        manifestSha256: distinct.manifestSha256,
        releaseId: first.releaseId,
        schemaSha256: first.schemaSha256,
      }),
    ).toEqual(distinct);
  });
  it("returns absence when the requested version was never captured", () => {
    expect(
      selectExactCompiledOperatorRelease([release("c")], { artifactRef: release("a").artifactRef }),
    ).toBeUndefined();
  });
});
