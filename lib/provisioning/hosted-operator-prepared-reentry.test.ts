/* oxlint-disable eslint/require-await, eslint/no-await-in-loop -- Synthetic asynchronous ports keep this regression inside the actual service lease and journal flow. */
import { describe, expect, it, vi } from "vitest";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPublicResultSchema,
} from "./hosted-operator-contract";
import type { OperatorRequest, OperatorSelection } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import { requireFinalResourceBindingPhase } from "./hosted-operator-resource-binding-phase";

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
const proof = {
  actors: 2,
  artifactHash: "c".repeat(64),
  authenticatedBehavior: "unassessed" as const,
  manifestSha256: plan.release.sha256,
  releaseId: plan.release.id,
  tenants: 2,
};

const fixture = () => {
  let row: HostedRuntimeJournalRow | undefined;
  let authorized = true;
  let approved = true;
  const gatewayPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    effects: [
      ...plan.effects,
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Bind shared Gateway" },
    ],
    gatewayBindings: {
      authBrowserOrigin: "https://auth-preview.example.test",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [selection.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload: {
        audience: "https://vercel.com",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team_fixture",
        ownerId: target.scopeId,
        projectId: "prj_gateway",
        subject: "fixture-gateway",
      },
    },
  });
  const applied = new Map<
    string,
    {
      effectId: string;
      fenceGeneration: number;
      observedAt: string;
      resourceVersion: string;
    }
  >();
  const store: HostedRuntimeJournalStore = {
    async read() {
      return row ? structuredClone(row) : undefined;
    },
    async reserve(input) {
      row ??= {
        revision: 1,
        record: hostedRuntimeJournalRecordSchema.parse({
          version: 1,
          kind: "app-runtime",
          approvedByCallId: input.approvedByCallId,
          request: input.target,
          operator: input.operator,
          status: "pending",
          step: "reserved",
        }),
      };
      return structuredClone(row);
    },
    async compareAndSet(input) {
      const matches = row?.revision === input.expectedRevision;
      if (matches) {
        row = {
          revision: input.expectedRevision + 1,
          record: hostedRuntimeJournalRecordSchema.parse(input.record),
        };
      }
      return matches ? structuredClone(row) : undefined;
    },
    async reserveFenceGeneration(input) {
      const current = row;
      const matches =
        current !== undefined &&
        current.record.leaseId === input.leaseId &&
        current.revision === input.expectedRevision;
      if (matches) {
        row = {
          revision: current.revision + 1,
          record: hostedRuntimeJournalRecordSchema.parse({
            ...current.record,
            operator: { ...current.record.operator, fenceGeneration: 1 },
          }),
        };
      }
      return matches ? structuredClone(row) : undefined;
    },
  };
  const observedRows: HostedRuntimeJournalRow[] = [];
  const deps: ProtectedHostedOperatorDependencies = {
    store,
    authorize: async () => ({ authority, target, ownerContext }),
    assertAuthorized: async () => {
      if (!authorized) {
        throw new HostedOperatorError("authorization_required");
      }
    },
    plan: async () => gatewayPlan,
    readApproval: async (input) =>
      approved
        ? {
            action: input.action,
            approvalId: "fixture-approval",
            approved: true,
            callId: input.callId,
            planDigest: input.planDigest,
          }
        : null,
    bindings: async () => ({}),
    withResourceLease: async (_input, run) => await run(async () => {}),
    reconcile: vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(async (input) => {
      const receipt = applied.get(input.effect.id);
      return receipt ? { status: "applied", receipt } : { status: "absent" };
    }),
    executeEffect: vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(async (input) => {
      await input.assertCurrent();
      await input.checkpoint({
        encryptedToken: "fixture-ciphertext",
        keyVersion: "fixture-key",
        tokenIv: "fixture-iv",
        tokenTag: "fixture-tag",
      });
      const receipt = {
        effectId: input.effect.id,
        fenceGeneration: input.fenceGeneration,
        observedAt: new Date().toISOString(),
        resourceVersion: "fixture-owned-resource",
      };
      applied.set(input.effect.id, receipt);
      return receipt;
    }),
    verify: vi.fn<ProtectedHostedOperatorDependencies["verify"]>(async (input) => {
      const current = await store.read(input);
      if (current !== undefined) {
        observedRows.push(current);
      }
      requireFinalResourceBindingPhase(current, input);
      return proof;
    }),
  };
  const handler = createProtectedHostedOperatorHandler(deps);
  const request = async (input: OperatorRequest) => {
    const response = await handler(
      new Request("https://operator.example/v1/runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    return operatorPublicResultSchema.parse(await response.json());
  };
  return {
    deps,
    observedRows,
    request,
    revokeOwner: () => {
      authorized = false;
    },
    revokeApproval: () => {
      approved = false;
    },
    get row() {
      return row;
    },
  };
};

const prepareOnce = async (f: ReturnType<typeof fixture>) => {
  const planned = await f.request({ action: "plan", operation: "prepare", selection });
  const execute = {
    action: "execute" as const,
    callId: "fixture-approved-call",
    operationRef: planned.operationRef ?? "missing-operation",
    planDigest: planned.planDigest ?? "missing-digest",
    selection,
  };
  expect(await f.request(execute)).toMatchObject({ status: "prepared" });
  return execute;
};

describe("prepared operation reentry through the actual service lease", () => {
  it("re-enters final resource binding verification without replaying completed writes", async () => {
    const f = fixture();
    const execute = await prepareOnce(f);
    const before = structuredClone(f.row);
    vi.mocked(f.deps.reconcile).mockClear();
    const result = await f.request(execute);
    expect(result).toMatchObject({ status: "prepared" });
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(plan.effects.length + 1);
    expect(f.deps.reconcile).toHaveBeenCalledOnce();
    expect(vi.mocked(f.deps.reconcile).mock.calls[0]?.[0].effect.kind).toBe("gateway-bindings");
    expect(f.deps.verify).toHaveBeenCalledTimes(2);
    expect(f.observedRows[1]?.record).toMatchObject({
      status: "pending",
      proof: before?.record.proof,
      privateState: before?.record.privateState,
      operator: before?.record.operator,
    });
    expect(f.observedRows[1]?.record.leaseId).toEqual(expect.any(String));
    expect(f.observedRows[1]?.record.leaseExpiresAt).toEqual(expect.any(String));
    expect(f.row?.record.operator).toEqual(before?.record.operator);
    expect(f.row?.record.privateState).toEqual(before?.record.privateState);
    expect(f.row?.record.proof).toEqual(before?.record.proof);
    expect(f.row?.record.leaseId).toBeUndefined();
  });

  it.each(["active-lease", "owner-revoked", "approval-revoked"] as const)(
    "rejects reentry with %s before final verification or provider writes",
    async (guard) => {
      const f = fixture();
      const execute = await prepareOnce(f);
      if (guard === "active-lease") {
        const current = f.row;
        if (current === undefined) {
          throw new Error("Missing prepared fixture journal");
        }
        current.record.leaseId = "b941748f-1e43-45cd-9c09-a02567d3fdee";
        current.record.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
      } else if (guard === "owner-revoked") {
        f.revokeOwner();
      } else {
        f.revokeApproval();
      }
      const before = structuredClone(f.row);
      expect(await f.request(execute)).toMatchObject({
        status: "blocked",
        code: guard === "active-lease" ? "operation_in_progress" : "authorization_required",
      });
      expect(f.deps.verify).toHaveBeenCalledOnce();
      expect(f.deps.executeEffect).toHaveBeenCalledTimes(plan.effects.length + 1);
      expect(f.row).toEqual(before);
    },
  );
});
