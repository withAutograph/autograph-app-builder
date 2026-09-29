import { createHash } from "node:crypto";

// oxlint-disable eslint/require-await -- in-memory readFile doubles preserve the Promise-returning content source contract

import { describe, expect, it } from "vitest";

import type { ExistingDraftObservation } from "./github-draft-update";
import {
  createReconciliationReviewReceipt,
  reconcileExistingDraft,
  sealExistingDraftReconciliation,
} from "./github-draft-reconciliation";
import type { ExistingDraftReconciliationAdapter } from "./github-draft-reconciliation";
import {
  REPOSITORY_RELEASE_GATE,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
} from "./github-publication";

const sha = (character: string) => character.repeat(40);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const path = "apps/demo/page.tsx";
const bytes = new TextEncoder().encode("export default function Page() { return null; }\n");
const identity = createGitHubInstallationIdentity({
  accountId: "200",
  accountLogin: "withAutograph",
  accountType: "Organization",
  installationId: "300",
  operation: "publish-draft-pull-request",
  repositorySelection: "selected",
  selectedRepositoryIds: ["100"],
});
const repository = createRepositoryObservation({
  defaultBranch: "main",
  headSha: sha("3"),
  headTree: sha("4"),
  installationIdentityDigest: identity.digest,
  name: "example-app",
  owner: "withAutograph",
  releaseGate: { configured: false, name: REPOSITORY_RELEASE_GATE },
  repositoryId: "100",
  visibility: "private",
});
const initial: ExistingDraftObservation = {
  baseBranch: "main",
  baseRepositoryId: "100",
  draft: true,
  headBranch: "app-builder/review-original",
  headRepositoryId: "100",
  headSha: sha("1"),
  headTree: sha("2"),
  name: "example-app",
  number: 1500,
  owner: "withAutograph",
  pullRequestId: "150000",
  repositoryId: "100",
  state: "open",
  verifiedBuilderOrigin: { appId: "123", authorId: "900", marker: "d".repeat(64) },
};
const review = createReconciliationReviewReceipt({
  appId: "demo",
  baseChanges: [{ after: { digest: digest(bytes), mode: "644" }, kind: "added", path }],
  baseSha: repository.headSha,
  baseTree: repository.headTree,
  headChanges: [{ after: { digest: digest(bytes), mode: "644" }, kind: "added", path }],
  headSha: initial.headSha,
  headTree: initial.headTree,
  resolvedTree: sha("5"),
  version: 1,
});

const mockAdapter = () => {
  let current = initial;
  let base = repository;
  let updates = 0;
  const adapter: ExistingDraftReconciliationAdapter = {
    // oxlint-disable-next-line eslint/require-await -- in-memory provider
    async inspectAppliedDraftReconciliation(_proposal, observed) {
      return observed.headSha === sha("6") && observed.headTree === review.resolvedTree;
    },
    // oxlint-disable-next-line eslint/require-await -- in-memory provider
    async inspectExistingDraft() {
      return current;
    },
    // oxlint-disable-next-line eslint/require-await -- in-memory provider
    async inspectInstallation() {
      return identity;
    },
    // oxlint-disable-next-line eslint/require-await -- in-memory provider
    async inspectRepository() {
      return base;
    },
    // oxlint-disable-next-line eslint/require-await -- in-memory provider
    async reconcileExistingDraft(_proposal, content) {
      expect(content.changes).toEqual([{ ...review.baseChanges[0], bytes }]);
      updates += 1;
      current = { ...current, headSha: sha("6"), headTree: review.resolvedTree };
      return { requestId: "merge-request", status: "accepted" };
    },
  };
  return {
    adapter,
    moveBase() {
      base = { ...base, headSha: sha("7") };
    },
    moveHead() {
      current = { ...current, headSha: sha("8") };
    },
    get updates() {
      return updates;
    },
  };
};

const seal = async (adapter: ExistingDraftReconciliationAdapter) =>
  await sealExistingDraftReconciliation({
    adapter,
    installation: identity,
    originMarker: initial.verifiedBuilderOrigin?.marker ?? "",
    priorPublicationDigest: "a".repeat(64),
    pullRequestNumber: 1500,
    repository,
    review,
    selectedSourceRef: `refs/heads/${initial.headBranch}`,
  });

