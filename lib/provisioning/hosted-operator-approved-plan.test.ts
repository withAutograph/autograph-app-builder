import { describe, expect, it, vi } from "vitest";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  HostedOperatorError,
} from "./hosted-operator-contract";
import type { OperatorSelection } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import { recoverOriginalApprovedPlan } from "./hosted-operator-approved-plan";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection: OperatorSelection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview",
  projectId: "prj_fixture",
  sessionId: "session_fixture",
};
const ownerContext = {
  adapterGeneration: 1,
  adapterSessionId: "adapter-session",
  authority,
  kind: "direct" as const,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: selection.sessionId,
};
const target = {
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
};
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "synthetic-reviewer", organizationId: "synthetic-org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "shared_auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "shared_auth_runtime",
  },
  contextId: "synthetic-context",
  cost: {
    class: "shared-recovery-group",
    description: "Approved disposable compute",
    owner: "Fixture owner",
  },
  deploymentBoundary: {
    app: {
      branch: selection.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: selection.projectId,
    },
    authority,
    gateway: {
      branch: selection.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: {
      deploymentId: "dpl_operator",
      environment: "production",
      projectId: "prj_operator",
    },
    teamId: "team_fixture",
    verification: {
      gatewayOrigin: "https://gateway-preview.example.test",
      jwksUrl: "https://gateway-preview.example.test/_platform/jwks.json",
      publicOrigin: "https://apps-preview.example.test",
    },
  },
  effects: [
    {
      description: "Verify selected resources and their roles",
      id: "resources",
      kind: "resources",
    },

    { description: "Install the selected checked release", id: "install", kind: "install" },
    { description: "Grant approved Auth app access after install", id: "access", kind: "access" },
    {
      description: "Bind restricted app and shared Auth credentials",
      id: "bind",
      kind: "bindings",
    },
  ],
  installer: { reference: "trusted-toolchain", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_synthetic",
    connectionRef: "explicit-owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "synthetic-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: "prj_gateway",
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});

const original = {
  operationRef: "f58de890-c49f-4e5c-86d2-03d2d44166b9",
  plan,
  planDigest: operatorPlanDigest(plan),
};
const replacementPlan = {
  ...plan,
  retention: { ...plan.retention, expiresAt: "2099-12-31T23:59:59Z" },
};
const setup = () => {
  let row: HostedRuntimeJournalRow = {
    revision: 802,
    record: hostedRuntimeJournalRecordSchema.parse({
      version: 1,
      kind: "app-runtime",
      request: target,
      status: "pending",
      step: "reserved",
      approvedByCallId: "operator:unapproved-plan",
      privateState: {
        encryptedToken: "ciphertext",
        keyVersion: "key-v1",
        tokenIv: "iv",
        tokenTag: "tag",
      },
      operator: {
        mode: "protected-operator-v1",
        operationRef: "fcc825bc-d683-422c-8b58-0d0a065ceb57",
        plan: replacementPlan,
        planDigest: operatorPlanDigest(replacementPlan),
        receipts: [],
        fenceGeneration: 7,
      },
    }),
  };
  const readApprovedPlan = vi.fn(async () => await Promise.resolve(original));
  const read = vi.fn(async () => await Promise.resolve(structuredClone(row)));
  const compareAndSet = vi.fn<HostedRuntimeJournalStore["compareAndSet"]>(async (input) => {
    if (input.expectedRevision !== row.revision) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS contention explicitly has no saved row.
      return await Promise.resolve<HostedRuntimeJournalRow | undefined>(undefined);
    }
    row = {
      record: hostedRuntimeJournalRecordSchema.parse(input.record),
      revision: row.revision + 1,
    };
    return await Promise.resolve(structuredClone(row));
  });
  const assertAuthorized = vi.fn(async () => {
    await Promise.resolve();
  });
  const run = async (proposed = replacementPlan) =>
    await recoverOriginalApprovedPlan(
      { store: { read, compareAndSet }, readApprovedPlan, assertAuthorized },
      { authority, target, ownerContext },
      { action: "plan", operation: "prepare", selection },
      selection.appId,
      proposed,
      () => Date.parse("2026-10-14T21:06:00Z"),
    );
  const operator = () => {
    const current = row.record.operator;
    if (current === undefined) {
      throw new Error("Fixture operator missing");
    }
    return current;
  };
  return {
    run,
    get row() {
      return row;
    },
    operator,
    readApprovedPlan,
    compareAndSet,
    assertAuthorized,
  };
};
describe("original approved plan recovery", () => {
  it("restores original operation and expiry, preserving actual parsed encrypted state and fence", async () => {
    const f = setup();
    const privateState = structuredClone(f.row.record.privateState);
    expect(await f.run()).toMatchObject({ ...original, status: "planned" });
    expect(f.operator()).toMatchObject({ ...original, fenceGeneration: 7, receipts: [] });
    expect(f.row.record.privateState).toEqual(privateState);
    const { revision } = f.row;
    expect(await f.run()).toMatchObject(original);
    expect(f.row.revision).toBe(revision);
  });
  it("preserves the actual absence of a fence rather than inventing a generation", async () => {
    const f = setup();
    delete f.operator().fenceGeneration;
    await f.run();
    expect(f.operator().fenceGeneration).toBeUndefined();
  });
  it.each(["lease", "pending", "receipt", "approved-call"])(
    "denies recovery over %s",
    async (kind) => {
      const f = setup();
      if (kind === "lease") {
        f.row.record.leaseId = "lease";
      }
      if (kind === "pending") {
        f.operator().pendingEffectId = "resources";
      }
      if (kind === "receipt") {
        f.operator().receipts.push({
          effectId: "resources",
          observedAt: "2026-10-14T00:00:00Z",
          resourceVersion: "v1",
          fenceGeneration: 7,
        });
      }
      if (kind === "approved-call") {
        f.row.record.approvedByCallId = "actual-call";
      }
      await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
      expect(f.compareAndSet).not.toHaveBeenCalled();
    },
  );
  it("denies changed scope and expired authority supplied by a faulty selection port", async () => {
    const f = setup();
    await expect(f.run({ ...replacementPlan, contextId: "changed" })).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    const expired = {
      ...plan,
      retention: { ...plan.retention, expiresAt: "2026-10-14T00:00:00Z" },
    };
    f.readApprovedPlan.mockResolvedValue({
      ...original,
      plan: expired,
      planDigest: operatorPlanDigest(expired),
    });
    await expect(f.run()).rejects.toMatchObject({ code: "authorization_required" });
  });
  it("rechecks current approval after CAS contention and retains concurrent approved replacement", async () => {
    const f = setup();
    f.compareAndSet.mockImplementationOnce(async () => {
      await Promise.resolve();
    });
    f.readApprovedPlan
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new HostedOperatorError("operation_in_progress"));
    await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(f.readApprovedPlan).toHaveBeenCalledTimes(2);
    expect(f.operator().operationRef).toBe("fcc825bc-d683-422c-8b58-0d0a065ceb57");
  });
});
