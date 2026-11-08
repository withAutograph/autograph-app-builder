/* oxlint-disable eslint/require-await -- In-memory ports retain asynchronous setup and lease contracts. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRepositoryProductionIntentBoundSetup,
  assertNoConflictingProductionSetup,
} from "./repository-production-native";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import type { RepositoryProductionSetupPorts } from "./repository-production-setup";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "requests",
  repositoryId: "repo",
  repositoryFullName: "team/apps",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.example",
  environment: "production",
};
const oldIntent: RepositoryProductionIntent = {
  sessionId: "saved-session",
  sourceSha: "a".repeat(40),
  creatorRoles: ["reader"],
  storage: {
    kind: "postgres",
    artifactRef: "old-artifact",
    releaseId: "old-release",
    manifestSha256: "b".repeat(64),
    databaseEnvironment: "APP_DATABASE_URL",
  },
};
const revised: RepositoryProductionIntent = {
  ...oldIntent,
  sourceSha: "c".repeat(40),
  creatorRoles: ["reader", "editor"],
  storage: {
    kind: "postgres",
    artifactRef: "new-artifact",
    releaseId: "new-release",
    manifestSha256: "d".repeat(64),
    databaseEnvironment: "APP_DATABASE_URL",
  },
};

const fixture = () => {
  const initial = initialRepositoryProductionRecord(scope, oldIntent);
  initial.effects = {
    "allocate-storage": { state: "applied" },
    "install-schema": { state: "applied" },
    "creator-access": { state: "applied" },
    "bind-runtime": { state: "applied" },
  };
  initial.creatorActorId = "creator";
  initial.privateState = { retainedCredential: "encrypted-fixture" };
  initial.approval = {
    planDigest: repositoryProductionApprovalDigest(scope, revised),
    approvalId: "new-approval",
    approvedByCallId: "new-call",
  };
  let row: RepositoryProductionRow = {
    operationRef: repositoryProductionOperationRef(scope),
    revision: 1,
    record: initial,
  };
  const applied: string[] = [];
  let creatorActive = true;
  const acquired: RepositoryProductionIntent[] = [];
  const assertAuthorized: RepositoryProductionSetupPorts["assertAuthorized"] = async (
    target,
    intent,
  ) => {
    if (row.record.approval?.planDigest !== repositoryProductionApprovalDigest(target, intent)) {
      throw new Error("repository_production_approval_required");
    }
  };
  const ports: Omit<RepositoryProductionSetupPorts, "withLease"> = {
    assertAuthorized,
    store: {
      read: async () => structuredClone(row),
      reserve: async () => {
        throw new Error("must reuse original app");
      },
      compareAndSet: async (previous, record) => {
        if (previous.revision !== row.revision) {
          throw new Error("conflicting setup");
        }
        row = { ...row, revision: row.revision + 1, record: structuredClone(record) };
        return structuredClone(row);
      },
    },
    reservePrivateState: async () => {
      throw new Error("must reuse original credentials");
    },
    readCreatorIdentity: async () => ({ actorId: "creator", state: "verified" }),
    reconcileCreatorRoles: async () => {
      applied.push("roles");
      return "applied";
    },
    apply: async (context) => {
      applied.push(context.effect);
      if (context.effect === "creator-access") {
        creatorActive = true;
      }
    },
    reconcile: async (context) => ({ receipt: { effect: context.effect }, state: "applied" }),
  };
  const setup = createRepositoryProductionIntentBoundSetup(
    ports,
    async (target, requested, run) => {
      acquired.push(requested);
      // Mirrors the real lease's initialization and every subsequent fence read.
      await assertAuthorized(target, requested);
      row = {
        ...row,
        revision: row.revision + 1,
        record: {
          ...row.record,
          lease: {
            leaseId: randomUUID(),
            fenceGeneration: (row.record.lease?.fenceGeneration ?? 0) + 1,
          },
        },
      };
      return await run(async () => {
        await assertAuthorized(target, requested);
      });
    },
  );
  return {
    setup,
    row: () => row,
    applied,
    acquired,
    assertAuthorized,
    resource: structuredClone(initial.resource),
    credentials: structuredClone(initial.privateState),
    markPending: (effect: "creator-access" | "install-schema") => {
      row = {
        ...row,
        record: {
          ...row.record,
          effects: {
            ...row.record.effects,
            [effect]: { state: "pending", attemptId: randomUUID() },
          },
        },
      };
    },
    creatorActive: () => creatorActive,
    removeCreator: () => {
      creatorActive = false;
    },
  };
};

describe("Production setup approval and lease composition", () => {
  it("authorizes a schema and role revision while reusing the existing database, credentials, and creator", async () => {
    const f = fixture();
    await expect(f.assertAuthorized(scope, oldIntent)).rejects.toThrow(
      "repository_production_approval_required",
    );
    expect(f.row().record.intent).toEqual(oldIntent);
    expect(await f.setup.prepare(scope, revised)).toMatchObject({ state: "ready" });
    expect(f.acquired).toEqual([revised]);
    expect(f.row().record.intent).toEqual(revised);
    expect(f.row().record.resource).toEqual(f.resource);
    expect(f.row().record.privateState).toEqual(f.credentials);
    expect(f.row().record.creatorActorId).toBe("creator");
    expect(f.applied).toEqual(["install-schema", "roles", "bind-runtime"]);
  });

  it("reads status without acquiring a new lease or changing access", async () => {
    const f = fixture();
    expect(await f.setup.status(scope, revised)).toMatchObject({ state: "reconciling" });
    expect(f.acquired).toEqual([]);
    expect(f.applied).toEqual([]);
    expect(f.row().record.intent).toEqual(oldIntent);
  });

  it("reconciles an interrupted creator grant before permitting removal and does not regrant on later setup", async () => {
    const f = fixture();
    await f.setup.prepare(scope, revised);
    f.markPending("creator-access");
    const command = {
      action: "remove" as const,
      clientRequestId: randomUUID(),
      memberId: "creator",
    };
    expect(() => {
      assertNoConflictingProductionSetup({ row: f.row(), command, pendingCommandIds: [] });
    }).toThrow();
    expect(f.creatorActive()).toBe(true);
    await f.setup.prepare(scope, revised);
    expect(() => {
      assertNoConflictingProductionSetup({ row: f.row(), command, pendingCommandIds: [] });
    }).not.toThrow();
    f.removeCreator();
    await f.setup.prepare(scope, revised);
    expect(f.creatorActive()).toBe(false);
    expect(f.applied).not.toContain("creator-access");
  });

  it.each(["creator-access", "install-schema"] as const)(
    "allows recovery and an existing journaled command while %s is pending",
    async (effect) => {
      const f = fixture();
      await f.setup.prepare(scope, revised);
      f.markPending(effect);
      for (const action of ["retry-setup", "renew-sign-in"] as const) {
        expect(() => {
          assertNoConflictingProductionSetup({
            row: f.row(),
            command: { action, clientRequestId: randomUUID() },
            pendingCommandIds: [],
          });
        }).not.toThrow();
      }
      const command = {
        action: "remove" as const,
        clientRequestId: randomUUID(),
        memberId: "guest",
      };
      expect(() => {
        assertNoConflictingProductionSetup({
          row: f.row(),
          command,
          pendingCommandIds: [command.clientRequestId],
        });
      }).not.toThrow();
      expect(() => {
        assertNoConflictingProductionSetup({ row: f.row(), command, pendingCommandIds: [] });
      }).toThrow();
    },
  );
});
