import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decryptHostedRuntimeFiles, encryptHostedRuntimeFiles } from "./hosted-runtime-service";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { OperatorSelection } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import { readHostedOperatorEffectResourceBindings } from "./hosted-operator-deployment";
import type { HostedOperatorEffectContext } from "./hosted-operator-service";
import {
  assertResourceCredentialCheckpoint,
  prepareHostedOperatorResourceCredentials,
  readHostedOperatorResourceBindings,
} from "./hosted-operator-resource-credentials";

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
const target = {
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
};
const basePlan = hostedOperatorPlanSchema.parse({
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
    projectId: selection.projectId,
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});
const plan = {
  ...basePlan,
  bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
};
const input = {
  authority,
  config: { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "fixture_v1" },
  database: "appDatabase" as const,
  plan,
  record: hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "approved",
    kind: "app-runtime",
    request: target,
    status: "pending",
    step: "reserved",
    version: 1,
  }),
  target,
};

describe("protected resource credential continuation", () => {
  it("reuses exact private ciphertext and canonical passwords on retry", () => {
    const original = prepareHostedOperatorResourceCredentials(input);
    const retryInput = {
      ...input,
      record: { ...input.record, privateState: original.privateState },
    };
    const retry = prepareHostedOperatorResourceCredentials(retryInput);
    expect(retry).toEqual(original);
    const auth = prepareHostedOperatorResourceCredentials({
      ...retryInput,
      database: "authDatabase",
    });
    expect(auth.privateState).toEqual(original.privateState);
    expect(auth.credentialsBytes).not.toEqual(original.credentialsBytes);
  });

  it("refuses different authority and physical resource identities", () => {
    const original = prepareHostedOperatorResourceCredentials(input);
    const resumed = { ...input, record: { ...input.record, privateState: original.privateState } };
    expect(() =>
      prepareHostedOperatorResourceCredentials({
        ...resumed,
        authority: { ...authority, ownerUserId: "different-owner" },
      }),
    ).toThrow();
    expect(() =>
      prepareHostedOperatorResourceCredentials({
        ...resumed,
        plan: { ...plan, appDatabase: { ...plan.appDatabase, resourceId: "different-resource" } },
      }),
    ).toThrow("different resources");
    expect(() =>
      prepareHostedOperatorResourceCredentials({
        ...resumed,
        plan: { ...plan, bootstrap: { ...plan.bootstrap, endpointId: "ep-different" } },
      }),
    ).toThrow("different resources");
  });
});

describe("owned installed resource bindings", () => {
  it("reads the same installed credentials without generating replacements", () => {
    const prepared = prepareHostedOperatorResourceCredentials(input);
    const resumed = { ...input, record: { ...input.record, privateState: prepared.privateState } };
    const bindings = readHostedOperatorResourceBindings(resumed);
    expect(readHostedOperatorResourceBindings(resumed)).toEqual(bindings);
    const credentials = z
      .object({ migratorPassword: z.string() })
      .parse(JSON.parse(prepared.credentialsBytes));
    const migration = new URL(bindings.appDatabase.migrationUrl);
    expect(decodeURIComponent(migration.password)).toBe(credentials.migratorPassword);
    expect(migration.hostname).toBe(plan.neon.endpoint);
    expect(migration.port).toBe("5432");
    expect(migration.pathname).toBe(`/${plan.appDatabase.database}`);
    expect(new URL(bindings.authDatabase.runtimeUrl).username).toBe(plan.authDatabase.runtimeRole);
  });

  it("refuses missing credentials, another owner, and changed physical resources", () => {
    expect(() => readHostedOperatorResourceBindings(input)).toThrow("unavailable");
    const prepared = prepareHostedOperatorResourceCredentials(input);
    const resumed = { ...input, record: { ...input.record, privateState: prepared.privateState } };
    expect(() =>
      readHostedOperatorResourceBindings({
        ...resumed,
        authority: { ...authority, workspaceId: "another-workspace" },
      }),
    ).toThrow();
    expect(() =>
      readHostedOperatorResourceBindings({
        ...resumed,
        plan: { ...plan, authDatabase: { ...plan.authDatabase, runtimeRole: "different_role" } },
      }),
    ).toThrow("different resources");
  });

  it("encodes percent and reserved characters in an owned stored password", () => {
    const prepared = prepareHostedOperatorResourceCredentials(input);
    const resumed = { ...input, record: { ...input.record, privateState: prepared.privateState } };
    const files = decryptHostedRuntimeFiles(resumed);
    if (files === undefined) {
      throw new Error("Expected an owned credential checkpoint.");
    }
    const bundle = z
      .looseObject({
        appDatabase: z.looseObject({ runtimePassword: z.string() }),
      })
      .parse(JSON.parse(files["protected-resource-credentials.json"]));
    const password = "safe%/:@?#&=".repeat(4);
    bundle.appDatabase.runtimePassword = password;
    const privateState = encryptHostedRuntimeFiles({
      ...input,
      files: { "protected-resource-credentials.json": JSON.stringify(bundle) },
    });
    const bindings = readHostedOperatorResourceBindings({
      ...input,
      record: { ...input.record, privateState },
    });
    const url = new URL(bindings.appDatabase.runtimeUrl);
    expect(decodeURIComponent(url.password)).toBe(password);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.hostname).toBe(plan.neon.endpoint);
  });
});

