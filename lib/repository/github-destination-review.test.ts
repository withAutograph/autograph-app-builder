import { describe, expect, it } from "vitest";

import {
  createRepositoryObservation,
  createGitHubInstallationIdentity,
} from "./github-publication";
import {
  assertGitHubDestinationReviewBinding,
  createGitHubDestinationReviewBinding,
  deriveDestinationChanges,
} from "./github-destination-review";
import type { OverlayFile } from "./target-apply";

const installation = createGitHubInstallationIdentity({
  accountId: "20",
  accountLogin: "withAutograph",
  accountType: "Organization",
  installationId: "10",
  operation: "resolve-existing-source",
  repositorySelection: "selected",
  selectedRepositoryIds: ["100"],
});
const repository = createRepositoryObservation({
  defaultBranch: "main",
  headSha: "1".repeat(40),
  headTree: "2".repeat(40),
  installationIdentityDigest: installation.digest,
  name: "example",
  owner: "withAutograph",
  releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
  repositoryId: "100",
  visibility: "private",
});
const file = (path: string, digest: string): OverlayFile => ({ digest, mode: "644", path });
const provenance = { applyDigest: "apply", postTreeDigest: "post", validationDigest: "validation" };
const binding = (candidatePaths: string[], preTree: OverlayFile[]) =>
  createGitHubDestinationReviewBinding({
    candidatePaths,
    installation,
    preTree,
    repository,
    ...provenance,
  });

describe("GitHub destination review", () => {
  it("compares validated schema output against the current destination pointer", () => {
    const review = binding(
      ["apps/example/schema.ts"],
      [file("apps/example/schema.ts", "current-pointer")],
    );
    expect(
      deriveDestinationChanges(review, {
        files: [file("apps/example/schema.ts", "validated-historical-schema")],
        treeDigest: "post",
      }),
    ).toEqual([
      {
        after: { digest: "validated-historical-schema", mode: "644" },
        before: { digest: "current-pointer", mode: "644" },
        kind: "modified",
        path: "apps/example/schema.ts",
      },
    ]);
  });

  it("derives additions, deletions, and no-ops from destination presence", () => {
    const review = binding(
      ["added", "deleted", "same", "absent"],
      [file("deleted", "old"), file("same", "same")],
    );
    expect(
      deriveDestinationChanges(review, {
        files: [file("added", "new"), file("same", "same")],
        treeDigest: "post",
      }),
    ).toEqual([
      { after: { digest: "new", mode: "644" }, kind: "added", path: "added" },
      { before: { digest: "old", mode: "644" }, kind: "deleted", path: "deleted" },
    ]);
  });

  it("leaves unrelated app output outside the delta and preserves inputs", () => {
    const review = binding(["selected"], [file("selected", "old")]);
    const observed = {
      files: [file("selected", "new"), file("unrelated", "output")],
      treeDigest: "post",
    };
    expect(deriveDestinationChanges(review, observed).map((change) => change.path)).toEqual([
      "selected",
    ]);
    expect(observed.files).toHaveLength(2);
    expect(() => binding(["selected"], [file("unrelated-remote", "old")])).toThrow(
      "candidate paths",
    );
  });

  it("canonicalizes path and file ordering deterministically", () => {
    expect(binding(["b", "a", "b"], [file("b", "b"), file("a", "a")])).toEqual(
      binding(["a", "b"], [file("a", "a"), file("b", "b")]),
    );
  });

  it("rejects altered contents and apply provenance", () => {
    const review = binding(["selected"], [file("selected", "old")]);
    expect(() => {
      assertGitHubDestinationReviewBinding({ ...review, digest: "invalid" }, provenance);
    }).toThrow("digest");
    for (const key of ["applyDigest", "validationDigest", "postTreeDigest"] as const) {
      expect(() => {
        assertGitHubDestinationReviewBinding(review, { ...provenance, [key]: "other" });
      }).toThrow("provenance");
    }
    expect(
      deriveDestinationChanges(review, { files: [], treeDigest: "full-repository" })[0]?.kind,
    ).toBe("deleted");
  });

  it("rejects ambiguous candidate paths and duplicate destination files", () => {
    expect(() => binding(["../outside"], [])).toThrow("candidate path");
    expect(() => binding(["selected"], [file("selected", "one"), file("selected", "two")])).toThrow(
      "uniquely",
    );
  });
});
