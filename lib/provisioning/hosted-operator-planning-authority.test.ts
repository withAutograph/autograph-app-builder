import { describe, expect, it, vi } from "vitest";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import {
  hostedRuntimeTargetSchema,
  hostedRuntimeJournalRecordSchema,
} from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import {
  compiledOperatorReleaseSelectionSchema,
  selectExactCompiledOperatorRelease,
} from "./hosted-operator-artifact-selection";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { ExactCompiledOperatorReleaseLookup } from "./hosted-operator-artifact-selection";
import type {
  ProtectedHostedOperatorDependencies,
  HostedOperatorContext,
} from "./hosted-operator-service";
import { readOwnedOperatorPlanningSelection } from "./hosted-operator-planning-authority";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = hostedRuntimeTargetSchema.parse({
  appId: "spend-review",
  branch: "feature",
  environment: "preview",
  installationId: "icfg_1",
  projectId: "prj_app",
  scopeId: "team_1",
  scopeType: "team",
  sessionId: "public-session",
});
const context = { authority, target };
const currentSpec = {
  appId: "spend-review",
  appSpecDigest: "a".repeat(64),
  sessionId: "adapter-session",
  workspaceId: "repository-execution-workspace",
};
const selected = compiledOperatorReleaseSelectionSchema.parse({
  appId: "spend-review",
  appSpecDigest: currentSpec.appSpecDigest,
  artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${"b".repeat(64)}`,
  manifestSha256: "c".repeat(64),
  releaseId: "v19",
  schemaSha256: "d".repeat(64),
  version: 1,
});
const fixture = () => {
  const session = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "adapter-session",
    appId: target.appId,
    createdAtEpochMs: 1,
    lastProgressAtEpochMs: 1,
    originAdapterSessionId: "adapter-session",
    principal: { ...authority, scopes: ["autograph:session"] },
    privateBuildDecision: {
      adapterSessionId: "adapter-session",
      currentSpec,
      decision: "blocked",
      turnId: "turn",
      turnSequence: 1,
      version: 1,
      workflowPhase: "applied",
    },
    resumability: "live",
    sessionId: "public-session",
    stage: "ready",
    status: "waiting",
    title: "Owned app",
    updatedAtEpochMs: 1,
    version: 2,
  });
  const readCurrentPlanningOwner = vi.fn(
    async () => await Promise.resolve({ session: structuredClone(session), target }),
  );
  const readGeneratedSelection = vi.fn(async () => await Promise.resolve(selected));
  return { controlPlane: { readCurrentPlanningOwner, readGeneratedSelection }, session };
};

describe("real owner-scoped planning projection", () => {
  it("reads the actual accepted digest in the canonical public artifact namespace", async () => {
    const f = fixture();
    expect(
      await readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
    ).toMatchObject({ currentSpec, selection: selected });
    expect(f.controlPlane.readGeneratedSelection).toHaveBeenCalledWith(
      context,
      currentSpec.appSpecDigest,
    );
    expect(f.controlPlane.readCurrentPlanningOwner).toHaveBeenCalledWith(context);
  });
  it.each(["appId", "sessionId"] as const)("denies a cross-scope accepted %s", async (field) => {
    const f = fixture();
    const decision = f.session.privateBuildDecision;
    if (decision?.currentSpec === undefined) {
      throw new Error("Missing fixture projection");
    }
    decision.currentSpec[field] = "foreign";
    await expect(
      readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
    ).rejects.toMatchObject({ code: "operator_unavailable" });
    expect(f.controlPlane.readGeneratedSelection).not.toHaveBeenCalled();
  });
  it("denies a canonical owner principal in another tenant workspace before reading artifacts", async () => {
    const f = fixture();
    f.session.principal.workspaceId = "other-tenant";
    await expect(
      readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
    ).rejects.toMatchObject({ code: "operator_unavailable" });
    expect(f.controlPlane.readGeneratedSelection).not.toHaveBeenCalled();
  });
  it("preserves current owner revocation before artifact access", async () => {
    const f = fixture();
    f.controlPlane.readCurrentPlanningOwner.mockRejectedValue(new Error("revoked owner"));
    await expect(
      readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
    ).rejects.toThrow("revoked owner");
    expect(f.controlPlane.readGeneratedSelection).not.toHaveBeenCalled();
  });
  it("revalidates owner authority after reading the scoped artifact", async () => {
    const f = fixture();
    f.controlPlane.readGeneratedSelection.mockImplementation(async () => {
      f.controlPlane.readCurrentPlanningOwner.mockRejectedValue(
        new Error("owner revoked during artifact lookup"),
      );
      return await Promise.resolve(selected);
    });
    await expect(
      readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
    ).rejects.toThrow("owner revoked during artifact lookup");
  });
  it("requires actual private accepted state without a latest-artifact fallback", async () => {
    const f = fixture();
    delete f.session.privateBuildDecision;
    await expect(
      readOwnedOperatorPlanningSelection({ context, controlPlane: f.controlPlane }),
    ).rejects.toThrow();
    expect(f.controlPlane.readGeneratedSelection).not.toHaveBeenCalled();
  });
  it("keeps a coherent source snapshot when ordinary accepted edits arrive during planning", async () => {
    const f = fixture();
    f.controlPlane.readGeneratedSelection.mockImplementation(async () => {
      const spec = f.session.privateBuildDecision?.currentSpec;
      if (spec === undefined) {
        throw new Error("Missing fixture projection");
      }
      spec.appSpecDigest = "e".repeat(64);
      return await Promise.resolve(selected);
    });
    const result = await readOwnedOperatorPlanningSelection({
      context,
      controlPlane: f.controlPlane,
    });
    expect(result.currentSpec.appSpecDigest).toBe(currentSpec.appSpecDigest);
    expect(result.selection).toEqual(selected);
  });
});

describe("prepared Preview release planning", () => {
  const preparedFixture = () => {
    const f = fixture();
    const published = {
      ...selected,
      publishedSource: {
        repositoryId: "approved-repository",
        branch: target.branch,
        gitSha: "e".repeat(40),
        gitTree: "f".repeat(40),
        changeSetDigest: "1".repeat(64),
        reviewDigest: "2".repeat(64),
      },
    };
    const newer = {
      ...selected,
      artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${"3".repeat(64)}`,
      releaseId: "new-private-release",
      manifestSha256: "4".repeat(64),
      schemaSha256: "5".repeat(64),
    };
    const plan = hostedOperatorPlanSchema.parse({
      access: [],
      action: "prepare",
      stage: "app",
      contextId: selected.appSpecDigest,
      appDatabase: {
        database: "app",
        migratorRole: "app_owner",
        runtimeRole: "app_runtime",
        resourceId: "app-resource",
      },
      authDatabase: {
        database: "auth",
        migratorRole: "auth_owner",
        runtimeRole: "auth_runtime",
        resourceId: "auth-resource",
      },
      cost: { class: "shared-recovery-group", description: "Approved Preview", owner: "owner" },
      delivery: {
        branch: target.branch,
        gitSha: published.publishedSource.gitSha,
        projectId: target.projectId,
        repoId: published.publishedSource.repositoryId,
      },
      effects: [
        { id: "resources", kind: "resources", description: "Observe owned resources" },
        { id: "install", kind: "install", description: "Observe prepared release" },
        { id: "access", kind: "access", description: "Observe approved access" },
        { id: "bindings", kind: "bindings", description: "Observe owned bindings" },
        { id: "delivery", kind: "delivery", description: "Observe approved publication" },
      ],
      installer: { reference: "worker", sha256: "6".repeat(64) },
      neon: {
        branchId: "br_fixture",
        connectionRef: "owned-connection",
        endpoint: "ep-fixture.neon.tech",
        projectId: "pg_fixture",
        source: "synthetic-only",
      },
      release: {
        artifactRef: published.artifactRef,
        id: published.releaseId,
        sha256: published.manifestSha256,
      },
      retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Keep the approved Preview" },
      selection: {
        appId: target.appId,
        branch: target.branch,
        environment: target.environment,
        projectId: target.projectId,
        sessionId: target.sessionId,
      },
      version: 1,
    });
    const row: HostedRuntimeJournalRow = {
      revision: 1,
      record: hostedRuntimeJournalRecordSchema.parse({
        approvedByCallId: "prepared-call",
        kind: "app-runtime",
        request: target,
        status: "prepared",
        step: "bound",
        version: 1,
        operator: {
          mode: "protected-operator-v1",
          approvalId: "prepared-approval",
          operationRef: "00000000-0000-4000-8000-000000000001",
          plan,
          planDigest: operatorPlanDigest(plan),
          receipts: [],
        },
      }),
    };
    const markers = [
      selected,
      newer,
      { ...published, publishedSource: { ...published.publishedSource, gitSha: "7".repeat(40) } },
      published,
    ];
    const read = vi.fn(async () => await Promise.resolve(structuredClone(row)));
    const readApproval = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(
      async (input) =>
        await Promise.resolve({
          action: input.action,
          approved: true,
          approvalId: "prepared-approval",
          callId: input.callId,
          planDigest: input.planDigest,
        }),
    );
    const readGeneratedSelection = vi.fn(
      async (
        _context: HostedOperatorContext,
        _digest: string,
        lookup?: ExactCompiledOperatorReleaseLookup,
      ) =>
        await Promise.resolve(
          lookup === undefined ? newer : selectExactCompiledOperatorRelease(markers, lookup),
        ),
    );
    return {
      ...f,
      markers,
      newer,
      published,
      row,
      read,
      readApproval,
      controlPlane: { ...f.controlPlane, readGeneratedSelection, store: { read }, readApproval },
    };
  };
  const restore = (f: ReturnType<typeof preparedFixture>) =>
    readOwnedOperatorPlanningSelection({
      context,
      controlPlane: f.controlPlane,
      releaseIntent: "prepared-preview",
    });

  it("selects the full published prepared release while the current capture has a different schema", async () => {
    const f = preparedFixture();
    const result = await restore(f);
    expect(result.selection).toEqual(f.published);
    expect(result.selection?.schemaSha256).not.toBe(f.newer.schemaSha256);
    expect(result.contextId).toBe(f.row.record.operator?.plan.contextId);
    expect(f.controlPlane.readGeneratedSelection).toHaveBeenCalledWith(
      context,
      selected.appSpecDigest,
      {
        appSpecDigest: selected.appSpecDigest,
        artifactRef: selected.artifactRef,
        publishedSource: {
          repositoryId: f.published.publishedSource.repositoryId,
          branch: target.branch,
          gitSha: f.published.publishedSource.gitSha,
        },
      },
    );
    await result.assertCurrent?.();
  });
  it("keeps default current-capture planning unchanged", async () => {
    const f = preparedFixture();
    const result = await readOwnedOperatorPlanningSelection({
      context,
      controlPlane: f.controlPlane,
    });
    expect(result.selection).toEqual(f.newer);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.readApproval).not.toHaveBeenCalled();
  });
  it("uses current accepted state only for owner/app binding during restoration", async () => {
    const f = preparedFixture();
    const spec = f.session.privateBuildDecision?.currentSpec;
    if (spec === undefined) {
      throw new Error("Missing accepted state");
    }
    spec.appSpecDigest = "8".repeat(64);
    const restored = await restore(f);
    expect(restored.selection).toEqual(f.published);
  });
  it.each(["repositoryId", "branch", "gitSha"] as const)(
    "denies a publication marker with a foreign %s",
    async (field) => {
      const f = preparedFixture();
      f.markers.splice(0, f.markers.length, {
        ...f.published,
        publishedSource: {
          ...f.published.publishedSource,
          [field]: field === "gitSha" ? "9".repeat(40) : "foreign",
        },
      });
      await expect(restore(f)).rejects.toMatchObject({ code: "resource_mismatch" });
    },
  );
  it("denies missing original approval and preserves current owner revocation", async () => {
    const f = preparedFixture();
    f.readApproval.mockResolvedValueOnce(null);
    await expect(restore(f)).rejects.toMatchObject({ code: "authorization_required" });
    f.controlPlane.readCurrentPlanningOwner.mockRejectedValue(new Error("revoked owner"));
    await expect(restore(f)).rejects.toThrow("revoked owner");
  });
  it("denies a foreign prepared target before artifact access", async () => {
    const f = preparedFixture();
    const operator = f.row.record.operator;
    if (operator === undefined) {
      throw new Error("Missing prepared operator");
    }
    operator.plan.selection.appId = "foreign-app";
    operator.planDigest = operatorPlanDigest(operator.plan);
    await expect(restore(f)).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.controlPlane.readGeneratedSelection).not.toHaveBeenCalled();
  });
  it("allows compatible legacy app stage and harmless journal progress metadata", async () => {
    const f = preparedFixture();
    const operator = f.row.record.operator;
    if (operator === undefined) {
      throw new Error("Missing prepared operator");
    }
    delete operator.plan.stage;
    operator.planDigest = operatorPlanDigest(operator.plan);
    const result = await restore(f);
    f.row.revision += 1;
    operator.receipts.push({
      effectId: "observed",
      observedAt: "2026-10-21T00:00:00Z",
      resourceVersion: "readback",
    });
    await expect(result.assertCurrent?.()).resolves.toBeUndefined();
  });
  it("rechecks the exact prepared journal after immutable artifact reads", async () => {
    const f = preparedFixture();
    const result = await restore(f);
    const operator = f.row.record.operator;
    if (operator === undefined) {
      throw new Error("Missing prepared operator");
    }
    operator.operationRef = "00000000-0000-4000-8000-000000000002";
    await expect(result.assertCurrent?.()).rejects.toMatchObject({ code: "operation_in_progress" });
  });
});