/* oxlint-disable eslint/require-await -- In-memory owner, lease and journal ports preserve the asynchronous production reader contract. */
const completedGatewayBindingObservation = () => {
  const operationRef = "00000000-0000-4000-8000-000000000021";
  const bindingEffect = {
    description: "Bind the approved Gateway configuration",
    id: "gateway-bindings",
    kind: "gateway-bindings" as const,
  };
  const gatewayDeliveryEffect = {
    description: "Deliver the approved Gateway",
    id: "gateway-delivery",
    kind: "gateway-delivery" as const,
  };
  const gatewayPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    delivery: {
      branch: selection.branch,
      gitSha: "c".repeat(40),
      projectId: selection.projectId,
      repoId: "app-repository",
    },
    deploymentBoundary: {
      app: { branch: selection.branch, environment: "preview", projectId: selection.projectId },
      authority,
      gateway: {
        branch: "gateway-preview",
        deploymentId: "gateway-deployment",
        environment: "preview",
        projectId: "gateway-project",
      },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        projectId: "operator-project",
      },
      teamId: target.scopeId,
      verification: {
        gatewayOrigin: "https://gateway.example.test",
        jwksUrl: "https://gateway.example.test/_platform/jwks.json",
        publicOrigin: "https://apps.example.test",
      },
    },
    resourcesInstaller: { reference: "resource-worker", sha256: "e".repeat(64) },
    effects: [
      {
        description: "Auth resources",
        id: "auth-resources",
        kind: "resources",
        resourceId: plan.authDatabase.resourceId,
      },
      {
        description: "App resources",
        id: "app-resources",
        kind: "resources",
        resourceId: plan.appDatabase.resourceId,
      },
      ...plan.effects.filter((effect) => effect.kind !== "resources"),
      { description: "Deliver app", id: "app-delivery", kind: "delivery" },
      bindingEffect,
      gatewayDeliveryEffect,
    ],
    gatewayBindings: {
      authBrowserOrigin: "https://auth.example.test",
      builderCallbackOrigin: "https://builder.example.test",
      catalogAppIds: [selection.appId],
      operatorOrigin: "https://operator.example.test",
      sourceWorkload: {
        audience: "https://gateway.example.test/mcp",
        environment: "preview",
        issuer: "https://builder.example.test",
        ownerId: target.scopeId,
        projectId: "gateway-project",
        subject: "operator-fixture",
      },
    },
    gatewayDelivery: {
      branch: "gateway-preview",
      gitSha: "d".repeat(40),
      projectId: "gateway-project",
      repoId: "gateway-repository",
    },
    publicGateway: {
      branch: "gateway-preview",
      origin: "https://apps.example.test",
      projectId: "gateway-project",
    },
    stage: "app",
  });
  const prepared = prepareHostedOperatorResourceCredentials({ ...input, plan: gatewayPlan });
  const attemptId = "00000000-0000-4000-8000-000000000022";
  const record = hostedRuntimeJournalRecordSchema.parse({
    ...input.record,
    approvedByCallId: "approved-call",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    leaseId: "00000000-0000-4000-8000-000000000023",
    privateState: prepared.privateState,
    status: "pending",
    step: "reserved",
    operator: {
      approvalId: "approval_fixture",
      fenceGeneration: 7,
      mode: "protected-operator-v1",
      operationRef,
      pendingEffectAttempt: { id: attemptId },
      pendingEffectId: gatewayDeliveryEffect.id,
      plan: gatewayPlan,
      planDigest: operatorPlanDigest(gatewayPlan),
      receipts: [
        {
          effectId: bindingEffect.id,
          observedAt: "2026-10-16T12:00:00.000Z",
          resourceVersion: "binding-readback",
        },
      ],
    },
  });
  const effect = {
    authority,
    assertCurrent: async () => {},
    checkpoint: async () => {},
    effect: bindingEffect,
    fenceGeneration: 7,
    leaseId: record.leaseId,
    operationRef,
    plan: gatewayPlan,
    privateState: prepared.privateState,
    target,
    workerCheckpoints: [],
  };
  return { attemptId, effect, gatewayDeliveryEffect, gatewayPlan, record };
};

