/* oxlint-disable eslint/require-await -- Controlled async ports expose the exact shared-lock race without database effects. */
import { describe, expect, it, vi } from "vitest";
import { retainRepositoryProductionApproval } from "./repository-production-approval-retention";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type {
  RepositoryProductionStore,
  RepositoryProductionSetupPorts,
} from "./repository-production-setup";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "requests",
  repositoryId: "repository",
  repositoryFullName: "example/apps",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.test",
  environment: "production",
};
const ownerContext = {
  kind: "direct" as const,
  authority: scope.authority,
  principal: { ...scope.authority, scopes: ["autograph:send"] },
  sessionId: "original-session",
  adapterSessionId: "adapter",
  adapterGeneration: 1,
};
const originalIntent: RepositoryProductionIntent = {
  sessionId: "original-session",
  sourceSha: "a".repeat(40),
  creatorRoles: [],
  storage: { kind: "none" },
  access: { mode: "self-signup", eligibility: "public", appRoles: [] },
  entryPath: "/requests",
};
const nextIntent: RepositoryProductionIntent = { ...originalIntent, access: { mode: "private" } };
const approval = (intent: RepositoryProductionIntent) => ({
  planDigest: repositoryProductionApprovalDigest(scope, intent),
  approvalId: "human-approval",
  approvedByCallId: "prepare",
});

const fixture = () => {
  let row: RepositoryProductionRow = {
    operationRef: repositoryProductionOperationRef(scope),
    revision: 1,
    record: {
      ...initialRepositoryProductionRecord(scope, originalIntent),
      ownerContext,
      approval: approval(originalIntent),
    },
  };
  let tail = Promise.resolve<null>(null);
  let held = false;
  let authorized = true;
  let unresolvedGrant = false;
  const withLease: RepositoryProductionSetupPorts["withLease"] = async (_scope, run) => {
    const preceding = tail;
    const release = Promise.withResolvers<null>();
    tail = release.promise;
    await preceding;
    held = true;
    try {
      return await run(async () => {
        if (!held || !authorized) {
          throw new Error("authorization_required");
        }
      });
    } finally {
      held = false;
      release.resolve(null);
    }
  };
  const compareAndSet = vi.fn<RepositoryProductionStore["compareAndSet"]>(
    async (before, record) => {
      expect(held).toBe(true);
      if (before.revision !== row.revision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS returns an explicit missing row on a stale revision.
        return undefined;
      }
      row = { ...row, revision: row.revision + 1, record };
      return row;
    },
  );
  const assertNoPendingAccess = vi.fn(async () => {
    expect(held).toBe(true);
    if (unresolvedGrant) {
      throw new Error("signup_reconciliation_required");
    }
  });
  const retain = async (intent = nextIntent) => {
    await retainRepositoryProductionApproval({
      scope,
      intent,
      ownerContext,
      approval: approval(intent),
      store: { read: async () => row, reserve: async () => row, compareAndSet },
      withLease,
      assertNoPendingAccess,
    });
  };
  return {
    retain,
    withLease,
    compareAndSet,
    assertNoPendingAccess,
    row: () => row,
    pending: (value: boolean) => {
      unresolvedGrant = value;
    },
    revoke: () => {
      authorized = false;
    },
  };
};

describe("Production approval retention", () => {
  it("keeps diagnostic source revisions resumable but protects claims from a changed creator approval", async () => {
    const test = fixture();
    test.row().record.effects["install-schema"].state = "pending";
    const sourceRevision = { ...originalIntent, sourceSha: "b".repeat(40) };
    test.pending(true);
    await test.retain(sourceRevision);
    expect(test.assertNoPendingAccess).not.toHaveBeenCalled();
    expect(test.row().record.intent).toEqual(originalIntent);
    expect(test.row().record.effects["install-schema"].state).toBe("pending");

    const recipient = { ...sourceRevision, creatorEmail: "chosen@example.com" };
    await expect(test.retain(recipient)).rejects.toThrow("signup_reconciliation_required");
    expect(test.row().record.approval).toEqual(approval(originalIntent));
    test.pending(false);
    await test.retain(recipient);
    expect(test.row().record.approval).toEqual(approval(recipient));
    expect(test.row().record.effects["install-schema"].state).toBe("pending");
  });
  it("waits for the held signup lease and rechecks unresolved effects before replacing its approval", async () => {
    const test = fixture();
    const entered = Promise.withResolvers<null>();
    const releaseGrant = Promise.withResolvers<null>();
    const signup = test.withLease(scope, async () => {
      entered.resolve(null);
      await releaseGrant.promise;
      test.pending(true);
    });
    await entered.promise;
    const revision = test.retain();
    expect(test.assertNoPendingAccess).not.toHaveBeenCalled();
    releaseGrant.resolve(null);
    await signup;
    await expect(revision).rejects.toThrow("signup_reconciliation_required");
    expect(test.compareAndSet).not.toHaveBeenCalled();
    expect(test.row().record.approval).toEqual(approval(originalIntent));
    test.pending(false);
    await test.retain();
    expect(test.row().record.approval).toEqual(approval(nextIntent));
    expect(test.row().record.intent).toEqual(originalIntent);
  });
  it("preserves the original approval when current owner or lease authority is lost", async () => {
    const test = fixture();
    test.revoke();
    await expect(test.retain()).rejects.toThrow("authorization_required");
    expect(test.compareAndSet).not.toHaveBeenCalled();
    expect(test.row().record.approval).toEqual(approval(originalIntent));
  });
});
