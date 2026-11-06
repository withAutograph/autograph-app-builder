/* oxlint-disable eslint/no-nested-ternary, sonarjs/no-nested-conditional -- The fixture directly models unknown, applied and absent readback states. */
/* oxlint-disable promise/avoid-new -- The fixture models a real serialized lease so concurrent resumes exercise ordering. */
/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member -- Async fixture ports retain rejection semantics; assertions inspect their awaited outcomes directly. */
import { describe, expect, it } from "vitest";
import { createRepositoryProductionSetup } from "./repository-production-setup";
import type {
  RepositoryProductionSetupPorts,
  RepositoryProductionObservation,
} from "./repository-production-setup";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import { repositoryProductionOperationRef } from "./repository-production-contract";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "request-log",
  repositoryId: "repository",
  repositoryFullName: "example/apps",
  projectId: "project",
  organizationId: "organization",
  publicOrigin: "https://apps.test",
  environment: "production",
};
const intent: RepositoryProductionIntent = {
  sessionId: "session",
  sourceSha: "a".repeat(40),
  creatorRoles: ["requester"],
  storage: {
    kind: "postgres",
    releaseId: "release",
    artifactRef: "artifact",
    manifestSha256: "b".repeat(64),
    databaseEnvironment: "REQUEST_LOG_DATABASE_URL",
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
    store: {
      read: async () => (row === undefined ? undefined : structuredClone(row)),
      reserve: async (record) => {
        row ??= {
          operationRef: repositoryProductionOperationRef(record.scope),
          revision: 1,
          record: structuredClone(record),
        };
        return structuredClone(row);
      },
      compareAndSet: async (before, record) => {
        if (row?.revision !== before.revision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence is the explicit optional-store result.
          return undefined;
        }
        row = { ...before, revision: before.revision + 1, record: structuredClone(record) };
        return structuredClone(row);
      },
    },
    assertAuthorized: async () => {
      if (!authorized) {
        throw new Error("not authorized");
      }
    },
    withLease: async (_scope, run) => {
      const previous = lock;
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
    reservePrivateState: async () => {
      calls.push("credentials");
      return { sealed: "private" };
    },
    readCreatorIdentity: async () =>
      identity
        ? { state: "verified", actorId: "creator" }
        : { state: "required", signInUrl: "https://apps.test/sign-in" },
    reconcile: async ({ effect }): Promise<RepositoryProductionObservation> =>
      unknown
        ? { state: "unknown" }
        : actual.has(effect)
          ? { state: "applied", receipt: { effect } }
          : { state: "not-applied" },
    reconcileCreatorRoles: async (context) => {
      if (!actual.has("creator-access")) {
        return "skipped";
      }
      calls.push(`roles:${context.row.record.creatorRoleUpdate?.roles.join(",")}`);
      return "applied";
    },
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
  };
  return {
    service: createRepositoryProductionSetup(ports),
    calls,
    actual,
    read: () => row,
    setIdentity: (value: boolean) => {
      identity = value;
    },
    revoke: () => {
      authorized = false;
    },
    interrupt: () => {
      interrupt = true;
    },
    uncertain: () => {
      unknown = true;
    },
  };
};
describe("Builder-owned Production setup", () => {
  it("prepares persistent apps, waits only for identity, then grants access without database questions", async () => {
    const f = fixture();
    f.setIdentity(false);
    expect((await f.service.prepare(scope, intent)).state).toBe("identity-required");
    expect(f.calls).toEqual(["credentials", "allocate-storage", "install-schema"]);
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
