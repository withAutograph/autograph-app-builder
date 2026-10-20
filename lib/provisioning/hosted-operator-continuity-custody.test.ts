import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  hostedContinuityPlanSchema,
  continuityPlanDigest,
  continuityRecordSchema,
} from "./hosted-operator-continuity-contract";
import type { ContinuityRecord } from "./hosted-operator-continuity-contract";
import { createContinuityCapabilityCustody } from "./hosted-operator-continuity-custody";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const context: HostedOperatorContext = {
  authority,
  target: {
    appId: "orchard",
    branch: "preview",
    environment: "preview",
    projectId: "app-project",
    sessionId: "saved-session",
    installationId: "installation",
    scopeId: "team",
    scopeType: "team",
  },
};
const preparedPlan = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  access: [{ actorId: "actor-one", organizationId: "organization-one", roles: ["custom_role"] }],
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    runtimeRole: "app_runtime",
    resourceId: "app-resource",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    runtimeRole: "auth_runtime",
    resourceId: "auth-resource",
  },
  contextId: "ordinary-planning-context",
  cost: { class: "shared-recovery-group", description: "Controlled fixture", owner: "Fixture" },
  effects: [
    { id: "resources", kind: "resources", description: "Prepare resources" },
    { id: "install", kind: "install", description: "Install app" },
    { id: "access", kind: "access", description: "Authorize app" },
    { id: "bindings", kind: "bindings", description: "Bind runtime" },
  ],
  installer: { reference: "shared-installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private-connection",
    endpoint: "ep-controlled.us-east-1.aws.neon.tech",
    projectId: "database-project",
    source: "synthetic-only",
  },
  release: { artifactRef: "retained-app-release", id: "app-release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "Original retention" },
  selection: {
    appId: context.target.appId,
    branch: context.target.branch,
    environment: "preview",
    projectId: context.target.projectId,
    sessionId: context.target.sessionId,
  },
});
const selection = {
  version: 1 as const,
  kind: "app-continuity-plan" as const,
  authority,
  target: context.target,
  originalSetup: {
    operationRef: "10000000-0000-4000-8000-000000000001",
    planDigest: "c".repeat(64),
    approvalId: "setup-human",
    approvedByCallId: "setup-call",
  },
  preparedPlan,
  runtime: {
    sandboxId: "owned-sandbox",
    root: "/controlled/source",
    projectId: "builder-project",
    ownerId: "team",
    appPort: 3000,
    bridgePort: 3100,
  },
  gateway: {
    projectId: "gateway-project",
    ownerId: "team",
    environment: "preview" as const,
    publicOrigin: "https://gateway.example",
  },
  actors: [{ actorId: "actor-one", organizationId: "organization-one" }],
};
const makePlan = () =>
  hostedContinuityPlanSchema.parse({
    ...selection,
    intentId: "20000000-0000-4000-8000-000000000002",
    planRef: "_protected-operator/continuity-plans/20000000-0000-4000-8000-000000000002",
  });

const makeRecord = () => {
  const plan = makePlan();
  return continuityRecordSchema.parse({
    kind: "app-continuity",
    requestId: plan.intentId,
    revision: 1,
    idempotencyKey: "request",
    plan,
    planDigest: continuityPlanDigest(plan),
    state: "starting",
    fence: 1,
    attemptId: "30000000-0000-4000-8000-000000000003",
    environmentRows: [],
    environmentWrites: [],
    deliveryCandidates: [],
  });
};
const capabilities = {
  suiteSelector: "controlled-selector",
  transport: "controlled-transport",
  lifecycle: "controlled-lifecycle",
};
const changedAuthority: { label: string; change: (record: ContinuityRecord) => void }[] = [
  {
    label: "owner",
    change: (record) => {
      record.plan.authority.ownerUserId = "foreign-owner";
    },
  },
  {
    label: "workspace",
    change: (record) => {
      record.plan.authority.workspaceId = "foreign-workspace";
    },
  },
  {
    label: "issuer",
    change: (record) => {
      record.plan.authority.issuer = "https://foreign.example/auth";
    },
  },
  {
    label: "audience",
    change: (record) => {
      record.plan.authority.audience = "https://foreign.example/mcp";
    },
  },
  {
    label: "session",
    change: (record) => {
      record.plan.target.sessionId = "foreign-session";
    },
  },
  {
    label: "app",
    change: (record) => {
      record.plan.target.appId = "other-app";
    },
  },
  {
    label: "intent",
    change: (record) => {
      record.requestId = "40000000-0000-4000-8000-000000000004";
    },
  },
  {
    label: "attempt",
    change: (record) => {
      record.attemptId = "50000000-0000-4000-8000-000000000005";
    },
  },
  {
    label: "fence",
    change: (record) => {
      record.fence += 1;
    },
  },
  {
    label: "setup",
    change: (record) => {
      record.plan.originalSetup.operationRef = "60000000-0000-4000-8000-000000000006";
    },
  },
  {
    label: "plan",
    change: (record) => {
      record.planDigest = "e".repeat(64);
    },
  },
];
describe("managed continuity capability custody", () => {
  it("round trips only through encrypted private state without retaining any bearer plaintext", () => {
    const custody = createContinuityCapabilityCustody({
      tokenKey: randomBytes(32),
      tokenKeyVersion: "fixture-key",
    });
    const record = makeRecord();
    const sealed = { ...record, privateState: custody.seal(record, capabilities) };
    expect(custody.unseal(sealed)).toEqual(capabilities);
    for (const bearer of Object.values(capabilities)) {
      expect(JSON.stringify(sealed)).not.toContain(bearer);
    }
    const fresh = custody.seal(record, capabilities);
    expect(fresh.tokenIv).not.toBe(sealed.privateState.tokenIv);
  });
  it.each(changedAuthority)(
    "rejects encrypted capabilities transplanted to a different $label",
    ({ change }) => {
      const custody = createContinuityCapabilityCustody({
        tokenKey: randomBytes(32),
        tokenKeyVersion: "fixture-key",
      });
      const record = makeRecord();
      const sealed = { ...record, privateState: custody.seal(record, capabilities) };
      change(sealed);
      expect(() => custody.unseal(sealed)).toThrow();
    },
  );
  it("refuses absent, tampered or foreign-key private state", () => {
    const custody = createContinuityCapabilityCustody({
      tokenKey: randomBytes(32),
      tokenKeyVersion: "fixture-key",
    });
    const record = makeRecord();
    expect(() => custody.unseal(record)).toThrow();
    const sealed = { ...record, privateState: custody.seal(record, capabilities) };
    const other = createContinuityCapabilityCustody({
      tokenKey: randomBytes(32),
      tokenKeyVersion: "fixture-key",
    });
    expect(() => other.unseal(sealed)).toThrow();
    const bytes = Buffer.from(sealed.privateState.encryptedToken, "base64");
    bytes[0] = (bytes[0] ?? 0) === 0 ? 1 : 0;
    sealed.privateState.encryptedToken = bytes.toString("base64");
    expect(() => custody.unseal(sealed)).toThrow();
  });
});
