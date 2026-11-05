import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryNativeTargetOnboardingStore,
  createNativeTargetOnboardingRegistry,
} from "./native-target-onboarding-store";
import type { NativeTargetCurrentOwner } from "./native-target-onboarding-store";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
} from "./native-target-onboarding-contract";
import type {
  NativeTargetOnboardingApproval,
  NativeTargetOnboardingAttempt,
  NativeTargetOnboardingPlan,
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

const invocation = "verified-owner";
const fixture = () => {
  const store = createInMemoryNativeTargetOnboardingStore();
  let current = structuredClone(owner);
  let receipt: NativeTargetOnboardingApproval | null = null;
  const assertPlanOrigin = vi.fn(
    (_owner: NativeTargetCurrentOwner, candidate: NativeTargetOnboardingPlan) => {
      if (candidate.origin.release.artifactRef !== "artifact-original") {
        throw new Error("captured-release-mismatch");
      }
      return Promise.resolve();
    },
  );
  const registry = createNativeTargetOnboardingRegistry({
    store,
    now: () => new Date(time),
    assertPlanOrigin,
    authorize: (_inv: string, appId: string) => {
      if (
        appId !== "requests-app" ||
        current.authority.ownerUserId !== owner.authority.ownerUserId
      ) {
        throw new Error("owner-denied");
      }
      return Promise.resolve(structuredClone(current));
    },
    readApproval: () => Promise.resolve(receipt),
  });
  const read = () => store.read({ authority, appId: "requests-app" });
  return {
    registry,
    store,
    read,
    assertPlanOrigin,
    setOwner: (next: NativeTargetCurrentOwner) => {
      current = next;
    },
    approve: (
      candidate: NativeTargetOnboardingPlan,
      outcome: "approved" | "cancelled" = "approved",
    ) => {
      receipt = {
        requestId: `approval-${nativeTargetOnboardingPlanDigest(candidate)}`,
        callId: "fresh-call",
        planDigest: nativeTargetOnboardingPlanDigest(candidate),
        responderPrincipalId: authority.ownerUserId,
        publicSessionId: owner.publicSessionId,
        outcome,
        observedAt: time,
      };
    },
  };
};
const rescope = (
  before: NativeTargetOnboardingPlan,
  label = "isolated-b",
): NativeTargetOnboardingPlan =>
  nativeTargetOnboardingPlanSchema.parse({
    ...before,
    resourceProfileId: label,
    resourceProfileAuthorityDigest: "e".repeat(64),
    resourceSelectionRevision: (before.resourceSelectionRevision ?? 0) + 1,
    appDatabase: { ...before.appDatabase, resourceId: `${label}-resource` },
    nativeNeon: {
      ...before.nativeNeon,
      nativeStore: { ...before.nativeNeon.nativeStore, resourceId: `${label}-store` },
      scope: {
        ...before.nativeNeon.scope,
        projectId: `${label}-project`,
        branchId: `${label}-branch`,
        endpointId: `${label}-endpoint`,
        hostname: `ep-${label}.neon.tech`,
      },
    },
  });

describe("planned native resource supersession", () => {
  it("requires fresh exact-plan approval before the new scope can claim and complete creation", async () => {
    const f = fixture();
    const original = plan();
    await f.registry.reservePlan(invocation, original);
    f.approve(original);
    const changed = rescope(original);
    const saved = await f.registry.supersedePlannedScope(
      invocation,
      changed,
      nativeTargetOnboardingPlanDigest(original),
    );
    expect(saved.record.stage).toBe("planned");
    expect(saved.record).not.toHaveProperty("approval");
    await expect(f.registry.recordApproval(invocation, original.appId)).rejects.toThrow();
    await expect(f.registry.claimAttempt(invocation, original.appId, attempt())).rejects.toThrow();
    f.approve(changed);
    await f.registry.recordApproval(invocation, original.appId);
    await f.registry.claimAttempt(invocation, original.appId, attempt());
    await f.registry.authorizeAttempt(
      invocation,
      original.appId,
      attempt().attemptId,
      attempt().leaseId,
    );
    await f.registry.acceptProjectId(invocation, original.appId, attempt().leaseId, {
      attemptId: attempt().attemptId,
      projectId: "new-project",
      acceptedAt: time,
    });
    await f.registry.recordReady(invocation, original.appId, {
      attemptId: attempt().attemptId,
      observed: {
        projectId: "new-project",
        name: changed.project.name,
        teamId: changed.project.teamId,
        installationId: changed.project.installationId,
        projectSettings: changed.project.projectSettings,
        protection: changed.project.protection,
      },
      observedAt: time,
    });
    const ready = await f.read();
    expect(ready?.record.stage).toBe("ready");
    expect(saved.record.priorPlannedScopes).toEqual([
      {
        plan: original,
        planDigest: nativeTargetOnboardingPlanDigest(original),
        supersededAt: time,
      },
    ]);
  });
  it("requires fresh approval when the same profile and database scope have changed trusted authority", async () => {
    const f = fixture();
    const selected = rescope(plan());
    await f.registry.reservePlan(invocation, selected);
    f.approve(selected);
    const changed = nativeTargetOnboardingPlanSchema.parse({
      ...selected,
      resourceProfileAuthorityDigest: "f".repeat(64),
      resourceSelectionRevision: 2,
    });
    const result = await f.registry.supersedePlannedScope(
      invocation,
      changed,
      nativeTargetOnboardingPlanDigest(selected),
    );
    expect(result.record.stage).toBe("planned");
    expect(result.record.plan.nativeNeon).toEqual(selected.nativeNeon);
    expect(result.record.plan.resourceProfileId).toBe(selected.resourceProfileId);
    expect(result.record.planDigest).not.toBe(nativeTargetOnboardingPlanDigest(selected));
    await expect(f.registry.recordApproval(invocation, selected.appId)).rejects.toThrow();
    await expect(f.registry.claimAttempt(invocation, selected.appId, attempt())).rejects.toThrow();
    f.approve(changed);
    await f.registry.recordApproval(invocation, selected.appId);
    await f.registry.claimAttempt(invocation, selected.appId, attempt());
    const current = await f.read();
    expect(current?.record.stage).toBe("creating");
    expect(current?.record.planDigest).toBe(nativeTargetOnboardingPlanDigest(changed));
  });
  it("retains cancellation audit and assigns a fresh hash when returning A to B to A", async () => {
    const f = fixture();
    const a = plan();
    await f.registry.reservePlan(invocation, a);
    f.approve(a, "cancelled");
    await f.registry.recordApproval(invocation, a.appId);
    await f.registry.reservePlan(invocation, a);
    const cancelled = await f.read();
    const prior = cancelled?.record.priorCancellations;
    const b = rescope(a);
    await f.registry.supersedePlannedScope(invocation, b, nativeTargetOnboardingPlanDigest(a));
    const back = nativeTargetOnboardingPlanSchema.parse({
      ...a,
      resourceProfileId: "original-a",
      resourceProfileAuthorityDigest: "f".repeat(64),
      resourceSelectionRevision: 2,
    });
    const result = await f.registry.supersedePlannedScope(
      invocation,
      back,
      nativeTargetOnboardingPlanDigest(b),
    );
    expect(result.record.priorCancellations).toEqual(prior);
    expect(result.record.priorPlannedScopes).toHaveLength(2);
    expect(new Set([a, b, back].map(nativeTargetOnboardingPlanDigest)).size).toBe(3);
    f.approve(a);
    await expect(f.registry.recordApproval(invocation, a.appId)).rejects.toThrow();
  });
  it.each(["approved", "creating", "unknown", "ready"] as const)(
    "refuses supersession of %s work",
    async (stage) => {
      const f = fixture();
      const a = plan();
      await f.registry.reservePlan(invocation, a);
      f.approve(a);
      await f.registry.recordApproval(invocation, a.appId);
      if (stage !== "approved") {
        await f.registry.claimAttempt(invocation, a.appId, attempt());
      }
      if (stage === "unknown") {
        await f.registry.recordUnknown(invocation, a.appId, attempt().attemptId);
      }
      if (stage === "ready") {
        await f.registry.authorizeAttempt(
          invocation,
          a.appId,
          attempt().attemptId,
          attempt().leaseId,
        );
        await f.registry.acceptProjectId(invocation, a.appId, attempt().leaseId, {
          attemptId: attempt().attemptId,
          projectId: "new-project",
          acceptedAt: time,
        });
        await f.registry.recordReady(invocation, a.appId, {
          attemptId: attempt().attemptId,
          observed: {
            projectId: "new-project",
            name: a.project.name,
            teamId: a.project.teamId,
            installationId: a.project.installationId,
            projectSettings: a.project.projectSettings,
            protection: a.project.protection,
          },
          observedAt: time,
        });
      }
      const before = await f.read();
      await expect(
        f.registry.supersedePlannedScope(
          invocation,
          rescope(a),
          nativeTargetOnboardingPlanDigest(a),
        ),
      ).rejects.toThrow();
      expect(await f.read()).toEqual(before);
    },
  );
  it.each([
    ["foreign app", (p: NativeTargetOnboardingPlan) => ({ ...p, appId: "foreign-app" })],
    [
      "project target",
      (p: NativeTargetOnboardingPlan) => ({
        ...p,
        project: { ...p.project, teamId: "other-team" },
      }),
    ],
    [
      "captured release",
      (p: NativeTargetOnboardingPlan) => ({
        ...p,
        origin: { ...p.origin, release: { ...p.origin.release, artifactRef: "other-artifact" } },
      }),
    ],
    [
      "public authority session",
      (p: NativeTargetOnboardingPlan) => ({
        ...p,
        origin: { ...p.origin, publicSessionId: "other-session" },
      }),
    ],
    [
      "physical origin",
      (p: NativeTargetOnboardingPlan) => ({
        ...p,
        origin: { ...p.origin, adapterSessionId: "stale-adapter" },
      }),
    ],
    [
      "database name",
      (p: NativeTargetOnboardingPlan) => ({
        ...p,
        appDatabase: { ...p.appDatabase, database: "other_data" },
      }),
    ],
  ] as const)("denies changed %s without writing", async (_label, mutate) => {
    const f = fixture();
    const a = plan();
    await f.registry.reservePlan(invocation, a);
    const before = await f.read();
    await expect(
      f.registry.supersedePlannedScope(
        invocation,
        mutate(rescope(a)),
        nativeTargetOnboardingPlanDigest(a),
      ),
    ).rejects.toThrow();
    expect(await f.read()).toEqual(before);
  });
  it("rejects stale digests, repeated revisions, unchanged scopes and revoked owners", async () => {
    const f = fixture();
    const a = plan();
    await f.registry.reservePlan(invocation, a);
    const b = rescope(a);
    await f.registry.supersedePlannedScope(invocation, b, nativeTargetOnboardingPlanDigest(a));
    const before = await f.read();
    await expect(
      f.registry.supersedePlannedScope(invocation, rescope(b), nativeTargetOnboardingPlanDigest(a)),
    ).rejects.toThrow();
    await expect(
      f.registry.supersedePlannedScope(
        invocation,
        { ...rescope(b), resourceSelectionRevision: 1 },
        nativeTargetOnboardingPlanDigest(b),
      ),
    ).rejects.toThrow();
    await expect(
      f.registry.supersedePlannedScope(
        invocation,
        { ...b, resourceSelectionRevision: 2 },
        nativeTargetOnboardingPlanDigest(b),
      ),
    ).rejects.toThrow();
    f.setOwner({ ...owner, authority: { ...authority, ownerUserId: "foreign-owner" } });
    await expect(
      f.registry.supersedePlannedScope(invocation, rescope(b), nativeTargetOnboardingPlanDigest(b)),
    ).rejects.toThrow();
    expect(await f.read()).toEqual(before);
  });
  it("serializes a racing scope change and approval/claim through the same durable revision CAS", async () => {
    const f = fixture();
    const a = plan();
    await f.registry.reservePlan(invocation, a);
    f.approve(a);
    const outcomes = await Promise.allSettled([
      (async () => {
        await f.registry.recordApproval(invocation, a.appId);
        await f.registry.claimAttempt(invocation, a.appId, attempt());
      })(),
      f.registry.supersedePlannedScope(invocation, rescope(a), nativeTargetOnboardingPlanDigest(a)),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const row = await f.read();
    expect(["creating", "planned"]).toContain(row?.record.stage);
  });
});

describe("retirement of rescope attempt", () => {
  it("preserves prior planned scopes after a definitive rejected creation", async () => {
    const f = fixture();
    const old = plan();
    const next = rescope(old);
    await f.registry.reservePlan(invocation, old);
    await f.registry.supersedePlannedScope(invocation, next, nativeTargetOnboardingPlanDigest(old));
    f.approve(next);
    await f.registry.recordApproval(invocation, old.appId);
    await f.registry.claimAttempt(invocation, old.appId, attempt());
    await f.registry.authorizeAttempt(
      invocation,
      old.appId,
      attempt().attemptId,
      attempt().leaseId,
    );
    const before = await f.read();
    const result = await f.registry.recordNotCreated(
      invocation,
      old.appId,
      attempt().attemptId,
      "provider_validation_failed",
    );
    expect(result.record.stage).toBe("approved");
    expect(result.record.priorPlannedScopes).toEqual(before?.record.priorPlannedScopes);
  });
});
