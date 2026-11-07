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
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner_fixture",
  workspaceId: "workspace_fixture",
};
const owner: NativeTargetCurrentOwner = {
  adapterGeneration: 1,
  adapterSessionId: "native_original",
  authority,
  publicSessionId: "public_original",
};
const plan = () =>
  nativeTargetOnboardingPlanSchema.parse({
    appDatabase: {
      database: "requests_data",
      migratorRole: "requests_migrator",
      resourceId: "requests-resource",
      runtimeRole: "requests_runtime",
    },
    appId: "requests-app",
    branch: "main",
    conflictPolicy: "stop-on-conflict",
    cost: { description: "Separate app target", ownership: "current-owner" },
    nativeNeon: {
      approvalReference: "native-scope-approval",
      nativeStore: {
        configurationId: "store-config",
        resourceId: "store-resource",
        sourceProjectId: "source-project",
      },
      scope: {
        branchId: "neon-branch",
        endpointId: "neon-endpoint",
        hostname: "ep-fixture.neon.tech",
        maintenanceDatabase: "maintenance",
        maintenanceRole: "installer",
        projectId: "neon-project",
      },
    },
    origin: {
      adapterGeneration: 1,
      adapterSessionId: owner.adapterSessionId,
      appSpecDigest: "a".repeat(64),
      publicSessionId: owner.publicSessionId,
      release: {
        artifactRef: "artifact-original",
        id: "release-original",
        manifestSha256: "b".repeat(64),
        schemaSha256: "c".repeat(64),
      },
    },
    productRoles: [],
    project: {
      installationId: "install_fixture",
      name: "requests-app",
      projectSettings: {
        framework: "nextjs",
        rootDirectory: "apps/requests",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
      teamId: "team_fixture",
    },
    retention: { policy: "Until approved cleanup" },
    version: 1,
    worker: {
      executablePath: "/trusted/generic-worker",
      id: "generic-installer",
      operationScope: "generated-app-release-install-v1",
      sha256: "d".repeat(64),
      subcommand: "protected-generated-app-install",
    },
  });
const attempt = (): NativeTargetOnboardingAttempt => ({
  attemptId: "b209b89b-0bad-4a60-820f-4e29d5e5a4cc",
  candidateName: "requests-app",
  leaseExpiresAt: "2026-10-21T15:10:00.000Z",
  leaseId: "b209b89b-0bad-4a60-820f-4e29d5e5a4cd",
  startedAt: time,
});
const makeFixture = (
  store: NativeTargetOnboardingStore = createInMemoryNativeTargetOnboardingStore(),
) => {
  const p = plan();
  let currentOwner = structuredClone(owner);
  let granted = true;
  let clock = new Date(time);
  let receipt: NativeTargetOnboardingApproval | null = {
    callId: "call-original",
    observedAt: time,
    outcome: "approved",
    planDigest: nativeTargetOnboardingPlanDigest(p),
    publicSessionId: owner.publicSessionId,
    requestId: "approval-original",
    responderPrincipalId: owner.authority.ownerUserId,
  };
  const authorize = vi.fn(async (_invocation: string, appId: string) => {
    if (!granted || appId !== p.appId) {
      throw new Error("not-authorized");
    }
    return structuredClone(currentOwner);
  });
  const assertPlanOrigin = vi.fn<() => Promise<void>>().mockResolvedValue();
  const readApproval = vi.fn(async () => structuredClone(receipt));
  const ports = { assertPlanOrigin, authorize, now: () => clock, readApproval, store };
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
      acceptedAt: time,
      attemptId: attempt().attemptId,
      projectId: "new-project-id",
    });
  };
  const proof = () => ({
    attemptId: attempt().attemptId,
    observed: {
      installationId: p.project.installationId,
      name: p.project.name,
      projectId: "new-project-id",
      projectSettings: p.project.projectSettings,
      protection: p.project.protection,
      teamId: p.project.teamId,
    },
    observedAt: time,
  });
  return {
    accept,
    approved,
    assertPlanOrigin,
    authorize,
    creating,
    dispatch,
    getReceipt: () => receipt,
    p,
    ports,
    proof,
    registry,
    revoke: () => {
      granted = false;
    },
    setOwner: (value: NativeTargetCurrentOwner) => {
      currentOwner = value;
    },
    setReceipt: (value: NativeTargetOnboardingApproval | null) => {
      receipt = value;
    },
    setTime: (value: string) => {
      clock = new Date(value);
    },
    store,
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
      callId: "cancel-call",
      observedAt: time,
      outcome: "cancelled",
      planDigest: nativeTargetOnboardingPlanDigest(f.p),
      publicSessionId: owner.publicSessionId,
      requestId: "cancel",
      responderPrincipalId: owner.authority.ownerUserId,
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
    f.setReceipt({ ...initial, callId: "fresh-call", requestId: "fresh-request" });
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
    f.setReceipt({ ...initial, callId: "fresh-call", requestId: "fresh-request" });
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
      [1, 2].map(
        async () =>
          await f.registry.authorizeAttempt(
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
      acceptedAt: time,
      attemptId: attempt().attemptId,
      projectId: "new-project-id",
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
      adapterGeneration: 2,
      adapterSessionId: "new-native-session",
      publicSessionId: "new-public-session",
    });
    const revised = {
      ...f.p,
      origin: {
        ...f.p.origin,
        appSpecDigest: "e".repeat(64),
        publicSessionId: "new-public-session",
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
      authorize: f.authorize,
      store: { read: f.store.read },
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
    f.setReceipt({ ...old, callId: "call-new", outcome: "approved", requestId: "approval-new" });
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
    expect(
      async () =>
        await f.store.compareAndSet({
          ...ready,
          expectedRevision: ready.revision,
          now: new Date(time),
          record: {
            appId: ready.appId,
            kind: ready.record.kind,
            plan: ready.record.plan,
            planDigest: ready.record.planDigest,
            previousAttempts: ready.record.previousAttempts,
            stage: "planned",
            version: ready.record.version,
          },
        }),
    ).toThrow();
    const planned = makeFixture();
    const row = await planned.registry.reservePlan("server-invocation", planned.p);
    const changed = { ...row.record, plan: { ...row.record.plan, branch: "another" } };
    changed.planDigest = nativeTargetOnboardingPlanDigest(changed.plan);
    expect(
      async () =>
        await planned.store.compareAndSet({
          ...row,
          expectedRevision: row.revision,
          now: new Date(time),
          record: changed,
        }),
    ).toThrow();
    expect(
      await planned.store.compareAndSet({
        ...row,
        expectedRevision: 99,
        now: new Date(time),
        record: row.record,
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
      insert: () => ({ values }),
      select: () => ({
        from: () => ({
          where: (condition: SQL) => {
            predicates.push(condition);
            return { limit: async () => (saved ? [saved] : []) };
          },
        }),
      }),
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
