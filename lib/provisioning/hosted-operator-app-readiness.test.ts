/* eslint-disable require-await -- These faithful asynchronous reader fixtures resolve in memory without network I/O. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { OperatorSelection } from "./hosted-operator-contract";
import { createHostedOperatorAppReadiness } from "./hosted-operator-app-readiness";
import type {
  AppRuntimeSnapshotReader,
  ReadAppRuntimeSnapshot,
} from "./hosted-operator-app-readiness";

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

const artifactHash = "c".repeat(64);
const manifest = Buffer.from(
  JSON.stringify({
    app: "spend-review",
    hashes: { schema: `sha256:${artifactHash}` },
    schema_version: "release_fixture",
  }),
);
const plan = {
  ...basePlan,
  release: { ...basePlan.release, sha256: createHash("sha256").update(manifest).digest("hex") },
};
const fixture = () => {
  const identity = {
    branch: "br_synthetic",
    can_create: false,
    can_temp: false,
    comment: "protected-resource:v1:app_database:app-resource:database",
    database: "spend",
    endpoint: "ep-fixture",
    login: "spend_runtime",
    owner: "spend_owner",
    owns_public_objects: false,
    privileged_membership: false,
    project: "synthetic-project",
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    role: "spend_runtime",
    rolreplication: false,
    rolsuper: false,
  };
  const observation = {
    data: {
      active_base_revision: "release_fixture",
      active_effective_artifact_hash: artifactHash,
      active_schema_revision_id: 7,
      app_id: "spend-review",
      customer_id: "synthetic-org",
      releases: [
        {
          artifact_hashes: { base: artifactHash, effective: artifactHash, schema: "d".repeat(64) },
          base_revision: "release_fixture",
          preparation: { state: "active" },
          release_id: "release_fixture",
          runtime_schema: { status: "stored_schema_hash_matches" },
          schema_revision_id: 7,
        },
      ],
    },
    ok: true as const,
  };
  const scopes: { appId: string; organizationId: string }[] = [];
  const reader: AppRuntimeSnapshotReader = {
    readIdentity: async () => identity,
    readOrganization: async (appId, organizationId) => {
      scopes.push({ appId, organizationId });
      return observation;
    },
  };
  const readRuntimeSnapshot = vi.fn<ReadAppRuntimeSnapshot>(
    async (_url, read) => await read(reader),
  );
  const deps = {
    assertAuthorized: vi.fn(async () => {}),
    readReleaseManifest: vi.fn(async () => manifest),
    readRuntimeSnapshot,
    readRuntimeUrl: vi.fn(
      async () =>
        "postgresql://spend_runtime:private-secret@ep-fixture.us-east-1.aws.neon.tech/spend?sslmode=verify-full",
    ),
  };
  return {
    deps,
    identity,
    input: { assertCurrent: vi.fn(async () => {}), authority, plan, target },
    observation,
    reader,
    scopes,
    verify: createHostedOperatorAppReadiness(deps),
  };
};
it("independently reads each exact approved organization without exposing credentials", async () => {
  const f = fixture();
  const proof = await f.verify(f.input);
  expect(proof).toMatchObject({
    artifactHash,
    authenticatedBehavior: "unassessed",
    releaseId: "release_fixture",
    source: "restricted-app-runtime",
    tenants: 1,
  });
  expect(f.scopes).toEqual([{ appId: "spend-review", organizationId: "synthetic-org" }]);
  expect(JSON.stringify(proof)).not.toContain("private-secret");
  expect(f.input.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4);
});
it.each(["role", "owner", "database", "project", "branch", "comment"] as const)(
  "rejects cross-resource %s",
  async (key) => {
    const f = fixture();
    f.identity[key] = "foreign";
    await expect(f.verify(f.input)).rejects.toThrow("readiness_unconfirmed");
  },
);
it.each([
  "app_id",
  "customer_id",
  "active_base_revision",
  "active_effective_artifact_hash",
] as const)("rejects cross-tenant/release %s", async (key) => {
  const f = fixture();
  f.observation.data[key] = "foreign";
  await expect(f.verify(f.input)).rejects.toThrow("readiness_unconfirmed");
});
it("requires the frozen release manifest digest", async () => {
  const f = fixture();
  f.deps.readReleaseManifest.mockResolvedValue(Buffer.from("{}"));
  await expect(f.verify(f.input)).rejects.toThrow("readiness_unconfirmed");
  expect(f.deps.readRuntimeSnapshot).not.toHaveBeenCalled();
});
it("rejects a different selected session before accessing credentials", async () => {
  const f = fixture();
  f.input.target = { ...target, sessionId: "another-session" };
  await expect(f.verify(f.input)).rejects.toThrow("readiness_unconfirmed");
  expect(f.deps.readRuntimeUrl).not.toHaveBeenCalled();
});
it("rejects administrator credentials before opening a connection", async () => {
  const f = fixture();
  f.deps.readRuntimeUrl.mockResolvedValue(
    "postgresql://spend_owner:private-secret@ep-fixture.us-east-1.aws.neon.tech/spend?sslmode=verify-full",
  );
  await expect(f.verify(f.input)).rejects.toThrow("readiness_unconfirmed");
  expect(f.deps.readRuntimeSnapshot).not.toHaveBeenCalled();
});
it("rejects a lost fence after database reads", async () => {
  const f = fixture();
  let calls = 0;
  f.input.assertCurrent.mockImplementation(async () => {
    calls += 1;
    if (calls === 4) {
      throw new Error("private-provider-secret");
    }
  });
  await expect(f.verify(f.input)).rejects.toThrow("readiness_unconfirmed");
  expect(f.scopes).toHaveLength(1);
});
it("queries the complete distinct approved tenant list", async () => {
  const f = fixture();
  f.input.plan = {
    ...plan,
    access: [
      ...plan.access,
      { actorId: "second", organizationId: "second-org", roles: ["reviewer"] },
    ],
  };
  f.reader.readOrganization = async (appId, organizationId) => {
    f.scopes.push({ appId, organizationId });
    return {
      ...f.observation,
      data: { ...f.observation.data, customer_id: organizationId },
    };
  };
  const proof = await f.verify(f.input);
  expect(proof.tenants).toBe(2);
  expect(f.scopes.map((scope) => scope.organizationId)).toEqual(["second-org", "synthetic-org"]);
});
it("strips private provider errors", async () => {
  const f = fixture();
  f.reader.readOrganization = async () => {
    throw new Error("private-provider-secret");
  };
  await expect(f.verify(f.input)).rejects.toThrow("readiness_unconfirmed");
});

it.each(["privileged_membership", "owns_public_objects"] as const)(
  "rejects elevated runtime %s",
  async (key) => {
    const f = fixture();
    f.identity[key] = true;
    await expect(f.verify(f.input)).rejects.toThrow("readiness_unconfirmed");
  },
);