describe("completed Gateway binding resource observations", () => {
  it("reads sealed credentials under the completed binding receipt while delivery owns the lease", async () => {
    const fixture = completedGatewayBindingObservation();
    let reads = 0;
    const store = {
      read: async () => {
        reads += 1;
        return { record: fixture.record, revision: reads };
      },
    };
    let authorizations = 0;
    let fences = 0;
    const bindings = await readHostedOperatorEffectResourceBindings({
      assertAuthorized: async () => {
        authorizations += 1;
      },
      config: input.config,
      effect: {
        ...fixture.effect,
        assertCurrent: async () => {
          fences += 1;
        },
      },
      store,
    });
    expect(reads).toBe(2);
    expect(authorizations).toBe(2);
    expect(fences).toBe(2);
    expect(new URL(bindings.authDatabase.runtimeUrl).username).toBe(
      fixture.gatewayPlan.authDatabase.runtimeRole,
    );
    expect(new URL(bindings.appDatabase.runtimeUrl).username).toBe(
      fixture.gatewayPlan.appDatabase.runtimeRole,
    );
  });

  it.each(["receipt", "phase", "attempt", "plan", "fence", "privateState"] as const)(
    "rejects a completed Gateway binding observation with an invalid %s",
    async (invalid) => {
      const fixture = completedGatewayBindingObservation();
      const record = structuredClone(fixture.record);
      const effect: HostedOperatorEffectContext & { workerAttemptId?: string } = {
        ...fixture.effect,
      };
      const { operator } = record;
      if (operator === undefined) {
        throw new Error("Missing canonical operator fixture");
      }
      if (invalid === "receipt") {
        operator.receipts = [];
      } else if (invalid === "phase") {
        operator.pendingEffectId = "bind";
      } else if (invalid === "attempt") {
        effect.workerAttemptId = fixture.attemptId;
      } else if (invalid === "plan") {
        effect.plan = hostedOperatorPlanSchema.parse({
          ...fixture.gatewayPlan,
          release: { ...fixture.gatewayPlan.release, sha256: "e".repeat(64) },
        });
      } else if (invalid === "fence") {
        effect.fenceGeneration += 1;
      } else {
        effect.privateState = undefined;
      }
      const store = {
        read: async () => ({ record, revision: 1 }),
      };
      await expect(
        readHostedOperatorEffectResourceBindings({
          assertAuthorized: async () => {},
          config: input.config,
          effect,
          store,
        }),
      ).rejects.toThrow();
    },
  );

  it.each(["attempt", "privateState"] as const)(
    "rejects if %s changes during the second journal read",
    async (changed) => {
      const fixture = completedGatewayBindingObservation();
      let reads = 0;
      const store = {
        read: async () => {
          reads += 1;
          const record = structuredClone(fixture.record);
          if (reads === 2) {
            const attempt = record.operator?.pendingEffectAttempt;
            const { privateState } = record;
            if (attempt === undefined || privateState === undefined) {
              throw new Error("Missing protected attempt fixture");
            }
            if (changed === "attempt") {
              attempt.id = "00000000-0000-4000-8000-000000000024";
            } else {
              privateState.encryptedToken = "changed-sealed-state";
            }
          }
          return { record, revision: reads };
        },
      };
      await expect(
        readHostedOperatorEffectResourceBindings({
          assertAuthorized: async () => {},
          config: input.config,
          effect: fixture.effect,
          store,
        }),
      ).rejects.toThrow("operation_in_progress");
    },
  );
});

/* oxlint-enable eslint/require-await */

describe("sealed resource credential checkpoint acknowledgment", () => {
  it("accepts the actual journal parser roundtrip while preserving the same credentials", () => {
    const prepared = prepareHostedOperatorResourceCredentials(input);
    const persisted = hostedRuntimeJournalRecordSchema.parse({
      ...input.record,
      privateState: prepared.privateState,
    });
    expect(JSON.stringify(persisted.privateState)).not.toBe(JSON.stringify(prepared.privateState));
    expect(() => {
      assertResourceCredentialCheckpoint(persisted.privateState, prepared.privateState);
    }).not.toThrow();
    expect(
      prepareHostedOperatorResourceCredentials({ ...input, record: persisted }).credentialsBytes,
    ).toBe(prepared.credentialsBytes);
  });

  it.each(["encryptedToken", "keyVersion", "tokenIv", "tokenTag"] as const)(
    "rejects a changed %s in the acknowledged envelope",
    (field) => {
      const prepared = prepareHostedOperatorResourceCredentials(input);
      const changed = {
        ...prepared.privateState,
        [field]: `${prepared.privateState[field]}changed`,
      };
      expect(() => {
        assertResourceCredentialCheckpoint(changed, prepared.privateState);
      }).toThrow("operation_in_progress");
    },
  );

  it("rejects a missing acknowledged envelope", () => {
    const prepared = prepareHostedOperatorResourceCredentials(input);
    expect(() => {
      assertResourceCredentialCheckpoint(undefined, prepared.privateState);
    }).toThrow("operation_in_progress");
  });
});
