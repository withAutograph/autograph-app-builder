import { describe, expect, it } from "vitest";

import type { RepositoryAccessResult } from "../integrations/repository-access";
import {
  assertRepositoryAccessReceiptForSource,
  assertResolvedSourceMatchesRepositoryAccess,
  recordRepositoryAccessReceipt,
  repositoryAccessReceiptSchema,
} from "./repository-access-state";

const sha = "1".repeat(40);
const tree = "2".repeat(40);
const accessDigest = "3".repeat(64);
const access = {
  accessDigest,
  repository: {
    archived: false,
    defaultBranch: "main",
    headSha: sha,
    headTree: tree,
    name: "app-builder-dogfood",
    owner: "withAutograph",
    repositoryId: "200",
    repositoryVariableNames: [],
    visibility: "private",
  },
  scope: {
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId: "10",
  },
  status: "ready",
} satisfies Extract<RepositoryAccessResult, { status: "ready" }>;

describe("session-bound repository access receipt", () => {
  it("records one closed canonical receipt and reuses it after the same fresh read-back", () => {
    const first = recordRepositoryAccessReceipt({
      access,
      confirmedByCallId: "call_one",
      current: undefined,
      sessionId: "ses_one",
    });
    const retried = recordRepositoryAccessReceipt({
      access,
      confirmedByCallId: "call_retry",
      current: first,
      sessionId: "ses_one",
    });

    expect(retried).toEqual(first);
    expect(first).toMatchObject({
      confirmedByCallId: "call_one",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      providerAccessDigest: accessDigest,
      repository: {
        defaultBranch: "main",
        headSha: sha,
        headTree: tree,
        name: "app-builder-dogfood",
        owner: "withAutograph",
        repositoryId: "200",
      },
      scope: { installationId: "10" },
      sessionId: "ses_one",
      version: 1,
    });
    expect(first.repository).not.toHaveProperty("repositoryVariableNames");
  });

  it("rotates on same-session provider drift and rejects cross-session state", () => {
    const first = recordRepositoryAccessReceipt({
      access,
      confirmedByCallId: "call_one",
      current: undefined,
      sessionId: "ses_one",
    });
    const changedHead = recordRepositoryAccessReceipt({
      access: {
        ...access,
        repository: { ...access.repository, headSha: "4".repeat(40) },
      },
      confirmedByCallId: "call_two",
      current: first,
      sessionId: "ses_one",
    });
    expect(changedHead.digest).not.toBe(first.digest);
    expect(() =>
      recordRepositoryAccessReceipt({
        access: {
          ...access,
          repository: { ...access.repository, headSha: "4".repeat(40) },
        },
        confirmedByCallId: "call_three",
        current: changedHead,
        sessionId: "ses_two",
      })
    ).toThrow("Repository access state belongs to a different session.");
  });

  it("rejects tampering, extra fields, and stale source bindings", () => {
    const receipt = recordRepositoryAccessReceipt({
      access,
      confirmedByCallId: "call_one",
      current: undefined,
      sessionId: "ses_one",
    });
    expect(() =>
      repositoryAccessReceiptSchema.parse({
        ...receipt,
        digest: "0".repeat(64),
      })
    ).toThrow("Repository access receipt digest is invalid.");
    expect(() =>
      repositoryAccessReceiptSchema.parse({ ...receipt, token: "secret" })
    ).toThrow();
    expect(() =>
      recordRepositoryAccessReceipt({
        access: {
          ...access,
          repository: { ...access.repository, headSha: "4".repeat(40) },
        },
        confirmedByCallId: "call_two",
        current: { ...receipt, digest: "0".repeat(64) },
        sessionId: "ses_one",
      })
    ).toThrow("Repository access receipt digest is invalid.");

    expect(
      assertRepositoryAccessReceiptForSource({
        expectedDigest: receipt.digest,
        expectedSha: sha,
        expectedTree: tree,
        receipt,
        ref: "refs/heads/main",
        repositoryId: "200",
        sessionId: "ses_one",
      })
    ).toEqual(receipt);

    for (const changed of [
      { sessionId: "ses_other" },
      { repositoryId: "201" },
      { ref: "refs/heads/other" },
      { expectedSha: "4".repeat(40) },
      { expectedTree: "5".repeat(40) },
      { expectedDigest: "6".repeat(64) },
    ]) {
      expect(() =>
        assertRepositoryAccessReceiptForSource({
          expectedDigest: receipt.digest,
          expectedSha: sha,
          expectedTree: tree,
          receipt,
          ref: "refs/heads/main",
          repositoryId: "200",
          sessionId: "ses_one",
          ...changed,
        })
      ).toThrow(
        "The repository access receipt does not match this session and source."
      );
    }
  });

  it("binds the independently resolved source to the exact access observation", () => {
    const receipt = recordRepositoryAccessReceipt({
      access,
      confirmedByCallId: "call_one",
      current: undefined,
      sessionId: "ses_one",
    });
    const source = {
      digest: "9".repeat(64),
      installationIdentityDigest: "7".repeat(64),
      repository: {
        defaultBranch: "main",
        digest: "8".repeat(64),
        headSha: sha,
        headTree: tree,
        installationIdentityDigest: "7".repeat(64),
        name: "app-builder-dogfood",
        owner: "withAutograph",
        releaseGate: {
          configured: false,
          name: "REPOSITORY_RELEASE_ENABLED" as const,
        },
        repositoryId: "200",
        version: 2 as const,
        visibility: "private" as const,
      },
      resolvedByCallId: "call_resolve",
      resolvedRef: "refs/heads/main",
      resolvedSha: sha,
      resolvedTree: tree,
      version: 2 as const,
    };

    expect(() =>
      assertResolvedSourceMatchesRepositoryAccess({ access: receipt, source })
    ).not.toThrow();
    expect(() =>
      assertResolvedSourceMatchesRepositoryAccess({
        access: receipt,
        source: {
          ...source,
          repository: { ...source.repository, name: "another-repository" },
        },
      })
    ).toThrow(
      "The live GitHub source does not match the confirmed repository access receipt."
    );
  });
});
