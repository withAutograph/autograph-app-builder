/* oxlint-disable eslint/require-await -- In-memory ports retain asynchronous setup and lease contracts. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryProductionIntentBoundSetup,
  createRepositoryProductionSignupLeaseGuard,
  assertNoConflictingProductionSetup,
  completeRepositoryProductionInvitation,
  projectRepositoryProductionSchemaNativeStatus,
  readRepositoryProductionCreatorAccess,
  resolveRepositoryProductionPlanRecipient,
} from "./repository-production-native";
import { PhysicalResourceLeaseBusyError } from "./postgres-physical-resource-lease";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import {
  assertRepositoryProductionApprovalReference,
  repositoryProductionApprovalDigest,
  repositoryProductionApprovalInput,
  repositoryProductionApprovalReference,
} from "./repository-production-approval";
import type { RepositoryProductionNativeStatus } from "./repository-production-native-status-contract";
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
    "signup-policy": { state: "idle" },
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
  let runtimeReady = true;
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
      compareAndSet: async (previous, record) => {
        if (previous.revision !== row.revision) {
          throw new Error("conflicting setup");
        }
        row = { ...row, revision: row.revision + 1, record: structuredClone(record) };
        return structuredClone(row);
      },
      read: async () => structuredClone(row),
      reserve: async () => {
        throw new Error("must reuse original app");
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
      if (context.effect === "bind-runtime") {
        runtimeReady = true;
      }
      if (context.effect === "creator-access") {
        creatorActive = true;
      }
    },
    isRuntimeBindingReady: () => runtimeReady,
    reconcile: async (context) =>
      context.effect === "bind-runtime" && !runtimeReady
        ? { state: "not-applied" }
        : { receipt: { effect: context.effect }, state: "applied" },
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
    requireRuntimeMetadata: () => {
      runtimeReady = false;
    },
    resource: structuredClone(initial.resource),
    credentials: structuredClone(initial.privateState),
    markPending: (effect: "creator-access" | "install-schema" | "bind-runtime") => {
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

describe("schema-only Production continuation", () => {
  const linkedEmail = "creator@example.test";

  it.each([oldIntent, { ...oldIntent, creatorEmail: linkedEmail }])(
    "uses the saved creator selection in both plan and prepare",
    async (savedIntent) => {
      const readRetainedRecipient = vi.fn(async () => linkedEmail);
      const input = { approvedSchemaRevision: true, readRetainedRecipient };
      const selected = await resolveRepositoryProductionPlanRecipient(input);
      const plannedIntent =
        selected === undefined ? savedIntent : { ...savedIntent, creatorEmail: selected };
      const reference = repositoryProductionApprovalReference(
        repositoryProductionApprovalInput(scope, plannedIntent),
      );
      const prepared = repositoryProductionApprovalInput(scope, savedIntent);
      expect(() => {
        assertRepositoryProductionApprovalReference(prepared, reference);
      }).not.toThrow();
      expect(readRetainedRecipient).not.toHaveBeenCalled();
      await expect(
        resolveRepositoryProductionPlanRecipient({ ...input, creatorEmail: "other@example.test" }),
      ).rejects.toThrow("repository_production_creator_recipient_locked");
    },
  );

  it("still discovers a linked recipient for ordinary setup", async () => {
    const readRetainedRecipient = vi.fn(async () => linkedEmail);
    await expect(
      resolveRepositoryProductionPlanRecipient({
        approvedSchemaRevision: false,
        readRetainedRecipient,
      }),
    ).resolves.toBe(linkedEmail);
    expect(readRetainedRecipient).toHaveBeenCalledOnce();
  });

  it("reports a deployed revision as pending until its schema is ready while preserving provider proof", async () => {
    const observation: RepositoryProductionNativeStatus = {
      version: 1,
      appId: scope.appId,
      observedAt: "2026-11-12T18:00:00.000Z",
      status: "available",
      deployment: { state: "active" },
      app: { state: "sign-in-required", url: "https://apps.example/requests" },
      requestedRevision: "live",
    };
    const isReady = vi.fn(async () => false);
    await expect(
      projectRepositoryProductionSchemaNativeStatus(observation, undefined, isReady),
    ).resolves.toEqual({ ...observation, requestedRevision: "awaiting-activation" });
    isReady.mockResolvedValueOnce(true);
    await expect(
      projectRepositoryProductionSchemaNativeStatus(observation, undefined, isReady),
    ).resolves.toEqual(observation);

    const withProof = {
      ...observation,
      deployment: { ...observation.deployment, requestedRevisionActive: true as const },
    };
    await expect(
      projectRepositoryProductionSchemaNativeStatus(withProof, true, isReady),
    ).resolves.toEqual(withProof);
    expect(isReady).toHaveBeenCalledTimes(2);
  });
});

describe("automatic setup completion", () => {
  it.each([false, true])(
    "resumes only missing runtime metadata before the durable-ready shortcut (pending: %s)",
    async (pending) => {
      const h = fixture();
      await h.setup.prepare(scope, revised);
      h.removeCreator();
      h.requireRuntimeMetadata();
      if (pending) {
        h.markPending("bind-runtime");
      }
      const before = structuredClone(h.row());
      h.applied.length = 0;
      expect(await h.setup.status(scope, revised)).toMatchObject({
        state: pending ? "reconciling" : "checking-access",
      });
      expect(await h.setup.resume(scope, revised)).toMatchObject({ state: "ready" });
      expect(h.applied).toEqual(["bind-runtime"]);
      expect(h.creatorActive()).toBe(false);
      expect(h.row().operationRef).toBe(before.operationRef);
      expect(h.row().record.resource).toEqual(before.record.resource);
      expect(h.row().record.privateState).toEqual(before.record.privateState);
      const acquired = h.acquired.length;
      expect(await h.setup.resume(scope, revised)).toMatchObject({ state: "ready" });
      expect(h.acquired).toHaveLength(acquired);
      expect(h.applied).toEqual(["bind-runtime"]);
    },
  );
  it.each(["creator", "invitee"] as const)(
    "returns pending when another physical continuation owns the %s completion slot",
    async (target) => {
      const result = await completeRepositoryProductionInvitation({
        creator: async () => {
          if (target === "creator") {
            throw new PhysicalResourceLeaseBusyError();
          }
          return "not-owned";
        },
        invitee: async () => {
          throw new PhysicalResourceLeaseBusyError();
        },
      });
      expect(result).toBe("pending");
    },
  );

  it("preserves real authorization and worker errors rather than reporting them as contention", async () => {
    const denied = new Error("owner revoked");
    await expect(
      completeRepositoryProductionInvitation({
        creator: async () => {
          throw denied;
        },
        invitee: async () => {},
      }),
    ).rejects.toBe(denied);
  });

  it("uses the authorized durable ready status instead of replaying setup and restoring revoked access", async () => {
    const h = fixture();
    await h.setup.prepare(scope, revised);
    h.removeCreator();
    const before = [...h.applied];
    const acquisitions = h.acquired.length;
    expect(await h.setup.resume(scope, revised)).toMatchObject({ state: "ready" });
    expect(h.applied).toEqual(before);
    expect(h.acquired).toHaveLength(acquisitions);
    expect(h.creatorActive()).toBe(false);
  });

  it("still resumes an incomplete schema effect under the approved revision", async () => {
    const h = fixture();
    await h.setup.prepare(scope, revised);
    h.markPending("install-schema");
    expect(await h.setup.resume(scope, revised)).toMatchObject({ state: "ready" });
    expect(h.row().record.effects["install-schema"].state).toBe("applied");
    expect(h.acquired.at(-1)).toEqual(revised);
  });
});

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

  it("blocks People recovery before a guarded schema install can create an access command", () => {
    const f = fixture();
    const row = f.row();
    row.record.workerCheckpoints.push({
      kind: "repository-production-schema-predecessor-v1",
      grantDigest: "current-grant",
      resourceId: row.record.resource?.resourceId ?? "missing",
      prior: { sessionId: oldIntent.sessionId, storage: oldIntent.storage },
      candidate: revised.storage,
    });
    row.record.intent = revised;
    const clientRequestId = randomUUID();
    const commands = [
      { action: "retry-setup", clientRequestId },
      { action: "renew-sign-in", clientRequestId },
      { action: "choose-creator-account", clientRequestId, email: "creator@example.test" },
    ] as const;
    for (const state of ["idle", "pending"] as const) {
      row.record.effects["install-schema"] =
        state === "idle" ? { state } : { state, attemptId: randomUUID() };
      for (const command of commands) {
        expect(() => {
          assertNoConflictingProductionSetup({ row, command, pendingCommandIds: [] });
        }).toThrow();
      }
    }
    row.record.effects["install-schema"] = { state: "applied" };
    for (const command of commands) {
      expect(() => {
        assertNoConflictingProductionSetup({ row, command, pendingCommandIds: [] });
      }).not.toThrow();
    }
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

describe("protected creator access reads", () => {
  it("starts invitation and membership reads before either completes", async () => {
    const f = fixture();
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const started = new Set<string>();
    const reading = readRepositoryProductionCreatorAccess(
      f.row(),
      async () => {
        started.add("identity");
        await gate.promise;
        return { status: "ready", email: "creator@example.test", canChooseAccount: false };
      },
      async () => {
        started.add("members");
        await gate.promise;
        return [{ id: "creator" }];
      },
    );
    try {
      await vi.waitFor(
        () => {
          expect(started).toEqual(new Set(["identity", "members"]));
        },
        { timeout: 100 },
      );
    } finally {
      gate.resolve();
    }
    await expect(reading).resolves.toMatchObject({
      identity: { status: "ready" },
      creatorRemoved: false,
    });
  });

  it("settles both reads before preserving the original first rejection", async () => {
    const f = fixture();
    const identity: PromiseWithResolvers<void> = Promise.withResolvers();
    const members: PromiseWithResolvers<void> = Promise.withResolvers();
    const started = new Set<string>();
    const failure = new Error("identity unavailable");
    let identityFinished = false;
    let settled = false;
    const reading = readRepositoryProductionCreatorAccess(
      f.row(),
      async () => {
        started.add("identity");
        try {
          await identity.promise;
          return { status: "ready", email: "creator@example.test", canChooseAccount: false };
        } finally {
          identityFinished = true;
        }
      },
      async () => {
        started.add("members");
        await members.promise;
        throw new Error("membership unavailable");
      },
    );
    const result = (async () => {
      try {
        await reading;
        return null;
      } catch (error) {
        return error;
      } finally {
        settled = true;
      }
    })();
    try {
      await vi.waitFor(
        () => {
          expect(started.size).toBe(2);
        },
        { timeout: 100 },
      );
      identity.reject(failure);
      await vi.waitFor(() => {
        expect(identityFinished).toBe(true);
      });
      expect(settled).toBe(false);
    } finally {
      identity.reject(failure);
      members.resolve();
    }
    await expect(result).resolves.toBe(failure);
  });
});

it.each([undefined, null])(
  "rejects an invalid protected membership read instead of claiming creator readiness",
  async (value) => {
    await expect(
      readRepositoryProductionCreatorAccess(
        fixture().row(),
        async () => ({ status: "ready", email: "creator@example.test", canChooseAccount: false }),
        async () => value,
      ),
    ).rejects.toThrow();
  },
);

it("preserves a membership rejection after the creator identity read succeeds", async () => {
  const failure = new Error("membership unavailable");
  await expect(
    readRepositoryProductionCreatorAccess(
      fixture().row(),
      async () => ({ status: "ready", email: "creator@example.test", canChooseAccount: false }),
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
});

describe("Production signup observation lease", () => {
  it("keeps prelease authorization free of signup observers and forwards the physical fence while held", async () => {
    let held = false;
    let current = true;
    let reads = 0;
    const assertFence = async () => {
      if (!held || !current) {
        throw new Error("physical lease lost");
      }
    };
    const guard = createRepositoryProductionSignupLeaseGuard(async (target, intent, fence) => {
      expect(target).toEqual(scope);
      expect(intent).toEqual(revised);
      await fence();
      reads += 1;
      await fence();
    });
    await guard.assertNoPending(scope, revised);
    expect(reads).toBe(0);
    held = true;
    await guard.run(assertFence, async () => {
      await guard.assertNoPending(scope, revised);
      expect(reads).toBe(1);
      current = false;
      await expect(guard.assertNoPending(scope, revised)).rejects.toThrow("physical lease lost");
      expect(reads).toBe(1);
    });
    held = false;
    await guard.assertNoPending(scope, revised);
    expect(reads).toBe(1);
  });

  it("clears the held fence after a blocked continuation and preserves unrelated pending claims", async () => {
    let reads = 0;
    const guard = createRepositoryProductionSignupLeaseGuard(
      async (_target, _intent, assertFence) => {
        await assertFence();
        reads += 1;
        throw new Error("other signup still pending");
      },
    );
    await expect(
      guard.run(
        async () => {},
        async () => {
          await guard.assertNoPending(scope);
        },
      ),
    ).rejects.toThrow("other signup still pending");
    await guard.assertNoPending(scope);
    expect(reads).toBe(1);
  });
});
