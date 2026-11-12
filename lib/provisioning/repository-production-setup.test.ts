/* oxlint-disable eslint/no-nested-ternary, sonarjs/no-nested-conditional -- The fixture directly models unknown, applied and absent readback states. */
/* oxlint-disable promise/avoid-new -- The fixture models a real serialized lease so concurrent resumes exercise ordering. */
/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member -- Async fixture ports retain rejection semantics; assertions inspect their awaited outcomes directly. */
import { describe, expect, it, vi } from "vitest";
import { createRepositoryProductionSetup } from "./repository-production-setup";
import type {
  RepositoryProductionSetupPorts,
  RepositoryProductionEffectContext,
  RepositoryProductionObservation,
} from "./repository-production-setup";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import { repositoryProductionOperationRef } from "./repository-production-contract";
import { createRepositoryProductionAccessUpgrader } from "./repository-production-access-upgrade";
import { assertNoConflictingCreatorRoleUpdate } from "./repository-production-role-update";
import type { AppAccessCommand } from "../app-access/contracts";

const scope: RepositoryProductionScope = {
  appId: "request-log",
  authority: {
    audience: "https://builder.test/mcp",
    issuer: "https://builder.test/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  environment: "production",
  organizationId: "organization",
  projectId: "project",
  publicOrigin: "https://apps.test",
  repositoryFullName: "example/apps",
  repositoryId: "repository",
};
const intent: RepositoryProductionIntent = {
  creatorRoles: ["requester"],
  sessionId: "session",
  sourceSha: "a".repeat(40),
  storage: {
    artifactRef: "artifact",
    databaseEnvironment: "REQUEST_LOG_DATABASE_URL",
    kind: "postgres",
    manifestSha256: "b".repeat(64),
    releaseId: "release",
  },
};
const fixture = () => {
  let row: RepositoryProductionRow | undefined;
  let lock: Promise<void> = Promise.resolve();
  let authorized = true;
  let identity = true;
  let interrupt = false;
  let unknown = false;
  const calls: string[] = [];
  const actual = new Set<string>();
  const ports: RepositoryProductionSetupPorts = {
    apply: async ({ effect, row: current }) => {
      expect(current.record.effects[effect].state).toBe("pending");
      if (effect === "allocate-storage") {
        expect(current.record.privateState).toEqual({ sealed: "private" });
      }
      calls.push(effect);
      actual.add(effect);
      if (interrupt) {
        interrupt = false;
        throw new Error("connection lost");
      }
    },
    assertAuthorized: async () => {
      if (!authorized) {
        throw new Error("not authorized");
      }
    },
    readCreatorIdentity: async () =>
      identity
        ? { actorId: "creator", state: "verified" }
        : {
            expiresAt: "2026-11-07T15:10:00.000Z",
            signInUrl: "https://apps.test/sign-in",
            state: "required",
          },
    reconcile: async ({ effect }): Promise<RepositoryProductionObservation> =>
      unknown
        ? { state: "unknown" }
        : actual.has(effect)
          ? { receipt: { effect }, state: "applied" }
          : { state: "not-applied" },
    reconcileCreatorRoles: async (context) => {
      if (!actual.has("creator-access")) {
        return "skipped";
      }
      calls.push(`roles:${context.row.record.creatorRoleUpdate?.roles.join(",")}`);
      return "applied";
    },
    reservePrivateState: async () => {
      calls.push("credentials");
      return { sealed: "private" };
    },
    store: {
      compareAndSet: async (before, record) => {
        if (row?.revision !== before.revision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence is the explicit optional-store result.
          return undefined;
        }
        row = { ...before, record: structuredClone(record), revision: before.revision + 1 };
        return structuredClone(row);
      },
      read: async () => (row === undefined ? undefined : structuredClone(row)),
      reserve: async (record) => {
        row ??= {
          operationRef: repositoryProductionOperationRef(record.scope),
          record: structuredClone(record),
          revision: 1,
        };
        return structuredClone(row);
      },
    },
    withLease: async (_scope, run) => {
      const previous = lock;
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep fixture helpers scoped to their test or fixture instance.
      let release = () => {};
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await run(async () => {});
      } finally {
        release();
      }
    },
  };
  return {
    actual,
    calls,
    interrupt: () => {
      interrupt = true;
    },
    ports,
    read: () => row,
    revoke: () => {
      authorized = false;
    },
    service: createRepositoryProductionSetup(ports),
    setIdentity: (value: boolean) => {
      identity = value;
    },
    uncertain: () => {
      unknown = true;
    },
  };
};
const revisedSchemaIntent = (): RepositoryProductionIntent => {
  if (intent.storage.kind !== "postgres") {
    throw new Error("Fixture must have an existing database");
  }
  return {
    ...intent,
    sourceSha: "c".repeat(40),
    storage: {
      ...intent.storage,
      artifactRef: "next-artifact",
      manifestSha256: "d".repeat(64),
      releaseId: "next-release",
    },
  };
};

