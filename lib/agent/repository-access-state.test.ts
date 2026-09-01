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
  status: "ready",
  repository: {
    repositoryId: "200",
    owner: "withAutograph",
    name: "app-builder-dogfood",
    archived: false,
    visibility: "private",
    defaultBranch: "main",
    headSha: sha,
    headTree: tree,
    repositoryVariableNames: [],
  },
  scope: {
    installationId: "10",
    accountLogin: "withAutograph",
    accountType: "Organization",
  },
  accessDigest,
} satisfies Extract<RepositoryAccessResult, { status: "ready" }>;

describe("session-bound repository access receipt", () => {
  it("records one closed canonical receipt and reuses it after the same fresh read-back", () => {
    const first = recordRepositoryAccessReceipt({
      current: undefined,
      sessionId: "ses_one",
      confirmedByCallId: "call_one",
      access,
    });
    const retried = recordRepositoryAccessReceipt({
      current: first,
      sessionId: "ses_one",
      confirmedByCallId: "call_retry",
      access,
    });

    expect(retried).toEqual(first);
    expect(first).toMatchObject({
      version: 1,
      sessionId: "ses_one",
      repository: {
        repositoryId: "200",
        owner: "withAutograph",
        name: "app-builder-dogfood",
        defaultBranch: "main",
        headSha: sha,
        headTree: tree,
      },
      scope: { installationId: "10" },
      providerAccessDigest: accessDigest,
      confirmedByCallId: "call_one",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(first.repository).not.toHaveProperty("repositoryVariableNames");
  });

  it("rotates on same-session provider drift and rejects cross-session state", () => {
    const first = recordRepositoryAccessReceipt({
      current: undefined,
      sessionId: "ses_one",
      confirmedByCallId: "call_one",
      access,
    });
    const changedHead = recordRepositoryAccessReceipt({
      current: first,
      sessionId: "ses_one",
      confirmedByCallId: "call_two",
      access: {
        ...access,
        repository: { ...access.repository, headSha: "4".repeat(40) },
      },
    });
    expect(changedHead.digest).not.toBe(first.digest);
    expect(() =>
      recordRepositoryAccessReceipt({
        current: changedHead,
        sessionId: "ses_two",
        confirmedByCallId: "call_three",
        access: {
          ...access,
          repository: { ...access.repository, headSha: "4".repeat(40) },
        },
      }),
    ).toThrow("Repository access state belongs to a different session.");
  });

  it("rejects tampering, extra fields, and stale source bindings", () => {
    const receipt = recordRepositoryAccessReceipt({
      current: undefined,
      sessionId: "ses_one",
      confirmedByCallId: "call_one",
      access,
    });
    expect(() =>
      repositoryAccessReceiptSchema.parse({
        ...receipt,
        digest: "0".repeat(64),
      }),
    ).toThrow("Repository access receipt digest is invalid.");
    expect(() =>
      repositoryAccessReceiptSchema.parse({ ...receipt, token: "secret" }),
    ).toThrow();
    expect(() =>
      recordRepositoryAccessReceipt({
        current: { ...receipt, digest: "0".repeat(64) },
        sessionId: "ses_one",
        confirmedByCallId: "call_two",
        access: {
          ...access,
          repository: { ...access.repository, headSha: "4".repeat(40) },
        },
      }),
    ).toThrow("Repository access receipt digest is invalid.");

    expect(
      assertRepositoryAccessReceiptForSource({
        receipt,
        expectedDigest: receipt.digest,
        sessionId: "ses_one",
        repositoryId: "200",
        ref: "refs/heads/main",
        expectedSha: sha,
        expectedTree: tree,
      }),
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
          receipt,
          expectedDigest: receipt.digest,
          sessionId: "ses_one",
          repositoryId: "200",
          ref: "refs/heads/main",
          expectedSha: sha,
          expectedTree: tree,
          ...changed,
        }),
      ).toThrow(
        "The repository access receipt does not match this session and source.",
      );
    }
  });

  it("binds the independently resolved source to the exact access observation", () => {
    const receipt = recordRepositoryAccessReceipt({
      current: undefined,
      sessionId: "ses_one",
      confirmedByCallId: "call_one",
      access,
    });
    const source = {
      version: 2 as const,
      repository: {
        version: 2 as const,
        repositoryId: "200",
        owner: "withAutograph",
        name: "app-builder-dogfood",
        visibility: "private" as const,
        defaultBranch: "main",
        headSha: sha,
        headTree: tree,
        installationIdentityDigest: "7".repeat(64),
        releaseGate: {
          name: "REPOSITORY_RELEASE_ENABLED" as const,
          configured: false,
        },
        digest: "8".repeat(64),
      },
      resolvedRef: "refs/heads/main",
      resolvedSha: sha,
      resolvedTree: tree,
      installationIdentityDigest: "7".repeat(64),
      resolvedByCallId: "call_resolve",
      digest: "9".repeat(64),
    };

    expect(() =>
      assertResolvedSourceMatchesRepositoryAccess({ access: receipt, source }),
    ).not.toThrow();
    expect(() =>
      assertResolvedSourceMatchesRepositoryAccess({
        access: receipt,
        source: {
          ...source,
          repository: { ...source.repository, name: "another-repository" },
        },
      }),
    ).toThrow(
      "The live GitHub source does not match the confirmed repository access receipt.",
    );
  });
});
