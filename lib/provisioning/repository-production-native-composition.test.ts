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
  appId: "requests",
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  environment: "production",
  organizationId: "org",
  projectId: "project",
  publicOrigin: "https://apps.example",
  repositoryFullName: "team/apps",
  repositoryId: "repo",
};
const oldIntent: RepositoryProductionIntent = {
  creatorRoles: ["reader"],
  sessionId: "saved-session",
  sourceSha: "a".repeat(40),
  storage: {
    artifactRef: "old-artifact",
    databaseEnvironment: "APP_DATABASE_URL",
    kind: "postgres",
    manifestSha256: "b".repeat(64),
    releaseId: "old-release",
  },
};
const revised: RepositoryProductionIntent = {
  ...oldIntent,
  creatorRoles: ["reader", "editor"],
  sourceSha: "c".repeat(40),
  storage: {
    artifactRef: "new-artifact",
    databaseEnvironment: "APP_DATABASE_URL",
    kind: "postgres",
    manifestSha256: "d".repeat(64),
    releaseId: "new-release",
  },
};

const fixture = () => {
  const initial = initialRepositoryProductionRecord(scope, oldIntent);
  initial.effects = {
    "allocate-storage": { state: "applied" },
    "bind-runtime": { state: "applied" },
    "creator-access": { state: "applied" },
    "install-schema": { state: "applied" },
  };
  initial.creatorActorId = "creator";
  initial.privateState = { retainedCredential: "encrypted-fixture" };
  initial.approval = {
    approvalId: "new-approval",
    approvedByCallId: "new-call",
    planDigest: repositoryProductionApprovalDigest(scope, revised),
  };
  let row: RepositoryProductionRow = {
    operationRef: repositoryProductionOperationRef(scope),
    record: initial,
    revision: 1,
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
    apply: async (context) => {
      applied.push(context.effect);
      if (context.effect === "creator-access") {
        creatorActive = true;
      }
    },
    assertAuthorized,
    readCreatorIdentity: async () => ({ actorId: "creator", state: "verified" }),
    reconcile: async (context) => ({ receipt: { effect: context.effect }, state: "applied" }),
    reconcileCreatorRoles: async () => {
      applied.push("roles");
      return "applied";
    },
    reservePrivateState: async () => {
      throw new Error("must reuse original credentials");
    },
    store: {
      compareAndSet: async (previous, record) => {
        if (previous.revision !== row.revision) {
          throw new Error("conflicting setup");
        }
        const revision = row.revision + 1;
        row = { ...row, record: structuredClone(record), revision };
        return structuredClone(row);
      },
      read: async () => structuredClone(row),
      reserve: async () => {
        throw new Error("must reuse original app");
      },
    },
  };
  const setup = createRepositoryProductionIntentBoundSetup(
    ports,
    async (target, requested, run) => {
      acquired.push(requested);
      // Mirrors the real lease's initialization and every subsequent fence read.
      await assertAuthorized(target, requested);
      const revision = row.revision + 1;
      const leaseId = randomUUID();
      const fenceGeneration = (row.record.lease?.fenceGeneration ?? 0) + 1;
      row = {
        ...row,
        record: {
          ...row.record,
          lease: {
            fenceGeneration,
            leaseId,
          },
        },
        revision,
      };
      return await run(async () => {
        await assertAuthorized(target, requested);
      });
    },
  );
  const resource = structuredClone(initial.resource);
  const credentials = structuredClone(initial.privateState);
  return {
    acquired,
    applied,
    assertAuthorized,
    creatorActive: () => creatorActive,
    credentials,
    markPending: (effect: "creator-access" | "install-schema") => {
      row = {
        ...row,
        record: {
          ...row.record,
          effects: {
            ...row.record.effects,
            [effect]: { attemptId: randomUUID(), state: "pending" },
          },
        },
      };
    },
    removeCreator: () => {
      creatorActive = false;
    },
    resource,
    row: () => row,
    setup,
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
      assertNoConflictingProductionSetup({ command, pendingCommandIds: [], row: f.row() });
    }).toThrow();
    expect(f.creatorActive()).toBe(true);
    await f.setup.prepare(scope, revised);
    expect(() => {
      assertNoConflictingProductionSetup({ command, pendingCommandIds: [], row: f.row() });
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
          const row = f.row();
          assertNoConflictingProductionSetup({
            command: { action, clientRequestId: randomUUID() },
            pendingCommandIds: [],
            row,
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
          command,
          pendingCommandIds: [command.clientRequestId],
          row: f.row(),
        });
      }).not.toThrow();
      expect(() => {
        assertNoConflictingProductionSetup({ command, pendingCommandIds: [], row: f.row() });
      }).toThrow();
    },
  );
});