describe("Approved existing Production schema revision", () => {
  it("uses the original resource and only installs schema, reconciling a lost acknowledgment", async () => {
    const f = fixture();
    const next = revisedSchemaIntent();
    await f.service.prepare(scope, intent);
    const before = structuredClone(f.read()?.record);
    const verify = vi.fn(
      async (prior: RepositoryProductionEffectContext, candidate: RepositoryProductionIntent) => {
        expect(prior.row.record.intent.storage).toEqual(intent.storage);
        expect(prior.row.record.resource).toEqual(before?.resource);
        expect(candidate).toEqual(next);
      },
    );
    const assertActive = vi.fn(async () => {});
    f.ports.schemaRevision = { grantDigest: "new-grant", verify, assertActive };
    f.calls.length = 0;
    f.actual.delete("install-schema");
    f.interrupt();

    await expect(f.service.prepare(scope, next)).rejects.toThrow("connection lost");
    const { schemaRevision } = f.ports;
    delete f.ports.schemaRevision;
    await expect(f.service.prepare(scope, next)).rejects.toThrow(
      "repository_production_schema_revision_unverified",
    );
    f.ports.schemaRevision = schemaRevision;
    await expect(f.service.prepare(scope, next)).resolves.toMatchObject({ state: "ready" });

    expect(f.calls).toEqual(["install-schema"]);
    expect(verify).toHaveBeenCalledOnce();
    expect(assertActive).toHaveBeenCalledOnce();
    const saved = f.read()?.record;
    expect(saved?.intent).toEqual(next);
    expect(saved?.resource).toEqual(before?.resource);
    expect(saved?.privateState).toEqual(before?.privateState);
    expect(saved?.creatorActorId).toBe(before?.creatorActorId);
    expect(saved?.effects["install-schema"].state).toBe("applied");
    expect(saved?.effects["allocate-storage"]).toEqual(before?.effects["allocate-storage"]);
    expect(saved?.effects["bind-runtime"]).toEqual(before?.effects["bind-runtime"]);
    expect(saved?.effects["creator-access"]).toEqual(before?.effects["creator-access"]);
    expect(saved?.effects["signup-policy"]).toEqual(before?.effects["signup-policy"]);
  });

  it("checks active deployment before DDL and refuses changed access or an absent database", async () => {
    const f = fixture();
    const next = revisedSchemaIntent();
    const verify = vi.fn(async () => {});
    const assertActive = vi.fn(async () => {
      throw new Error("deployment moved");
    });
    const schemaRevision = { grantDigest: "new-grant", verify, assertActive };
    f.ports.schemaRevision = schemaRevision;
    await expect(f.service.prepare(scope, next)).rejects.toThrow(
      "repository_production_schema_revision_unverified",
    );
    expect(f.read()).toBeUndefined();

    delete f.ports.schemaRevision;
    await f.service.prepare(scope, intent);
    const before = structuredClone(f.read()?.record);
    f.calls.length = 0;
    f.ports.schemaRevision = schemaRevision;
    await expect(
      f.service.prepare(scope, { ...next, creatorRoles: ["another-role"] }),
    ).rejects.toThrow("repository_production_schema_revision_unverified");
    expect(f.read()?.record).toEqual(before);
    expect(verify).not.toHaveBeenCalled();
    await expect(f.service.prepare(scope, next)).rejects.toThrow("deployment moved");
    expect(verify).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
    expect(f.read()?.record.resource).toEqual(before?.resource);
  });
});

