/* oxlint-disable typescript/no-non-null-assertion, unicorn/no-await-expression-member, eslint/require-await, eslint/no-await-in-loop -- Synthetic fixtures assert required rows and preserve sequential asynchronous approval/CAS steps. */
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  createInMemoryNativeTargetOnboardingStore,
  createNativeTargetOnboardingRegistry,
  createNativeTargetOnboardingReader,
  createPostgresNativeTargetOnboardingStore,
} from "./native-target-onboarding-store";
import type {
  NativeTargetCurrentOwner,
  NativeTargetOnboardingStore,
} from "./native-target-onboarding-store";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
} from "./native-target-onboarding-contract";
import type {
  NativeTargetOnboardingApproval,
  NativeTargetOnboardingAttempt,
  NativeTargetOnboardingRecord,
} from "./native-target-onboarding-contract";

const time = "2026-10-21T15:00:00.000Z";
const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace_fixture",
  ownerUserId: "owner_fixture",
};
const owner: NativeTargetCurrentOwner = {
  authority,
  publicSessionId: "public_original",
  adapterSessionId: "native_original",
  adapterGeneration: 1,
};
const plan = () =>
  nativeTargetOnboardingPlanSchema.parse({
    version: 1,
    appId: "requests-app",
    origin: {
      publicSessionId: owner.publicSessionId,
      adapterSessionId: owner.adapterSessionId,
      adapterGeneration: 1,
      appSpecDigest: "a".repeat(64),
      release: {
        id: "release-original",
        artifactRef: "artifact-original",
        manifestSha256: "b".repeat(64),
        schemaSha256: "c".repeat(64),
      },
    },
    project: {
      name: "requests-app",
      teamId: "team_fixture",
      installationId: "install_fixture",
      projectSettings: {
        framework: "nextjs",
        rootDirectory: "apps/requests",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
    },
    branch: "main",
    appDatabase: {
      resourceId: "requests-resource",
      database: "requests_data",
      migratorRole: "requests_migrator",
      runtimeRole: "requests_runtime",
    },
    productRoles: [],
    nativeNeon: {
      approvalReference: "native-scope-approval",
      nativeStore: {
        configurationId: "store-config",
        resourceId: "store-resource",
        sourceProjectId: "source-project",
      },
      scope: {
        projectId: "neon-project",
        branchId: "neon-branch",
        endpointId: "neon-endpoint",
        hostname: "ep-fixture.neon.tech",
        maintenanceDatabase: "maintenance",
        maintenanceRole: "installer",
      },
    },
    worker: {
      id: "generic-installer",
      executablePath: "/trusted/generic-worker",
      sha256: "d".repeat(64),
      operationScope: "generated-app-release-install-v1",
      subcommand: "protected-generated-app-install",
    },
    cost: { ownership: "current-owner", description: "Separate app target" },
    retention: { policy: "Until approved cleanup" },
    conflictPolicy: "stop-on-conflict",
  });
const attempt = (): NativeTargetOnboardingAttempt => ({
  attemptId: "b209b89b-0bad-4a60-820f-4e29d5e5a4cc",
  candidateName: "requests-app",
  leaseId: "b209b89b-0bad-4a60-820f-4e29d5e5a4cd",
  startedAt: time,
  leaseExpiresAt: "2026-10-21T15:10:00.000Z",
});
const makeFixture = (
  store: NativeTargetOnboardingStore = createInMemoryNativeTargetOnboardingStore(),
) => {
  const p = plan();
  let currentOwner = structuredClone(owner);
  let granted = true;
  let clock = new Date(time);
  let receipt: NativeTargetOnboardingApproval | null = {
    requestId: "approval-original",
    callId: "call-original",
    planDigest: nativeTargetOnboardingPlanDigest(p),
    responderPrincipalId: owner.authority.ownerUserId,
    publicSessionId: owner.publicSessionId,
    outcome: "approved",
    observedAt: time,
  };
  const authorize = vi.fn(async (_invocation: string, appId: string) => {
    if (!granted || appId !== p.appId) {
      throw new Error("not-authorized");
    }
    return structuredClone(currentOwner);
  });
  const assertPlanOrigin = vi.fn(async () => {});
  const readApproval = vi.fn(async () => structuredClone(receipt));
  const ports = { store, authorize, assertPlanOrigin, readApproval, now: () => clock };
  const registry = createNativeTargetOnboardingRegistry(ports);
  const approved = async () => {
    await registry.reservePlan("server-invocation", p);
    await registry.recordApproval("server-invocation", p.appId);
  };
  const creating = async () => {
    await approved();
    await registry.claimAttempt("server-invocation", p.appId, attempt());
  };
  const dispatch = async () => {
    await creating();
    await registry.authorizeAttempt(
      "server-invocation",
      p.appId,
      attempt().attemptId,
      attempt().leaseId,
    );
  };
  const accept = async () => {
    await dispatch();
    await registry.acceptProjectId("server-invocation", p.appId, attempt().leaseId, {
      attemptId: attempt().attemptId,
      projectId: "new-project-id",
      acceptedAt: time,
    });
  };
  const proof = () => ({
    attemptId: attempt().attemptId,
    observed: {
      projectId: "new-project-id",
      name: p.project.name,
      teamId: p.project.teamId,
      installationId: p.project.installationId,
      projectSettings: p.project.projectSettings,
      protection: p.project.protection,
    },
    observedAt: time,
  });
  return {
    p,
    store,
    registry,
    ports,
    authorize,
    assertPlanOrigin,
    approved,
    creating,
    dispatch,
    accept,
    proof,
    setOwner: (value: NativeTargetCurrentOwner) => {
      currentOwner = value;
    },
    revoke: () => {
      granted = false;
    },
    setReceipt: (value: NativeTargetOnboardingApproval | null) => {
      receipt = value;
    },
    getReceipt: () => receipt,
    setTime: (value: string) => {
      clock = new Date(value);
    },
  };
};

describe("native target registry authorization and restart", () => {
  it("reserves once under canonical authority and never trusts invocation owner text", async () => {
    const f = makeFixture();
    const first = await f.registry.reservePlan("untrusted-owner-text", f.p);
    const second = await f.registry.reservePlan("server-invocation", f.p);
    expect(first.requestId).toBe(second.requestId);
    expect(first.authority).toEqual(authority);
    const leaked = await f.registry.read("server-invocation", f.p.appId);
    leaked!.record.plan.productRoles.push("forged");
    expect(
      (await f.registry.read("server-invocation", f.p.appId))!.record.plan.productRoles,
    ).toEqual([]);
    f.setOwner({ ...owner, authority: { ...authority, ownerUserId: "another-owner" } });
    expect(await f.registry.read("server-invocation", f.p.appId)).toBeUndefined();
    f.revoke();
    await expect(f.registry.readReady("server-invocation", f.p.appId)).rejects.toThrow(
      "not-authorized",
    );
  });
  it("requires original source provenance only when reserving the initial plan", async () => {
    const f = makeFixture();
    await expect(
      f.registry.reservePlan("server-invocation", {
        ...f.p,
        origin: { ...f.p.origin, publicSessionId: "foreign" },
      }),
    ).rejects.toThrow();
    expect(await f.registry.read("server-invocation", f.p.appId)).toBeUndefined();
    expect(f.assertPlanOrigin).not.toHaveBeenCalled();
  });
  it("does not dispatch without terminal approval or after denial/cancellation", async () => {
    const f = makeFixture();
    await f.registry.reservePlan("server-invocation", f.p);
    await expect(
      f.registry.claimAttempt("server-invocation", f.p.appId, attempt()),
    ).rejects.toThrow();
    f.setReceipt(null);
    await expect(f.registry.recordApproval("server-invocation", f.p.appId)).rejects.toThrow();
    f.setReceipt({
      ...f.getReceipt()!,
      requestId: "cancel",
      callId: "cancel-call",
      planDigest: nativeTargetOnboardingPlanDigest(f.p),
      responderPrincipalId: owner.authority.ownerUserId,
      publicSessionId: owner.publicSessionId,
      outcome: "cancelled",
      observedAt: time,
    });
    expect((await f.registry.recordApproval("server-invocation", f.p.appId)).record.stage).toBe(
      "cancelled",
    );
    await expect(
      f.registry.claimAttempt("server-invocation", f.p.appId, attempt()),
    ).rejects.toThrow();
  });
  it("rejects mismatched approval owner, session, digest or request identity", async () => {
    for (const change of [
      { responderPrincipalId: "another-owner" },
      { publicSessionId: "foreign" },
      { planDigest: "f".repeat(64) },
    ]) {
      const f = makeFixture();
      await f.registry.reservePlan("server-invocation", f.p);
      f.setReceipt({ ...f.getReceipt()!, ...change });
      await expect(f.registry.recordApproval("server-invocation", f.p.appId)).rejects.toThrow();
    }
    const f = makeFixture();
    await f.approved();
    f.setReceipt({ ...f.getReceipt()!, requestId: "different-approval" });
    await expect(
      f.registry.claimAttempt("server-invocation", f.p.appId, attempt()),
    ).rejects.toThrow();
  });
  it("keeps initial plan approval immutable while freshly authorizing another invocation", async () => {
    const f = makeFixture();
    await f.approved();
    const before = await f.registry.read("server-invocation", f.p.appId);
    const initial = f.getReceipt()!;
    f.setReceipt({ ...initial, requestId: "fresh-request", callId: "fresh-call" });
    const checked = await f.registry.recordApproval("server-invocation", f.p.appId);
    expect(checked).toEqual(before);
    expect(checked.record).toMatchObject({ approval: initial });
    await f.registry.claimAttempt("server-invocation", f.p.appId, attempt());
    f.setReceipt(null);
    await expect(
      f.registry.authorizeAttempt(
        "server-invocation",
        f.p.appId,
        attempt().attemptId,
        attempt().leaseId,
      ),
    ).rejects.toThrow();
    f.setReceipt({ ...initial, requestId: "fresh-request", callId: "fresh-call" });
    await f.registry.authorizeAttempt(
      "server-invocation",
      f.p.appId,
      attempt().attemptId,
      attempt().leaseId,
    );
    const current = await f.registry.read("server-invocation", f.p.appId);
    expect(current?.record).toMatchObject({ approval: initial });
  });
  it("allows only one durable POST authorization and checks the live exact lease", async () => {
    const f = makeFixture();
    await f.creating();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        f.registry.authorizeAttempt(
          "server-invocation",
          f.p.appId,
          attempt().attemptId,
          attempt().leaseId,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const expired = makeFixture();
    await expired.creating();
    expired.setTime("2026-10-21T15:11:00.000Z");
    await expect(
      expired.registry.authorizeAttempt(
        "server-invocation",
        expired.p.appId,
        attempt().attemptId,
        attempt().leaseId,
      ),
    ).rejects.toThrow();
    const wrong = makeFixture();
    await wrong.creating();
    await expect(
      wrong.registry.authorizeAttempt(
        "server-invocation",
        wrong.p.appId,
        attempt().attemptId,
        "foreign-lease",
      ),
    ).rejects.toThrow();
  });
  it("keeps unknown POST outcomes blocked across restart and cannot adopt a matching project GET", async () => {
    const f = makeFixture();
    await f.dispatch();
    await f.registry.recordUnknown("server-invocation", f.p.appId, attempt().attemptId);
    const restarted = createNativeTargetOnboardingRegistry(f.ports);
    await expect(
      restarted.claimAttempt("server-invocation", f.p.appId, {
        ...attempt(),
        attemptId: "b209b89b-0bad-4a60-820f-4e29d5e5a4ce",
      }),
    ).rejects.toThrow();
    await expect(
      restarted.authorizeAttempt(
        "server-invocation",
        f.p.appId,
        attempt().attemptId,
        attempt().leaseId,
      ),
    ).rejects.toThrow();
    await expect(
      restarted.recordReady("server-invocation", f.p.appId, f.proof()),
    ).rejects.toThrow();
    expect(await restarted.readReady("server-invocation", f.p.appId)).toBeUndefined();
  });
  it("retains acknowledged creation before GET and reconciles exactly that project after restart", async () => {
    const f = makeFixture();
    await f.accept();
    await f.registry.recordUnknown("server-invocation", f.p.appId, attempt().attemptId);
    const restarted = createNativeTargetOnboardingRegistry(f.ports);
    const wrong = f.proof();
    wrong.observed.projectId = "old-project";
    await expect(restarted.recordReady("server-invocation", f.p.appId, wrong)).rejects.toThrow();
    expect(
      (await restarted.recordReady("server-invocation", f.p.appId, f.proof())).record.stage,
    ).toBe("ready");
    expect(
      (await restarted.readReady("server-invocation", f.p.appId))?.registration.observed.projectId,
    ).toBe("new-project-id");
  });
  it("records a real2xx after cancellation but never treats it as permission to finish registration", async () => {
    const f = makeFixture();
    await f.dispatch();
    f.setReceipt({ ...f.getReceipt()!, outcome: "cancelled" });
    await f.registry.recordApproval("server-invocation", f.p.appId);
    await f.registry.acceptProjectId("server-invocation", f.p.appId, attempt().leaseId, {
      attemptId: attempt().attemptId,
      projectId: "new-project-id",
      acceptedAt: time,
    });
    expect((await f.registry.read("server-invocation", f.p.appId))?.record.stage).toBe("unknown");
    await expect(
      f.registry.recordReady("server-invocation", f.p.appId, f.proof()),
    ).rejects.toThrow();
    await expect(
      f.registry.recordNotCreated(
        "server-invocation",
        f.p.appId,
        attempt().attemptId,
        "provider_validation_failed",
      ),
    ).rejects.toThrow();
  });
  it("preserves ready targets for ordinary later source/release/session changes", async () => {
    const f = makeFixture();
    await f.accept();
    await f.registry.recordReady("server-invocation", f.p.appId, f.proof());
    f.setOwner({
      ...owner,
      publicSessionId: "new-public-session",
      adapterSessionId: "new-native-session",
      adapterGeneration: 2,
    });
    const revised = {
      ...f.p,
      origin: {
        ...f.p.origin,
        publicSessionId: "new-public-session",
        appSpecDigest: "e".repeat(64),
        release: { ...f.p.origin.release, id: "new-release" },
      },
      project: {
        ...f.p.project,
        projectSettings: { ...f.p.project.projectSettings, rootDirectory: "apps/renamed" },
      },
    };
    expect((await f.registry.reservePlan("server-invocation", revised)).record.stage).toBe("ready");
    expect((await f.registry.readReady("server-invocation", f.p.appId))?.plan.origin).toEqual(
      f.p.origin,
    );
    expect(f.assertPlanOrigin).toHaveBeenCalledTimes(1);
  });
  it("retains definitive failed-attempt provenance and permits another approved attempt without a quota", async () => {
    const f = makeFixture();
    await f.dispatch();
    await f.registry.recordNotCreated(
      "server-invocation",
      f.p.appId,
      attempt().attemptId,
      "provider_validation_failed",
    );
    const row = await f.registry.read("server-invocation", f.p.appId);
    expect(row?.record.previousAttempts).toEqual([
      { ...attempt(), reason: "provider_validation_failed" },
    ]);
    await expect(
      f.registry.claimAttempt("server-invocation", f.p.appId, attempt()),
    ).rejects.toThrow();
    expect(
      (
        await f.registry.claimAttempt("server-invocation", f.p.appId, {
          ...attempt(),
          attemptId: "b209b89b-0bad-4a60-820f-4e29d5e5a4ce",
        })
      ).record.stage,
    ).toBe("creating");
  });
  it("only advances conflict-policy names after a definite409 and keeps technical retries on the same name", async () => {
    for (const reason of [
      "name_conflict",
      "provider_rate_limited",
      "provider_permission_denied",
      "provider_validation_failed",
    ] as const) {
      const f = makeFixture();
      f.p.conflictPolicy = "suffix-on-confirmed-conflict";
      f.setReceipt({ ...f.getReceipt()!, planDigest: nativeTargetOnboardingPlanDigest(f.p) });
      await f.dispatch();
      await f.registry.recordNotCreated(
        "server-invocation",
        f.p.appId,
        attempt().attemptId,
        reason,
      );
      const next = {
        ...attempt(),
        attemptId: "b209b89b-0bad-4a60-820f-4e29d5e5a4ce",
        candidateName: "requests-app-abcdef",
      };
      if (reason === "name_conflict") {
        expect(
          (await f.registry.claimAttempt("server-invocation", f.p.appId, next)).record.stage,
        ).toBe("creating");
      } else {
        await expect(
          f.registry.claimAttempt("server-invocation", f.p.appId, next),
        ).rejects.toThrow();
        expect(
          (
            await f.registry.claimAttempt("server-invocation", f.p.appId, {
              ...next,
              candidateName: attempt().candidateName,
            })
          ).record.stage,
        ).toBe("creating");
      }
    }
  });
  it("authorizes read-only consumers without approval or source mutation ports", async () => {
    const f = makeFixture();
    await f.accept();
    await f.registry.recordReady("server-invocation", f.p.appId, f.proof());
    const reader = createNativeTargetOnboardingReader({
      store: { read: f.store.read },
      authorize: f.authorize,
    });
    expect(
      (await reader.readReady("server-invocation", f.p.appId))?.registration.observed.projectId,
    ).toBe("new-project-id");
    f.revoke();
    await expect(reader.read("server-invocation", f.p.appId)).rejects.toThrow("not-authorized");
  });
  it("replans an undispatched cancellation while retaining provenance and requiring a new native approval", async () => {
    const f = makeFixture();
    await f.registry.reservePlan("server-invocation", f.p);
    const old = { ...f.getReceipt()!, outcome: "cancelled" as const };
    f.setReceipt(old);
    await f.registry.recordApproval("server-invocation", f.p.appId);
    const replanned = await f.registry.reservePlan("server-invocation", f.p);
    expect(replanned.record.stage).toBe("planned");
    expect(replanned.record.priorCancellations?.[0]?.approval).toEqual(old);
    f.setReceipt({ ...old, outcome: "approved" });
    await expect(f.registry.recordApproval("server-invocation", f.p.appId)).rejects.toThrow();
    f.setReceipt({ ...old, outcome: "approved", requestId: "approval-new", callId: "call-new" });
    expect((await f.registry.recordApproval("server-invocation", f.p.appId)).record.stage).toBe(
      "approved",
    );
    expect(
      (await f.registry.claimAttempt("server-invocation", f.p.appId, attempt())).record.stage,
    ).toBe("creating");
  });
  it("releases a claimed but undispatched cancellation and never resets a dispatched target", async () => {
    const f = makeFixture();
    await f.creating();
    f.setReceipt({ ...f.getReceipt()!, outcome: "cancelled" });
    const cancelled = await f.registry.recordApproval("server-invocation", f.p.appId);
    expect(cancelled.record.stage).toBe("cancelled");
    expect(cancelled.record.previousAttempts[0]?.reason).toBe("not_dispatched");
    expect((await f.registry.reservePlan("server-invocation", f.p)).record.stage).toBe("planned");
    const dispatched = makeFixture();
    await dispatched.dispatch();
    await dispatched.registry.recordNotCreated(
      "server-invocation",
      dispatched.p.appId,
      attempt().attemptId,
      "provider_validation_failed",
    );
    dispatched.setReceipt({ ...dispatched.getReceipt()!, outcome: "cancelled" });
    await dispatched.registry.recordApproval("server-invocation", dispatched.p.appId);
    await expect(
      dispatched.registry.reservePlan("server-invocation", dispatched.p),
    ).rejects.toThrow();
    const unknown = makeFixture();
    await unknown.dispatch();
    unknown.setReceipt({ ...unknown.getReceipt()!, outcome: "cancelled" });
    await unknown.registry.recordApproval("server-invocation", unknown.p.appId);
    expect((await unknown.registry.reservePlan("server-invocation", unknown.p)).record.stage).toBe(
      "unknown",
    );
  });
  it("cannot overwrite READY or change frozen plan through a direct trusted CAS adapter", async () => {
    const f = makeFixture();
    await f.accept();
    const ready = await f.registry.recordReady("server-invocation", f.p.appId, f.proof());
    expect(() =>
      f.store.compareAndSet({
        ...ready,
        expectedRevision: ready.revision,
        record: {
          kind: ready.record.kind,
          version: ready.record.version,
          appId: ready.appId,
          plan: ready.record.plan,
          planDigest: ready.record.planDigest,
          stage: "planned",
          previousAttempts: ready.record.previousAttempts,
        },
        now: new Date(time),
      }),
    ).toThrow();
    const planned = makeFixture();
    const row = await planned.registry.reservePlan("server-invocation", planned.p);
    const changed = { ...row.record, plan: { ...row.record.plan, branch: "another" } };
    changed.planDigest = nativeTargetOnboardingPlanDigest(changed.plan);
    expect(() =>
      planned.store.compareAndSet({
        ...row,
        expectedRevision: row.revision,
        record: changed,
        now: new Date(time),
      }),
    ).toThrow();
    expect(
      await planned.store.compareAndSet({
        ...row,
        expectedRevision: 99,
        record: row.record,
        now: new Date(time),
      }),
    ).toBeUndefined();
  });
});

describe("Postgres native target journal adapter", () => {
  it("maps only pending/settled and retains tenant, app-slot, kind and revision predicates", async () => {
    type StoredValues = typeof authority & {
      requestId: string;
      requestDigest: string;
      record: NativeTargetOnboardingRecord;
      revision: number;
      state: string;
      createdAt: Date;
      updatedAt: Date;
    };
    let saved: StoredValues | undefined;
    const predicates: SQL[] = [];
    const values = vi.fn((value: StoredValues) => {
      saved = value;
      return { onConflictDoNothing: () => ({ returning: async () => [saved] }) };
    });
    const database = {
      select: () => ({
        from: () => ({
          where: (condition: SQL) => {
            predicates.push(condition);
            return { limit: async () => (saved ? [saved] : []) };
          },
        }),
      }),
      insert: () => ({ values }),
      update: () => ({
        set: (update: Partial<StoredValues>) => ({
          where: (condition: SQL) => {
            predicates.push(condition);
            if (saved === undefined) {
              throw new Error("missing-row");
            }
            saved = { ...saved, ...update };
            return { returning: async () => [saved] };
          },
        }),
      }),
    };
    // SAFETY: The synthetic adapter implements every called builder method, records actual SQL predicates,
    // and returns contract-validated journal rows. It never executes SQL or exposes this cast to production.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The bounded synthetic adapter implements these tested database methods.
    const store = createPostgresNativeTargetOnboardingStore(
      // SAFETY: This test adapter returns validated rows and records SQL rather than connecting to PostgreSQL.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Only the three exercised builders are synthetic.
      database as unknown as Parameters<typeof createPostgresNativeTargetOnboardingStore>[0],
    );
    const f = makeFixture(store);
    await f.accept();
    await f.registry.recordReady("server-invocation", f.p.appId, f.proof());
    expect(saved?.state).toBe("settled");
    expect(values.mock.calls[0]?.[0].state).toBe("pending");
    const query = new PgDialect().sqlToQuery(predicates.at(-1)!);
    expect(query.params).toEqual(
      expect.arrayContaining([
        authority.issuer,
        authority.audience,
        authority.workspaceId,
        authority.ownerUserId,
      ]),
    );
    expect(query.sql).toContain("native-target-onboarding");
    expect(query.sql).toContain('"revision"');
    expect(
      (await f.registry.readReady("server-invocation", f.p.appId))?.plan.appDatabase.database,
    ).toBe("requests_data");
  });
});