describe("existing draft reconciliation", () => {
  it("seals both reviewed diffs and updates only the exact head and live base", async () => {
    const mock = mockAdapter();
    const proposal = await seal(mock.adapter);
    const updated = await reconcileExistingDraft({
      adapter: mock.adapter,
      contentSource: {
        async readFile() {
          return { bytes, digest: digest(bytes), mode: "644" };
        },
      },
      proposal,
      review,
    });
    expect(updated.headSha).toBe(sha("6"));
    expect(mock.updates).toBe(1);
    await expect(
      reconcileExistingDraft({
        adapter: mock.adapter,
        contentSource: {
          async readFile() {
            throw new Error("should not read after an applied update");
          },
        },
        proposal,
        review,
      }),
    ).resolves.toEqual(updated);
    expect(mock.updates).toBe(1);
  });

  it("reports an uncertain update when both the write and PR readback fail", async () => {
    const mock = mockAdapter();
    const proposal = await seal(mock.adapter);
    let inspections = 0;
    const adapter: ExistingDraftReconciliationAdapter = {
      ...mock.adapter,
      async inspectExistingDraft(input) {
        inspections += 1;
        if (inspections === 2) {
          throw new Error("GitHub could not inspect the existing draft PR (HTTP 503).");
        }
        return await mock.adapter.inspectExistingDraft(input);
      },
      async reconcileExistingDraft() {
        throw new Error("GitHub could not update the existing draft PR (HTTP 503).");
      },
    };
    await expect(
      reconcileExistingDraft({
        adapter,
        contentSource: {
          async readFile() {
            return { bytes, digest: digest(bytes), mode: "644" };
          },
        },
        proposal,
        review,
      }),
    ).rejects.toThrow("The branch may already have moved. Inspect its live head");
  });

  it("reports accepted write with failed PR readback without claiming failure", async () => {
    const mock = mockAdapter();
    const proposal = await seal(mock.adapter);
    let inspections = 0;
    const adapter: ExistingDraftReconciliationAdapter = {
      ...mock.adapter,
      async inspectExistingDraft(input) {
        inspections += 1;
        if (inspections === 2) {
          throw new Error("GitHub could not inspect the existing draft PR (HTTP 503).");
        }
        return await mock.adapter.inspectExistingDraft(input);
      },
    };
    await expect(
      reconcileExistingDraft({
        adapter,
        contentSource: {
          async readFile() {
            return { bytes, digest: digest(bytes), mode: "644" };
          },
        },
        proposal,
        review,
      }),
    ).rejects.toThrow("GitHub accepted the merge commit for draft PR #1500");
    expect(mock.updates).toBe(1);
  });

  it("rejects a moved base or PR head before writing", async () => {
    const baseMoved = mockAdapter();
    const baseProposal = await seal(baseMoved.adapter);
    baseMoved.moveBase();
    await expect(
      reconcileExistingDraft({
        adapter: baseMoved.adapter,
        contentSource: {
          async readFile() {
            return { bytes, digest: digest(bytes), mode: "644" };
          },
        },
        proposal: baseProposal,
        review,
      }),
    ).rejects.toThrow("base branch moved");
    expect(baseMoved.updates).toBe(0);

    const headMoved = mockAdapter();
    const headProposal = await seal(headMoved.adapter);
    headMoved.moveHead();
    await expect(
      reconcileExistingDraft({
        adapter: headMoved.adapter,
        contentSource: {
          async readFile() {
            return { bytes, digest: digest(bytes), mode: "644" };
          },
        },
        proposal: headProposal,
        review,
      }),
    ).rejects.toThrow("branch moved");
    expect(headMoved.updates).toBe(0);
  });

  it("rejects a changed resolved file after review", async () => {
    const mock = mockAdapter();
    const proposal = await seal(mock.adapter);
    await expect(
      reconcileExistingDraft({
        adapter: mock.adapter,
        contentSource: {
          async readFile() {
            return {
              bytes: new TextEncoder().encode("changed"),
              digest: digest(bytes),
              mode: "644",
            };
          },
        },
        proposal,
        review,
      }),
    ).rejects.toThrow(path);
    expect(mock.updates).toBe(0);
  });

  it("rejects a repository outside the tenant's selected installation", async () => {
    const mock = mockAdapter();
    const wrongInstallation = createGitHubInstallationIdentity({
      accountId: "200",
      accountLogin: "withAutograph",
      accountType: "Organization",
      installationId: "300",
      operation: "publish-draft-pull-request",
      repositorySelection: "selected",
      selectedRepositoryIds: ["999"],
    });
    await expect(
      sealExistingDraftReconciliation({
        adapter: mock.adapter,
        installation: wrongInstallation,
        originMarker: initial.verifiedBuilderOrigin?.marker ?? "",
        priorPublicationDigest: "a".repeat(64),
        pullRequestNumber: 1500,
        repository,
        review,
        selectedSourceRef: `refs/heads/${initial.headBranch}`,
      }),
    ).rejects.toThrow("cannot reconcile this repository");
    expect(mock.updates).toBe(0);
  });
});
