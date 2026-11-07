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
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner-fixture",
  workspaceId: "workspace-fixture",
};
const owner = {
  adapterGeneration: 1,
  adapterSessionId: "saved-adapter",
  authority,
  publicSessionId: "saved-session",
};
const historyOwner = operatorOwnerContextSchema.parse({
  adapterGeneration: 1,
  adapterSessionId: owner.adapterSessionId,
  authority,
  kind: "direct",
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: owner.publicSessionId,
});
const plan = nativeTargetAuthOnlyPlanSchema.parse({
  appId: "signup-pilot",
  appRole: "pilot_user",
  authResource: {
    authorityDigest: "1".repeat(64),
    database: "pilot_auth",
    endpointId: "ep-pilot",
    hostname: "ep-pilot.neon.tech",
    profileId: "pilot-auth",
    resourceId: "isolated-auth",
  },
  authSchema: {
    artifactRef: "auth-artifact",
    installer: { reference: "auth-worker", sha256: "4".repeat(64) },
    planDigest: "2".repeat(64),
    targetDigest: "3".repeat(64),
  },
  branch: "pilot",
  cost: { description: "Isolated Preview", ownership: "current-owner" },
  kind: "native-target-auth-only",
  origin: {
    adapterGeneration: 1,
    adapterSessionId: owner.adapterSessionId,
    appSpecDigest: "a".repeat(64),
    authority,
    capturedDescription: { appId: "signup-pilot", kind: "static", sha256: "b".repeat(64) },
    publicSessionId: owner.publicSessionId,
  },
  project: {
    installationId: "install-fixture",
    name: "signup-pilot",
    projectSettings: {
      framework: "nextjs",
      rootDirectory: "apps/signup-pilot",
      sourceFilesOutsideRootDirectory: true,
    },
    protection: nativeTargetRequiredProjectProtection,
    teamId: "team-fixture",
  },
  publishedSource: {
    branch: "pilot",
    changeSetDigest: "c".repeat(64),
    gitSha: "d".repeat(40),
    gitTree: "e".repeat(40),
    repositoryId: "repo-fixture",
    reviewDigest: "f".repeat(64),
  },
  retention: { policy: "Until approved cleanup" },
  signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
  version: 1,
});
const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
const operationRef = "11111111-1111-4111-a111-111111111111";
const resourcePlan = {
  action: "prepare",
  authDatabase: {
    database: "pilot_auth",
    migratorRole: "pilot_migrator",
    resourceId: "isolated-auth",
    runtimeRole: "pilot_runtime",
  },
  authOnlyPlanDigest: planDigest,
  bootstrap: { endpointId: "ep-pilot", maintenanceDatabase: "neondb", role: "bootstrap_owner" },
  effects: [{ id: "auth-resources", kind: "resources", resourceId: "isolated-auth" }],
  nativeNeonConfiguration: {
    connector: "neon-owned",
    nativeStore: {
      configurationId: "icfg-neon",
      resourceId: "store-neon",
      sourceProjectId: "prj-anchor",
    },
    operator: {
      audience: "https://vercel.com/fixture",
      environment: "preview",
      issuer: "https://oidc.vercel.com/fixture",
      ownerId: plan.project.teamId,
      projectId: "prj-operator",
    },
  },
  neon: { branchId: "pilot-branch", endpoint: "ep-pilot.neon.tech", projectId: "pilot-project" },
  resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: "5".repeat(64) },
  target: {
    appId: plan.appId,
    branch: plan.branch,
    environment: "preview",
    installationId: plan.project.installationId,
    projectId: "prj-created",
    scopeId: plan.project.teamId,
    scopeType: "team",
    sessionId: owner.publicSessionId,
  },
  version: 1,
};
const bytes = (value: typeof resourcePlan) => Buffer.from(JSON.stringify(value));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const resourcePlanDigest = sha(bytes(resourcePlan));
const toolInput = { appId: plan.appId, operationRef, planDigest, resourcePlan, resourcePlanDigest };
const requested = (
  changes: {
    requestId?: string;
    callId?: string;
    toolName?: string;
    input?: typeof toolInput;
  } = {},
): MessageStreamEvent => ({
  data: {
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
    sequence: 1,
    stepIndex: 0,
    turnId: "resource-turn",
  },
  meta: { at: "2026-11-06T12:00:00.000Z", id: "request-event" },
  type: "input.requested",
});
const settled = (
  changes: {
    requestId?: string;
    principal?: string;
    outcome?: "approved" | "cancelled";
    at?: string;
  } = {},
): MessageStreamEvent => ({
  data: {
    outcome: changes.outcome ?? "approved",
    requestId: changes.requestId ?? "resource-request",
    responderPrincipalId: changes.principal ?? authority.ownerUserId,
    sequence: 2,
    stepIndex: 0,
    turnId: "resource-turn",
  },
  meta: { at: changes.at ?? "2026-11-06T12:00:01.000Z", id: "settled-event" },
  type: "approval.settled",
});
const proof: NativeTargetAuthOnlyApproval = {
  callId: "original-call",
  observedAt: "2026-11-06T12:00:01.000Z",
  outcome: "approved",
  planDigest,
  publicSessionId: owner.publicSessionId,
  requestId: "resource-request",
  responderPrincipalId: authority.ownerUserId,
  sourceDigest: resourcePlanDigest,
};
const fixture = (events: MessageStreamEvent[] = [requested(), settled()], complete = true) => ({
  assertOwner: vi.fn(async () => {}),
  historyOwner: structuredClone(historyOwner),
  operationRef,
  owner: structuredClone(owner),
  plan: structuredClone(plan),
  readHistory: vi.fn(async (start: number, observe: (event: MessageStreamEvent) => void) => {
    for (const event of events) {
      observe(event);
    }
    return {
      complete,
      nextNativeIndex: start + events.length,
      nativeTailIndex: Math.max(0, start + events.length - 1),
    };
  }),
  resourcePlanBytes: bytes(resourcePlan),
  resourcePlanDigest,
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
  if (kind === "schema-digest") {
    changed.resourcePlanDigest = nativeTargetAuthOnlySchemaEffectDigest(plan, plan.publishedSource);
  }
  if (kind === "operation") {
    changed.operationRef = "22222222-2222-4222-a222-222222222222";
  }
  if (kind === "target") {
    changed.resourcePlan.target.projectId = "other-project";
  }
  if (kind === "resource") {
    changed.resourcePlan.authDatabase.database = "other";
  }
  if (kind === "source") {
    changed.planDigest = "f".repeat(64);
  }
  if (kind === "extra-field") {
    Object.assign(changed.resourcePlan, { appDatabase: { database: "not-approved" } });
  }
  const events = [
    requested({
      input: changed,
      ...(kind === "project-tool" ? { toolName: "prepare-app-native-target-auth-only" } : {}),
    }),
    settled(kind === "unmatched-settlement" ? { requestId: "other" } : {}),
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
    if (kind === "digest") {
      f.resourcePlanDigest = "f".repeat(64);
    }
    if (kind === "owner") {
      f.owner.authority.ownerUserId = "foreign";
    }
    if (kind === "session") {
      f.owner.publicSessionId = "foreign";
    }
    if (kind === "adapter") {
      f.owner.adapterGeneration = 2;
    }
    if (kind === "scope") {
      changed.target.scopeId = "foreign";
    }
    if (kind === "second-resource") {
      changed.effects.push({ id: "app-resource", kind: "resources", resourceId: "app-db" });
    }
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
    requested({ callId: "retry-call", requestId: "retry-request" }),
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
        requested({ callId: "second-call", requestId: "second" }),
        settled({ requestId: "second" }),
      ]),
    ),
  ).rejects.toThrow();
});

it("uses the retained original settlement when a retry has a different call ID", async () => {
  const f = fixture([
    requested(),
    settled(),
    requested({ callId: "retry-call", requestId: "retry" }),
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
    if (kind === "different-request") {
      retained.requestId = "other";
    }
    if (kind === "different-time") {
      retained.observedAt = "2026-11-06T12:00:02.000Z";
    }
    if (kind === "wrong-resource") {
      retained.sourceDigest = "f".repeat(64);
    }
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
      idempotencyKey: plan.appId,
      planDigest: resourcePlanDigest,
      planRef: operationRef,
    });
    const resumed = fixture([]);
    await expect(
      readPrivateNativeTargetAuthOnlyResourceApproval({
        ...resumed,
        observation: { save, state: saved },
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
      observation: { save, state: saved },
    }),
  ).resolves.toBeNull();
  expect(resumed.readHistory).toHaveBeenCalledWith(0, expect.any(Function));
});

it("withholds approval after owner loss and snapshots caller inputs before awaiting", async () => {
  const lost = fixture();
  lost.assertOwner
    .mockImplementationOnce(async () => {})
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
