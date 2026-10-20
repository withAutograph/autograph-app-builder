import { describe, expect, it } from "vitest";
import {
  compiledOperatorReleaseSelectionSchema,
  isEquivalentCompiledOperatorRelease,
  selectExactCompiledOperatorRelease,
  selectExactPublishedAppSource,
} from "./hosted-operator-artifact-selection";
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

it("accepts additive source and selection metadata without changing exact release selection", () => {
  const selected = release("a");
  const input = {
    ...selected,
    advisory: "Release label",
    publishedSource: {
      branch: "codex/reviewed-app",
      changeSetDigest: "b".repeat(64),
      gitSha: "c".repeat(40),
      gitTree: "d".repeat(40),
      repositoryId: "owned-repository",
      reviewDigest: "e".repeat(64),
      advisory: { label: "Published source" },
    },
  };
  const parsed = compiledOperatorReleaseSelectionSchema.parse(input);
  expect(
    selectExactCompiledOperatorRelease([input], {
      appSpecDigest: selected.appSpecDigest,
      artifactRef: selected.artifactRef,
    }),
  ).toMatchObject({ ...selected, publishedSource: { gitSha: input.publishedSource.gitSha } });
  expect(parsed).not.toHaveProperty("advisory");
  expect(parsed.publishedSource).not.toHaveProperty("advisory");
  expect(
    selectExactCompiledOperatorRelease([input], {
      appSpecDigest: "f".repeat(64),
      artifactRef: selected.artifactRef,
    }),
  ).toBeUndefined();
  expect(() =>
    compiledOperatorReleaseSelectionSchema.parse({
      ...input,
      publishedSource: { ...input.publishedSource, reviewDigest: "invalid" },
    }),
  ).toThrow();
});

describe("exact recorded published source across accepted specifications", () => {
  const publishedSource = {
    repositoryId: "fixture-repository",
    branch: "app-builder/fixture",
    gitSha: "d".repeat(40),
    gitTree: "e".repeat(40),
    changeSetDigest: "f".repeat(64),
    reviewDigest: "a".repeat(64),
  };
  it("finds an older approved publication without selecting the current unpublished specification", () => {
    const older = { ...release("a"), publishedSource };
    const current = release("b");
    expect(selectExactPublishedAppSource([current, older], publishedSource)).toEqual(
      publishedSource,
    );
    expect(
      selectExactPublishedAppSource([older, { ...release("c"), publishedSource }], publishedSource),
    ).toEqual(publishedSource);
  });
  it.each([
    { repositoryId: "another-repository" },
    { branch: "another-branch" },
    { gitSha: "b".repeat(40) },
    { gitTree: "c".repeat(40) },
  ])("does not substitute a different observed Git tuple: %j", (change) => {
    expect(
      selectExactPublishedAppSource([{ ...release("a"), publishedSource }], {
        ...publishedSource,
        ...change,
      }),
    ).toBeUndefined();
  });
  it("rejects malformed retained markers and returns absence for unpublished selections", () => {
    expect(selectExactPublishedAppSource([release("a")], publishedSource)).toBeUndefined();
    expect(() =>
      selectExactPublishedAppSource(
        [
          {
            ...release("a"),
            publishedSource: { ...publishedSource, gitTree: "invalid" },
          },
        ],
        publishedSource,
      ),
    ).toThrow();
  });
});

describe("complete immutable release equivalence for publication association", () => {
  const source = {
    repositoryId: "fixture-repository",
    branch: "app-builder/fixture",
    gitSha: "d".repeat(40),
    gitTree: "e".repeat(40),
    changeSetDigest: "f".repeat(64),
    reviewDigest: "a".repeat(64),
  };
  it("ignores only the existing publication association", () => {
    const approved = release("a");
    expect(
      isEquivalentCompiledOperatorRelease(approved, { ...approved, publishedSource: source }),
    ).toBe(true);
    expect(
      isEquivalentCompiledOperatorRelease(
        { ...approved, publishedSource: source },
        { ...approved, publishedSource: { ...source, gitSha: "f".repeat(40) } },
      ),
    ).toBe(true);
  });
  it.each([
    "appId",
    "appSpecDigest",
    "artifactRef",
    "manifestSha256",
    "releaseId",
    "schemaSha256",
  ] as const)("does not associate a different immutable %s", (field) => {
    const approved = release("a");
    const changed = {
      ...approved,
      [field]: field === "appId" ? "another-app" : release("b")[field],
    };
    expect(isEquivalentCompiledOperatorRelease(approved, changed)).toBe(false);
  });
});
