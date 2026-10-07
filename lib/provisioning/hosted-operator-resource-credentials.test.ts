import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decryptHostedRuntimeFiles, encryptHostedRuntimeFiles } from "./hosted-runtime-service";
import { hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { OperatorSelection } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import {
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