describe("Builder-owned Production setup", () => {
  it("backfills missing runtime metadata without replaying completed resources or restoring removed access", async () => {
    const f = fixture();
    await f.service.prepare(scope, intent);
    const saved = structuredClone(f.read());
    f.actual.delete("creator-access");
    let ready = false;
    f.ports.isRuntimeBindingReady = () => ready;
    const { apply, reconcile } = f.ports;
    f.ports.apply = async (context) => {
      expect(context.effect).toBe("bind-runtime");
      await apply(context);
      ready = true;
    };
    f.ports.reconcile = async (context) =>
      context.effect === "bind-runtime" && !ready
        ? { state: "not-applied" }
        : await reconcile(context);
    expect((await f.service.status(scope, intent)).state).toBe("checking-access");
    f.calls.length = 0;
    expect((await f.service.prepare(scope, intent)).state).toBe("ready");
    expect(f.calls).toEqual(["bind-runtime"]);
    expect(f.actual.has("creator-access")).toBe(false);
    expect(f.read()?.operationRef).toBe(saved?.operationRef);
    expect(f.read()?.record.resource).toEqual(saved?.record.resource);
    expect(f.read()?.record.privateState).toEqual(saved?.record.privateState);
    expect((await f.service.status(scope, intent)).state).toBe("ready");
  });
  it("keeps a frontend-only roleless app ready without requesting database boundary metadata", async () => {
    const f = fixture();
    f.ports.isRuntimeBindingReady = () => {
      throw new Error("frontend must not require database metadata");
    };
    const frontend = { ...intent, creatorRoles: [], storage: { kind: "none" as const } };
    expect((await f.service.prepare(scope, frontend)).state).toBe("ready");
    expect((await f.service.status(scope, frontend)).state).toBe("ready");
    expect(f.calls).not.toContain("allocate-storage");
    expect(f.calls).not.toContain("install-schema");
    expect(f.calls).not.toContain("bind-runtime");
  });
  it("retains allocation and its pending schema when an approved recipient is selected", async () => {
    const f = fixture();
    f.setIdentity(false);
    await f.service.prepare(scope, intent);
    const saved = f.read();
    if (!saved) {
      throw new Error("missing saved setup");
    }
    const resource = structuredClone(saved.record.resource);
    const credentials = structuredClone(saved.record.privateState);
    saved.record.effects["install-schema"] = {
      state: "pending",
      attemptId: "11111111-1111-4111-a111-111111111111",
    };
    await f.service.prepare(scope, { ...intent, creatorEmail: "chosen@example.com" });
    expect(f.read()?.record.intent.creatorEmail).toBe("chosen@example.com");
    expect(f.read()?.record.resource).toEqual(resource);
    expect(f.read()?.record.privateState).toEqual(credentials);
    expect(f.calls.filter((call) => call === "allocate-storage")).toHaveLength(1);
    expect(f.read()?.record.effects["install-schema"].state).toBe("pending");
  });
  it("keeps policy revisions and disablement separate from existing grants and storage", async () => {
    const f = fixture();
    const publicIntent: RepositoryProductionIntent = {
      ...intent,
      access: { mode: "self-signup", eligibility: "public", appRoles: ["requester"] },
      entryPath: "/request-log",
    };
    await f.service.prepare(scope, publicIntent);
    const original = structuredClone(f.read()?.record);
    expect(f.calls.at(-1)).toBe("signup-policy");
    f.actual.delete("signup-policy");
    await f.service.prepare(scope, { ...intent, access: { mode: "private" } });
    expect(f.calls.filter((call) => call === "signup-policy")).toHaveLength(2);
    expect(f.calls.filter((call) => call === "creator-access")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "allocate-storage")).toHaveLength(1);
    expect(f.read()?.record.resource).toEqual(original?.resource);
    expect(f.read()?.record.privateState).toEqual(original?.privateState);
    expect(f.read()?.record.creatorActorId).toEqual(original?.creatorActorId);
    expect(f.read()?.record.effects["creator-access"]).toEqual(original?.effects["creator-access"]);
  });

  it.each([true, false])(
    "adds storage for existing compatible members without restoring a removed creator (creator active: %s)",
    async (creatorActive) => {
      const f = fixture();
      const frontend = { ...intent, storage: { kind: "none" as const } };
      await f.service.prepare(scope, frontend);
      const members = [
        { id: "invitee", roles: ["requester"] },
        { id: "incompatible", roles: ["retired-role"] },
      ];
      if (creatorActive) {
        members.push({ id: "creator", roles: ["requester"] });
      } else {
        f.actual.delete("creator-access");
      }
      const kernel = new Map<string, string[]>();
      f.ports.reconcileAppAccessUpgrade = createRepositoryProductionAccessUpgrader({
        execute: async (context, command) => {
          expect(context.row.record.effects["install-schema"].state).toBe("applied");
          if (command.action !== "change-role") {
            throw new Error("Unexpected upgrade operation");
          }
          kernel.set(command.memberId, command.roles);
        },
        readMembers: async () => members,
      });
      expect((await f.service.prepare(scope, intent)).state).toBe("ready");
      expect(kernel.get("invitee")).toEqual(["requester"]);
      expect(kernel.get("creator")).toEqual(creatorActive ? ["requester"] : undefined);
      expect(kernel.has("incompatible")).toBe(false);
      expect(f.read()?.record.appAccessUpgrade?.state).toBe("applied");
      expect(f.calls.filter((call) => call === "creator-access")).toHaveLength(1);
      expect(f.calls.filter((call) => call === "allocate-storage")).toHaveLength(1);
    },
  );

  it("resumes an interrupted storage access upgrade from its saved member and People request identities", async () => {
    const f = fixture();
    await f.service.prepare(scope, { ...intent, creatorRoles: [], storage: { kind: "none" } });
    const members: { id: string; roles: string[] }[] = [
      { id: "creator", roles: [] },
      { id: "invitee", roles: [] },
    ];
    const completed = new Set<string>();
    const grants: string[] = [];
    const commands: AppAccessCommand[] = [];
    let interrupted = false;
    f.ports.reconcileAppAccessUpgrade = createRepositoryProductionAccessUpgrader({
      execute: async (_context, command) => {
        if (command.action !== "change-role") {
          throw new Error("Unexpected upgrade operation");
        }
        commands.push(command);
        if (!completed.has(command.clientRequestId)) {
          grants.push(command.memberId);
          completed.add(command.clientRequestId);
        }
        if (!interrupted) {
          interrupted = true;
          throw new Error("lost grant reply");
        }
      },
      readMembers: async () => members,
    });
    const revised = { ...intent, creatorRoles: [] };
    await expect(f.service.prepare(scope, revised)).rejects.toThrow("lost grant reply");
    expect((await f.service.status(scope, revised)).state).toBe("reconciling");
    const current = f.read();
    expect(current?.record.appAccessUpgrade?.state).toBe("pending");
    expect(() => {
      assertNoConflictingCreatorRoleUpdate({
        commandId: "fresh-removal",
        pendingCommandIds: [],
        row: current,
      });
    }).toThrow();
    expect(
      (await f.service.prepare(scope, { ...revised, creatorRoles: ["requester"] })).state,
    ).toBe("reconciling");
    members.push({ id: "later-member", roles: [] });
    const restarted = createRepositoryProductionSetup(f.ports);
    expect((await restarted.prepare(scope, revised)).state).toBe("ready");
    expect(grants).toEqual(["creator", "invitee"]);
    expect(commands[1]).toEqual(commands[0]);
    expect(
      commands.every((command) => command.action === "change-role" && command.roles.length === 0),
    ).toBe(true);
    expect(f.read()?.record.appAccessUpgrade?.state).toBe("applied");
    expect(f.calls.filter((call) => call === "creator-access")).toHaveLength(1);
  });

  it("leaves a separately reviewed creator role change to the existing role updater", async () => {
    const f = fixture();
    await f.service.prepare(scope, { ...intent, storage: { kind: "none" } });
    const upgraded: string[] = [];
    f.ports.reconcileAppAccessUpgrade = createRepositoryProductionAccessUpgrader({
      execute: async (_context, command) => {
        if (command.action === "change-role") {
          upgraded.push(command.memberId);
        }
      },
      readMembers: async () => [
        { id: "creator", roles: ["requester"] },
        { id: "invitee", roles: ["requester"] },
      ],
    });
    expect(
      (await f.service.prepare(scope, { ...intent, creatorRoles: ["requester", "approver"] }))
        .state,
    ).toBe("ready");
    expect(upgraded).toEqual(["invitee"]);
    expect(f.calls).toContain("roles:approver,requester");
  });
  it("prepares persistent apps, waits only for identity, then grants access without database questions", async () => {
    const f = fixture();
    f.setIdentity(false);
    expect((await f.service.prepare(scope, intent)).state).toBe("identity-required");
    expect(f.calls).toEqual(["credentials", "allocate-storage"]);
    f.setIdentity(true);
    expect((await f.service.prepare(scope, intent)).state).toBe("ready");
    expect(f.calls).toEqual([
      "credentials",
      "allocate-storage",
      "install-schema",
      "creator-access",
      "bind-runtime",
    ]);
  });
  it("persists the verified creator before initial schema installation without granting access early", async () => {
    const f = fixture();
    const { apply } = f.ports;
    f.ports.prepareCreatorIdentity = async ({ row, assertCurrent }) => {
      await assertCurrent();
      expect(row.record.effects["allocate-storage"].state).toBe("applied");
    };
    f.ports.apply = async (context) => {
      if (context.effect === "install-schema") {
        expect(context.row.record.creatorActorId).toBe("creator");
        expect(context.row.record.effects["creator-access"].state).toBe("idle");
        expect(f.actual.has("creator-access")).toBe(false);
      }
      await apply(context);
    };
    expect((await f.service.prepare(scope, intent)).state).toBe("ready");
  });

  it("surfaces the saved sign-in while an old initial schema attempt remains pending", async () => {
    const f = fixture();
    f.setIdentity(false);
    await f.service.prepare(scope, intent);
    const current = f.read();
    if (current === undefined) {
      throw new Error("Setup fixture is missing");
    }
    await f.ports.store.compareAndSet(current, {
      ...current.record,
      effects: {
        ...current.record.effects,
        "install-schema": { state: "pending", attemptId: "11111111-1111-4111-a111-111111111111" },
      },
    });
    const calls = [...f.calls];
    const revision = f.read()?.revision;
    expect(await f.service.status(scope, intent)).toMatchObject({
      state: "identity-required",
      signInUrl: "https://apps.test/sign-in",
    });
    expect(f.calls).toEqual(calls);
    expect(f.read()?.revision).toBe(revision);
    f.setIdentity(true);
    expect((await f.service.status(scope, intent)).state).toBe("reconciling");
    expect((await f.service.prepare(scope, intent)).state).toBe("ready");
    expect(f.calls.filter((call) => call === "allocate-storage")).toHaveLength(1);
  });

  it("rejects an actor change between schema installation and the initial access grant", async () => {
    const f = fixture();
    f.ports.readCreatorIdentity = async () => ({
      actorId: f.actual.has("install-schema") ? "different-actor" : "creator",
      state: "verified",
    });
    await expect(f.service.prepare(scope, intent)).rejects.toThrow("identity_changed");
    expect(f.calls).toEqual(["credentials", "allocate-storage", "install-schema"]);
    expect(f.read()?.record.creatorActorId).toBe("creator");
    expect(f.actual.has("creator-access")).toBe(false);
  });

  it("keeps unknown allocation ahead of sign-in and preserves the saved operation", async () => {
    const f = fixture();
    f.interrupt();
    await expect(f.service.prepare(scope, intent)).rejects.toThrow("connection lost");
    f.ports.readCreatorIdentity = async () => {
      throw new Error("Allocation must reconcile before reading creator identity");
    };
    const before = structuredClone(f.read());
    expect((await f.service.status(scope, intent)).state).toBe("reconciling");
    expect(f.read()).toEqual(before);
  });

  it("stops before initial schema work if authority is revoked during identity setup", async () => {
    const f = fixture();
    f.ports.prepareCreatorIdentity = async () => {
      f.revoke();
    };
    await expect(f.service.prepare(scope, intent)).rejects.toThrow("not authorized");
    expect(f.calls).toEqual(["credentials", "allocate-storage"]);
    expect(f.read()?.record.creatorActorId).toBeUndefined();
    expect(f.read()?.record.effects["install-schema"].state).toBe("idle");
  });

  it("returns the pending sign-in and recorded expiry on read-only status", async () => {
    const f = fixture();
    f.setIdentity(false);
    const pending = await f.service.prepare(scope, intent);
    const calls = [...f.calls];
    const revision = f.read()?.revision;
    const status = await f.service.status(scope, intent);
    expect(status).toMatchObject({
      expiresAt: "2026-11-07T15:10:00.000Z",
      operationRef: pending.operationRef,
      signInUrl: "https://apps.test/sign-in",
      state: "identity-required",
    });
    expect(f.calls).toEqual(calls);
    expect(f.read()?.revision).toBe(revision);
  });

  it("reconciles interruption after allocation and reuses the exact same resource and credentials", async () => {
    const f = fixture();
    f.interrupt();
    await expect(f.service.prepare(scope, intent)).rejects.toThrow("connection lost");
    const resource = f.read()?.record.resource;
    expect((await f.service.prepare(scope, intent)).state).toBe("ready");
    expect(f.read()?.record.resource).toEqual(resource);
    expect(f.calls.filter((call) => call === "allocate-storage")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "credentials")).toHaveLength(1);
  });
  it("serializes concurrent resumes and never creates duplicate databases or grants", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.prepare(scope, intent),
      f.service.prepare(scope, intent),
    ]);
    expect(results.every((result) => result.state === "ready")).toBe(true);
    expect(f.calls.filter((call) => call === "allocate-storage")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "creator-access")).toHaveLength(1);
  });
  it.each(["postgres", "none"] as const)(
    "keeps a completed %s setup ready across a source-only revision without repeating effects",
    async (kind) => {
      const f = fixture();
      const selected = kind === "none" ? { ...intent, storage: { kind: "none" as const } } : intent;
      await f.service.prepare(scope, selected);
      const before = structuredClone(f.read());
      const calls = [...f.calls];
      const revised = { ...selected, sourceSha: "c".repeat(40) };
      expect((await f.service.status(scope, revised)).state).toBe("ready");
      expect((await f.service.prepare(scope, revised)).state).toBe("ready");
      expect(f.calls).toEqual(calls);
      expect(f.read()?.record.resource).toEqual(before?.record.resource);
    },
  );
  it("keeps the original sign-in continuation across a source-only revision", async () => {
    const f = fixture();
    f.setIdentity(false);
    const original = await f.service.prepare(scope, intent);
    expect(original.state).toBe("identity-required");
    const calls = [...f.calls];
    const revised = { ...intent, sourceSha: "c".repeat(40) };
    expect(await f.service.status(scope, revised)).toEqual(original);
    expect(await f.service.prepare(scope, revised)).toEqual(original);
    expect(f.calls).toEqual(calls);
  });
  it("reconciles the same interrupted write after a source-only revision without allocating twice", async () => {
    const f = fixture();
    f.interrupt();
    await expect(f.service.prepare(scope, intent)).rejects.toThrow("connection lost");
    expect((await f.service.prepare(scope, { ...intent, sourceSha: "c".repeat(40) })).state).toBe(
      "ready",
    );
    expect(f.calls.filter((call) => call === "allocate-storage")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "credentials")).toHaveLength(1);
  });
  it("still reconciles actual schema and access changes", async () => {
    const f = fixture();
    await f.service.prepare(scope, intent);
    expect((await f.service.status(scope, { ...intent, creatorRoles: ["approver"] })).state).toBe(
      "reconciling",
    );
    if (intent.storage.kind !== "postgres") {
      throw new Error("Expected the database fixture");
    }
    expect(
      (
        await f.service.status(scope, {
          ...intent,
          storage: { ...intent.storage, manifestSha256: "c".repeat(64) },
        })
      ).state,
    ).toBe("reconciling");
  });
  it("keeps resources across revision and never restores deliberately revoked creator access", async () => {
    const f = fixture();
    await f.service.prepare(scope, intent);
    const resource = f.read()?.record.resource;
    f.actual.delete("creator-access");
    f.setIdentity(false);
    const revision = { ...intent, sourceSha: "c".repeat(40) };
    expect((await f.service.prepare(scope, revision)).state).toBe("ready");
    expect(f.read()?.record.resource).toEqual(resource);
    expect(f.calls.filter((call) => call === "creator-access")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "credentials")).toHaveLength(1);
  });
  it("updates newly approved roles only for an active creator and retains the database", async () => {
    const f = fixture();
    await f.service.prepare(scope, intent);
    const resource = f.read()?.record.resource;
    expect((await f.service.prepare(scope, { ...intent, creatorRoles: ["approver"] })).state).toBe(
      "ready",
    );
    expect(f.calls).toContain("roles:approver");
    expect(f.read()?.record.resource).toEqual(resource);
    expect(f.read()?.record.creatorRoleUpdate?.state).toBe("applied");
  });
  it("does not restore removed access when an approved revision changes roles", async () => {
    const f = fixture();
    await f.service.prepare(scope, intent);
    f.actual.delete("creator-access");
    expect((await f.service.prepare(scope, { ...intent, creatorRoles: ["approver"] })).state).toBe(
      "ready",
    );
    expect(f.calls).not.toContain("roles:approver");
    expect(f.read()?.record.creatorRoleUpdate?.state).toBe("skipped");
  });
  it("preserves an unknown write and refuses a new source intent until it settles", async () => {
    const f = fixture();
    f.interrupt();
    await expect(f.service.prepare(scope, intent)).rejects.toThrow();
    f.uncertain();
    expect((await f.service.prepare(scope, intent)).state).toBe("reconciling");
    expect((await f.service.prepare(scope, { ...intent, sourceSha: "c".repeat(40) })).state).toBe(
      "reconciling",
    );
    expect(f.calls).toEqual(["credentials", "allocate-storage"]);
  });
  it("skips storage and credentials for a frontend-only app", async () => {
    const f = fixture();
    expect((await f.service.prepare(scope, { ...intent, storage: { kind: "none" } })).state).toBe(
      "ready",
    );
    expect(f.calls).toEqual(["creator-access"]);
    expect(f.read()?.record.resource).toBeUndefined();
  });
  it("status never provisions and current owner revocation prevents all continuation", async () => {
    const f = fixture();
    await f.service.status(scope, intent);
    expect(f.calls).toEqual([]);
    f.revoke();
    await expect(f.service.prepare(scope, intent)).rejects.toThrow("not authorized");
    expect(f.calls).toEqual([]);
  });
  it("does not redirect an existing app to a different destination", async () => {
    const f = fixture();
    await f.service.prepare(scope, intent);
    await expect(f.service.prepare({ ...scope, projectId: "foreign" }, intent)).rejects.toThrow(
      "destination_changed",
    );
  });
});
