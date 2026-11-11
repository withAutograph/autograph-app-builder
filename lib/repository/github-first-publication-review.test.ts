import { describe, expect, it } from "vitest";

import {
  assertGitHubDestinationReviewBinding,
  createGitHubDestinationReviewBinding,
  deriveDestinationChanges,
  firstAppRegistrationPaths,
} from "./github-destination-review";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
} from "./github-publication";
import { assertExistingAppReviewScope } from "./reviewed-change-set";
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
  name: "arrusted-example",
  owner: "withAutograph",
  releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
  repositoryId: "100",
  visibility: "private",
});
const file = (path: string, digest: string): OverlayFile => ({ digest, mode: "644", path });
const appId = "supply-ledger";
const appManifest = `apps/${appId}/package.json`;
const appPage = `apps/${appId}/app/page.tsx`;
const registrationPaths = ["bun.lock", "microfrontends.json"];
const draft = {
  applyDigest: "apply",
  candidatePaths: [appManifest, appPage, ...registrationPaths],
  firstAppRegistration: { appId, paths: registrationPaths },
  installation,
  postTreeDigest: "post",
  preTree: [file("bun.lock", "base-lock"), file("microfrontends.json", "base-routes")],
  repository,
  validationDigest: "validation",
};

describe("first publication into an existing repository", () => {
  it("reviews the complete app and only its generated registration", () => {
    const review = createGitHubDestinationReviewBinding(draft);
    const changes = deriveDestinationChanges(review, {
      files: [
        file(appManifest, "new-app-manifest"),
        file(appPage, "new-app-page"),
        file("bun.lock", "generated-lock"),
        file("microfrontends.json", "registered-routes"),
        file("package.json", "unselected-root-manifest"),
        file("apps/another-app/app/page.tsx", "unrelated-app"),
      ],
      treeDigest: draft.postTreeDigest,
    });
    const approvedPaths = changes.map(({ path }) => path);
    expect(approvedPaths.toSorted()).toEqual(draft.candidatePaths.toSorted());
    expect(changes).toContainEqual({
      after: { digest: "generated-lock", mode: "644" },
      before: { digest: "base-lock", mode: "644" },
      kind: "modified",
      path: "bun.lock",
    });
    expect(() => {
      assertExistingAppReviewScope(
        { approvedPaths },
        appId,
        "existing-repository",
        undefined,
        firstAppRegistrationPaths(review, appId),
      );
    }).not.toThrow();
    expect(() => {
      assertExistingAppReviewScope({ approvedPaths }, appId, "existing-repository");
    }).toThrow("outside");
  });

  it("binds the first registration scope to the review and app identity", () => {
    const review = createGitHubDestinationReviewBinding(draft);
    const unscopedReview = { ...review };
    delete unscopedReview.firstAppRegistration;
    expect(() => {
      assertGitHubDestinationReviewBinding(unscopedReview, draft);
    }).toThrow("digest");
    expect(() => firstAppRegistrationPaths(review, "another-app")).toThrow("another app");
  });

  it("rejects app files already present on the destination", () => {
    expect(() => {
      createGitHubDestinationReviewBinding({
        ...draft,
        preTree: [...draft.preTree, file(appManifest, "occupied-app")],
      });
    }).toThrow("already has files");
  });

  it("rejects root and unrelated app paths outside the proved registration", () => {
    for (const path of ["package.json", "apps/another-app/package.json"]) {
      expect(() => {
        createGitHubDestinationReviewBinding({
          ...draft,
          candidatePaths: [...draft.candidatePaths, path],
        });
      }).toThrow("only the new app and its registration");
    }
    const workflow = ".github/workflows/check.yml";
    expect(() => {
      createGitHubDestinationReviewBinding({
        ...draft,
        candidatePaths: [...draft.candidatePaths, workflow],
        firstAppRegistration: { appId, paths: [...registrationPaths, workflow] },
      });
    }).toThrow("only the new app and its registration");
  });
});
