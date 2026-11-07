/* oxlint-disable eslint/require-await -- Pure asynchronous history fixtures never call providers. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import { nativeTargetRequiredProjectProtection } from "../provisioning/native-target-onboarding-plan-schema";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "../provisioning/native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyApproval } from "../provisioning/native-target-auth-only-dispatch";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import type { PrivateNativeTargetApprovalObservation } from "./private-native-target-approval";
import {
  readPrivateNativeTargetAuthOnlyResourceApproval,
  nativeTargetAuthOnlyResourceApprovalAction,
  nativeTargetAuthOnlyResourceApprovalTool,
} from "./private-native-target-auth-only-resource-approval";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-fixture",
  ownerUserId: "owner-fixture",
};
const owner = {
  authority,
  publicSessionId: "saved-session",
  adapterSessionId: "saved-adapter",
  adapterGeneration: 1,
};
const historyOwner = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: owner.publicSessionId,
  adapterSessionId: owner.adapterSessionId,
  adapterGeneration: 1,
});
const plan = nativeTargetAuthOnlyPlanSchema.parse({
  version: 1,
  kind: "native-target-auth-only",
  appId: "signup-pilot",
  origin: {
    authority,
    publicSessionId: owner.publicSessionId,
    adapterSessionId: owner.adapterSessionId,
    adapterGeneration: 1,
    appSpecDigest: "a".repeat(64),
    capturedDescription: { appId: "signup-pilot", kind: "static", sha256: "b".repeat(64) },
  },
  project: {
    name: "signup-pilot",
    teamId: "team-fixture",
    installationId: "install-fixture",
    projectSettings: {
      framework: "nextjs",
      rootDirectory: "apps/signup-pilot",
      sourceFilesOutsideRootDirectory: true,
    },
    protection: nativeTargetRequiredProjectProtection,
  },
  branch: "pilot",
  publishedSource: {
    branch: "pilot",
    changeSetDigest: "c".repeat(64),
    gitSha: "d".repeat(40),
    gitTree: "e".repeat(40),
    repositoryId: "repo-fixture",
    reviewDigest: "f".repeat(64),
  },
  authResource: {
    profileId: "pilot-auth",
    authorityDigest: "1".repeat(64),
    resourceId: "isolated-auth",
    database: "pilot_auth",
    endpointId: "ep-pilot",
    hostname: "ep-pilot.neon.tech",
  },
  authSchema: {
    artifactRef: "auth-artifact",
    planDigest: "2".repeat(64),
    targetDigest: "3".repeat(64),
    installer: { reference: "auth-worker", sha256: "4".repeat(64) },
  },
  appRole: "pilot_user",
  signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
  cost: { ownership: "current-owner", description: "Isolated Preview" },
  retention: { policy: "Until approved cleanup" },
});
const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
const operationRef = "11111111-1111-4111-a111-111111111111";
const resourcePlan = {
  version: 1,
  action: "prepare",
  authOnlyPlanDigest: planDigest,
  target: {
    appId: plan.appId,
    sessionId: owner.publicSessionId,
    projectId: "prj-created",
    branch: plan.branch,
    environment: "preview",
    installationId: plan.project.installationId,
    scopeType: "team",
    scopeId: plan.project.teamId,
  },
  authDatabase: {
    resourceId: "isolated-auth",
    database: "pilot_auth",
    migratorRole: "pilot_migrator",
    runtimeRole: "pilot_runtime",
  },
  bootstrap: { endpointId: "ep-pilot", maintenanceDatabase: "neondb", role: "bootstrap_owner" },
  neon: { projectId: "pilot-project", branchId: "pilot-branch", endpoint: "ep-pilot.neon.tech" },
  nativeNeonConfiguration: {
    connector: "neon-owned",
    nativeStore: {
      configurationId: "icfg-neon",
      resourceId: "store-neon",
      sourceProjectId: "prj-anchor",
    },
    operator: {
      projectId: "prj-operator",
      ownerId: plan.project.teamId,
      environment: "preview",
      issuer: "https://oidc.vercel.com/fixture",
      audience: "https://vercel.com/fixture",
    },
  },
  resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: "5".repeat(64) },
  effects: [{ id: "auth-resources", kind: "resources", resourceId: "isolated-auth" }],
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const resourcePlanDigest = sha(bytes(resourcePlan));
const toolInput = { appId: plan.appId, operationRef, planDigest, resourcePlanDigest, resourcePlan };
const requested = (
  changes: {
    requestId?: string;
    callId?: string;
    toolName?: string;
    input?: typeof toolInput;
  } = {},
): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-11-06T12:00:00.000Z", id: "request-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "resource-turn",
    requests: [
      {
        kind: "tool-approval",
        requestId: changes.requestId ?? "resource-request",
        prompt: "Create the isolated Auth resource",
        action: {
          kind: "tool-call",
          callId: changes.callId ?? "original-call",
          toolName: changes.toolName ?? nativeTargetAuthOnlyResourceApprovalTool,
          input: changes.input ?? structuredClone(toolInput),
        },
      },
    ],
  },
});
const settled = (
  changes: {
    requestId?: string;
    principal?: string;
    outcome?: "approved" | "cancelled";
    at?: string;
  } = {},
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: changes.at ?? "2026-11-06T12:00:01.000Z", id: "settled-event" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "resource-turn",
    requestId: changes.requestId ?? "resource-request",
    responderPrincipalId: changes.principal ?? authority.ownerUserId,
    outcome: changes.outcome ?? "approved",
  },
});
const proof: NativeTargetAuthOnlyApproval = {
  requestId: "resource-request",
  callId: "original-call",
  planDigest,
  sourceDigest: resourcePlanDigest,
  publicSessionId: owner.publicSessionId,
  responderPrincipalId: authority.ownerUserId,
  outcome: "approved",
  observedAt: "2026-11-06T12:00:01.000Z",
};
const fixture = (events: MessageStreamEvent[] = [requested(), settled()], complete = true) => ({
  owner: structuredClone(owner),
  historyOwner: structuredClone(historyOwner),
  plan: structuredClone(plan),
  operationRef,
  resourcePlanBytes: bytes(resourcePlan),
  resourcePlanDigest,
  assertOwner: vi.fn(async () => undefined),
  readHistory: vi.fn(async (start: number, observe: (event: MessageStreamEvent) => void) => {
    for (const event of events) observe(event);
    return {
      complete,
      nextNativeIndex: start + events.length,
      nativeTailIndex: Math.max(0, start + events.length - 1),
    };
  }),
});

it("proves the actual separate resource settlement and preserves its original identity", async () => {
  const f = fixture();
  await expect(readPrivateNativeTargetAuthOnlyResourceApproval(f)).resolves.toEqual(proof);
  expect(f.assertOwner).toHaveBeenCalledTimes(2);
});

it.each([
  "project-tool",
  "schema-digest",
  "operation",
  "target",
  "resource",
  "source",
  "unmatched-settlement",
  "extra-field",
] as const)("does not treat %s as this resource approval", async (kind) => {
  const changed = structuredClone(toolInput);
  if (kind === "schema-digest")
    changed.resourcePlanDigest = nativeTargetAuthOnlySchemaEffectDigest(plan, plan.publishedSource);
  if (kind === "operation") changed.operationRef = "22222222-2222-4222-a222-222222222222";
  if (kind === "target") changed.resourcePlan.target.projectId = "other-project";
  if (kind === "resource") changed.resourcePlan.authDatabase.database = "other";
  if (kind === "source") changed.planDigest = "f".repeat(64);
  if (kind === "extra-field")
    Object.assign(changed.resourcePlan, { appDatabase: { database: "not-approved" } });
  const events = [
    requested({
      input: changed,
      ...(kind === "project-tool" ? { toolName: "prepare-app-native-target-auth-only" } : {}),
    }),
    settled({ ...(kind === "unmatched-settlement" ? { requestId: "other" } : {}) }),
  ];
  await expect(
    readPrivateNativeTargetAuthOnlyResourceApproval(fixture(events)),
  ).resolves.toBeNull();
});

it.each(["digest", "owner", "session", "adapter", "scope", "second-resource"] as const)(
  "rejects mismatched retained %s before history",
  async (kind) => {
    const f = fixture();
    const changed = structuredClone(resourcePlan);
    if (kind === "digest") f.resourcePlanDigest = "f".repeat(64);
    if (kind === "owner") f.owner.authority.ownerUserId = "foreign";
    if (kind === "session") f.owner.publicSessionId = "foreign";
    if (kind === "adapter") f.owner.adapterGeneration = 2;
    if (kind === "scope") changed.target.scopeId = "foreign";
    if (kind === "second-resource")
      changed.effects.push({ id: "app-resource", kind: "resources", resourceId: "app-db" });
    if (kind === "scope" || kind === "second-resource") {
      f.resourcePlanBytes = bytes(changed);
      f.resourcePlanDigest = sha(f.resourcePlanBytes);
    }
    await expect(readPrivateNativeTargetAuthOnlyResourceApproval(f)).rejects.toThrow();
    expect(f.readHistory).not.toHaveBeenCalled();
  },
);

it("retains cancellation even after a later approved retry", async () => {
  const f = fixture([
    requested(),
    settled({ outcome: "cancelled" }),
    requested({ requestId: "retry-request", callId: "retry-call" }),
    settled({ requestId: "retry-request" }),
  ]);
  await expect(readPrivateNativeTargetAuthOnlyResourceApproval(f)).resolves.toEqual({
    ...proof,
    outcome: "cancelled",
  });
});

it("does not promote a subsequent settlement over an original cancellation", async () => {
  await expect(
    readPrivateNativeTargetAuthOnlyResourceApproval(
      fixture([
        requested(),
        settled({ outcome: "cancelled" }),
        settled({ at: "2026-11-06T12:00:02.000Z" }),
      ]),
    ),
  ).resolves.toEqual({ ...proof, outcome: "cancelled" });
});

it("rejects a foreign responder and two ambiguous approved requests", async () => {
  await expect(
    readPrivateNativeTargetAuthOnlyResourceApproval(
      fixture([requested(), settled({ principal: "foreign" })]),
    ),
  ).rejects.toThrow();
  await expect(
    readPrivateNativeTargetAuthOnlyResourceApproval(
      fixture([
        requested(),
        settled(),
        requested({ requestId: "second", callId: "second-call" }),
        settled({ requestId: "second" }),
      ]),
    ),
  ).rejects.toThrow();
});

it("uses the retained original settlement when a retry has a different call ID", async () => {
  const f = fixture([
    requested(),
    settled(),
    requested({ requestId: "retry", callId: "retry-call" }),
    settled({ requestId: "retry" }),
  ]);
  await expect(
    readPrivateNativeTargetAuthOnlyResourceApproval({ ...f, retainedApproval: proof }),
  ).resolves.toEqual(proof);
});

it.each(["missing", "different-request", "different-time", "wrong-resource"] as const)(
  "never turns a retained %s proof into a fresh approval request",
  async (kind) => {
    const retained = { ...proof };
    if (kind === "different-request") retained.requestId = "other";
    if (kind === "different-time") retained.observedAt = "2026-11-06T12:00:02.000Z";
    if (kind === "wrong-resource") retained.sourceDigest = "f".repeat(64);
    const f = fixture(kind === "missing" ? [] : undefined);
    await expect(
      readPrivateNativeTargetAuthOnlyResourceApproval({ ...f, retainedApproval: retained }),
    ).rejects.toThrow();
  },
);

it.each(["approved", "cancelled"] as const)(
  "saves a partial %s tail and resumes its original request, call and timestamp",
  async (outcome) => {
    let saved: PrivateNativeTargetApprovalObservation | undefined;
    const save = vi.fn(async (next: PrivateNativeTargetApprovalObservation) => {
      saved = structuredClone(next);
    });
    await expect(
      readPrivateNativeTargetAuthOnlyResourceApproval({
        ...fixture([requested(), settled({ outcome })], false),
        observation: { save },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    expect(saved?.native.capture.request).toEqual({
      action: nativeTargetAuthOnlyResourceApprovalAction,
      planRef: operationRef,
      planDigest: resourcePlanDigest,
      idempotencyKey: plan.appId,
    });
    const resumed = fixture([]);
    await expect(
      readPrivateNativeTargetAuthOnlyResourceApproval({
        ...resumed,
        observation: { state: saved, save },
      }),
    ).resolves.toEqual({ ...proof, outcome });
    expect(resumed.readHistory).toHaveBeenCalledWith(2, expect.any(Function));
  },
);

it("discards an incomplete positive grant when the verified adapter generation changes", async () => {
  let saved: PrivateNativeTargetApprovalObservation | undefined;
  const save = async (next: PrivateNativeTargetApprovalObservation) => {
    saved = structuredClone(next);
  };
  await expect(
    readPrivateNativeTargetAuthOnlyResourceApproval({
      ...fixture(undefined, false),
      observation: { save },
    }),
  ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
  const resumed = fixture([]);
  resumed.owner.adapterSessionId = "recovered-adapter";
  resumed.owner.adapterGeneration = 2;
  resumed.historyOwner.adapterSessionId = "recovered-adapter";
  resumed.historyOwner.adapterGeneration = 2;
  await expect(
    readPrivateNativeTargetAuthOnlyResourceApproval({
      ...resumed,
      observation: { state: saved, save },
    }),
  ).resolves.toBeNull();
  expect(resumed.readHistory).toHaveBeenCalledWith(0, expect.any(Function));
});

it("withholds approval after owner loss and snapshots caller inputs before awaiting", async () => {
  const lost = fixture();
  lost.assertOwner
    .mockImplementationOnce(async () => undefined)
    .mockRejectedValueOnce(new Error("revoked"));
  await expect(readPrivateNativeTargetAuthOnlyResourceApproval(lost)).rejects.toThrow("revoked");
  const frozen = fixture();
  frozen.assertOwner.mockImplementationOnce(async () => {
    frozen.resourcePlanBytes.fill(32);
    frozen.plan.appRole = "changed";
    frozen.owner.authority.ownerUserId = "foreign";
  });
  await expect(readPrivateNativeTargetAuthOnlyResourceApproval(frozen)).resolves.toEqual(proof);
});
