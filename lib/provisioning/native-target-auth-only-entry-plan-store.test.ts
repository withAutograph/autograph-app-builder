/* oxlint-disable eslint/require-await -- The simulated private store and history are deliberately async. */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { MessageStreamEvent } from "eve/client";
import { expect, it, vi } from "vitest";

import {
  readPrivateNativeTargetAuthOnlyEntryApproval,
  nativeTargetAuthOnlyEntryApprovalTool,
} from "../eve/private-native-target-auth-only-entry-approval";
import type { PrivateNativeTargetApprovalObservation } from "../eve/private-native-target-approval";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import {
  authOnlyOrganizationPlanSchema,
  authOnlySignupPolicyPlanSchema,
} from "./hosted-operator-sandbox-launcher";
import {
  createPostgresNativeTargetAuthOnlyEntryPlanStore,
  encodeNativeTargetAuthOnlyEntryPlan,
} from "./native-target-auth-only-entry-plan-store";
import type {
  NativeTargetAuthOnlyEntryApprovalInput,
  NativeTargetAuthOnlyEntryPlanKey,
} from "./native-target-auth-only-entry-plan-store";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "pilot-owner",
  workspaceId: "pilot-workspace",
};
const key = {
  appId: "signup-pilot",
  authResourceId: "isolated-auth",
  authority,
  deliveryOperationRef: "11111111-1111-4111-a111-111111111111",
  deliveryPlanDigest: "a".repeat(64),
  effect: "organization",
  ownerProofSha256: "c".repeat(64),
  resourcePlanDigest: "b".repeat(64),
  sessionId: "saved-session",
} satisfies NativeTargetAuthOnlyEntryPlanKey;
const signupKey = { ...key, effect: "signup-policy" } satisfies NativeTargetAuthOnlyEntryPlanKey;
const historyOwner = operatorOwnerContextSchema.parse({
  adapterGeneration: 1,
  adapterSessionId: "saved-adapter",
  authority,
  kind: "direct",
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: key.sessionId,
});
const at = "2026-11-06T12:00:00.000Z";
const issuer = "https://pilot.example";
const gatewayOrigin = "https://immutable-gateway.example";
const jwksUrl = `${gatewayOrigin}/_platform/jwks.json`;
const planBase = {
  action: "prepare",
  authDatabase: {
    database: "pilot_auth",
    migratorRole: "pilot_migrator",
    resourceId: key.authResourceId,
    runtimeRole: "pilot_runtime",
  },
  deploymentBoundary: {
    operator: { environment: "preview", projectId: "operator" },
    teamId: "team",
    verification: { gatewayOrigin, jwksUrl, publicOrigin: issuer },
  },
  neon: { branchId: "pilot-branch", endpoint: "ep-pilot.neon.tech", projectId: "pilot-project" },
  selection: { sessionId: key.sessionId, workspaceId: authority.workspaceId },
  version: 1,
};
const installer = { reference: "auth-owned-organization-v1", sha256: "e".repeat(64) };
const organizationPlan = authOnlyOrganizationPlanSchema.parse({
  ...planBase,
  authMembership: {
    actorId: "realm-owner",
    bootstrapPlanDigest: key.resourcePlanDigest,
    identityCapture: { capturedAt: at, realmSessionId: "realm-session" },
    identityNonceSha256: "d".repeat(64),
    identityProof: { reference: "private-reference", sha256: key.ownerProofSha256 },
    identityVerification: {
      audience: "https://operator.example",
      issuer,
      jwksUrl,
      transportSource: {
        audience: "https://vercel.com/team",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "operator",
      },
    },
    kind: "create-owned-organization",
    name: "Pilot",
    organizationId: "pilot-org",
    slug: "pilot",
  },
  effects: [{ id: "auth-membership", kind: "auth-membership", resourceId: key.authResourceId }],
  membershipInstaller: installer,
});
const privateAlias = "pilot-only@example.test";
const signupPlan = authOnlySignupPolicyPlanSchema.parse({
  ...planBase,
  authSignupPolicy: {
    allowedEmails: [privateAlias],
    appId: key.appId,
    appPath: "/app",
    appRoles: ["pilot_user"],
    authResourceId: key.authResourceId,
    eligibility: "approved-email",
    membershipRole: "member",
    organizationId: "pilot-org",
    origin: issuer,
    policyId: "pilot-policy",
    version: 1,
  },
  effects: [
    { id: "auth-signup-policy", kind: "auth-signup-policy", resourceId: key.authResourceId },
  ],
  normalActorProgram: {
    appAccess: [{ appId: key.appId, organizationId: "pilot-org", roles: ["pilot_user"] }],
    appId: key.appId,
    organizations: [{ organizationId: "pilot-org" }],
    origin: issuer,
  },
  signupPolicyInstaller: installer,
});
const organizationBytes = encodeNativeTargetAuthOnlyEntryPlan(key, organizationPlan);
const signupBytes = encodeNativeTargetAuthOnlyEntryPlan(signupKey, signupPlan);
const requested = (
  input: NativeTargetAuthOnlyEntryApprovalInput,
  requestId = "request",
  callId = "call",
): MessageStreamEvent => ({
  data: {
    requests: [
      {
        kind: "tool-approval",
        requestId,
        prompt: "Approve the retained Auth step",
        action: {
          kind: "tool-call",
          callId,
          toolName: nativeTargetAuthOnlyEntryApprovalTool,
          input,
        },
      },
    ],
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
  },
  meta: { at, id: requestId },
  type: "input.requested",
});
const settled = (
  requestId = "request",
  responderPrincipalId = authority.ownerUserId,
  outcome: "approved" | "cancelled" = "approved",
): MessageStreamEvent => ({
  data: { outcome, requestId, responderPrincipalId, sequence: 2, stepIndex: 0, turnId: "turn" },
  meta: { at, id: "settlement" },
  type: "approval.settled",
});
const fixture = () => {
  interface Row {
    requestId: string;
    requestDigest: string;
    state: string;
    revision: number;
    record: object;
  }
  const rows = new Map<string, Row>();
  const dialect = new PgDialect();
  const select = (predicate: SQL) => ({
    limit: async () => {
      const requestId = dialect.sqlToQuery(predicate).params[4];
      const row = rows.get(String(requestId));
      return row === undefined ? [] : [structuredClone(row)];
    },
  });
  const insert = (row: Row) => ({
    onConflictDoNothing: async () => {
      expect(row.requestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(row.state).toBe("pending");
      if (!rows.has(row.requestId)) {
        rows.set(row.requestId, structuredClone(row));
      }
    },
  });
  const update = (next: Pick<Row, "state" | "revision" | "record">, predicate: SQL) => ({
    returning: async () => {
      const values = dialect.sqlToQuery(predicate).params;
      const [requestId, expectedRevision, expectedDigest] = values.slice(4);
      const row = rows.get(String(requestId));
      if (
        row === undefined ||
        row.revision !== expectedRevision ||
        row.requestDigest !== expectedDigest
      ) {
        return [];
      }
      expect(["pending", "settled"]).toContain(next.state);
      const saved = { ...row, ...next };
      rows.set(saved.requestId, structuredClone(saved));
      return [structuredClone(saved)];
    },
  });
  const db = {
    insert: () => ({ values: insert }),
    select: () => ({ from: () => ({ where: select }) }),
    update: () => ({
      set: (next: Pick<Row, "state" | "revision" | "record">) => ({
        where: (predicate: SQL) => update(next, predicate),
      }),
    }),
  };
  const assertCurrentOwner = vi.fn(async () => {});
  const store = createPostgresNativeTargetAuthOnlyEntryPlanStore({
    // SAFETY: The fixture models the exact Drizzle calls and applies the emitted CAS predicates.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    database: db as never,
    assertCurrentOwner,
  });
  const read = async (
    selected: NativeTargetAuthOnlyEntryPlanKey,
    approvalInput: NativeTargetAuthOnlyEntryApprovalInput,
    events: MessageStreamEvent[],
    state?: PrivateNativeTargetApprovalObservation,
    complete = true,
    save = vi.fn(async (_state: PrivateNativeTargetApprovalObservation) => {}),
  ) =>
    readPrivateNativeTargetAuthOnlyEntryApproval({
      approvalInput,
      assertCurrentOwner,
      historyOwner,
      key: selected,
      observation: { save, state },
      readHistory: async (startIndex, observe) => {
        for (const event of events) {
          observe(event);
        }
        const nextNativeIndex = startIndex + events.length;
        return { complete, nextNativeIndex, nativeTailIndex: Math.max(0, nextNativeIndex - 1) };
      },
      store,
    });
  return { read, store };
};

it("retains separate exact children and exposes only digest-bound approval identifiers", async () => {
  const { store, read } = fixture();
  const organization = await store.retain(key, organizationBytes);
  const signup = await store.retain(signupKey, signupBytes);
  expect(await store.retain(key, organizationBytes)).toEqual(organization);
  expect(organization.approvalInput.childOperationRef).not.toBe(
    signup.approvalInput.childOperationRef,
  );
  expect(JSON.stringify(signup.approvalInput)).not.toContain(privateAlias);
  const orgEvents = [requested(organization.approvalInput), settled()];
  await expect(read(signupKey, signup.approvalInput, orgEvents)).resolves.toBeNull();
  await expect(
    read(signupKey, signup.approvalInput, [
      ...orgEvents,
      requested(signup.approvalInput, "signup-request", "signup-call"),
      settled("signup-request"),
    ]),
  ).resolves.toMatchObject({
    callId: "signup-call",
    sourceDigest: signup.approvalInput.childPlanDigest,
  });
  await expect(read(key, signup.approvalInput, orgEvents)).rejects.toMatchObject({
    code: "authorization_required",
  });
  await expect(read(key, organization.approvalInput, orgEvents)).resolves.toMatchObject({
    callId: "call",
    outcome: "approved",
    planDigest: key.deliveryPlanDigest,
    requestId: "request",
    sourceDigest: organization.approvalInput.childPlanDigest,
  });
  await expect(
    store.retain(
      key,
      encodeNativeTargetAuthOnlyEntryPlan(key, {
        ...organizationPlan,
        authMembership: { ...organizationPlan.authMembership, name: "Changed after retention" },
      }),
    ),
  ).rejects.toMatchObject({ code: "resource_mismatch" });
});

it("checks a complete authenticated tail and rejects another owner or duplicate approvals", async () => {
  const { store, read } = fixture();
  const { approvalInput } = await store.retain(key, organizationBytes);
  await expect(
    read(key, approvalInput, [requested(approvalInput), settled("request", "foreign")]),
  ).rejects.toMatchObject({ code: "authorization_required" });
  await expect(
    read(key, approvalInput, [
      requested(approvalInput),
      settled(),
      requested(approvalInput, "another-request", "another-call"),
      settled("another-request"),
    ]),
  ).rejects.toThrow("ambiguous");
  const save = vi.fn(async (_state: PrivateNativeTargetApprovalObservation) => {});
  await expect(
    read(key, approvalInput, [requested(approvalInput), settled()], undefined, false, save),
  ).rejects.toThrow();
  const state = save.mock.calls[0]?.[0];
  expect(state?.native.nextNativeIndex).toBe(2);
  await expect(read(key, approvalInput, [], state)).resolves.toMatchObject({ outcome: "approved" });
});

it("permits one dispatch, records only the exact checkpoint, and denies cancelled retries", async () => {
  const { store, read } = fixture();
  const { approvalInput } = await store.retain(key, organizationBytes);
  const req = requested(approvalInput);
  const approval = await read(key, approvalInput, [req, settled()]);
  expect(approval).not.toBeNull();
  if (approval === null) {
    throw new Error("Expected an authenticated settlement");
  }
  await store.settle(key, approval);
  const assertLease = vi.fn(async () => {});
  const first = await store.openApprovedEffect(key, approval, assertLease);
  const second = await store.openApprovedEffect(key, approval, assertLease);
  const results = await Promise.all([first.claimFirstDispatch(), second.claimFirstDispatch()]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const winner = results[0] ? first : second;
  const loser = winner === first ? second : first;
  const contextDigest = "f".repeat(64);
  await expect(loser.bindWorkerContext({ contextDigest })).rejects.toMatchObject({
    code: "authorization_required",
  });
  const checkpoint = await winner.bindWorkerContext({ contextDigest });
  const frame = {
    contextDigest,
    effectId: "auth-membership",
    fenceGeneration: winner.fenceGeneration,
    operationId: winner.operationRef,
    receipt: { readbackSha256: "0".repeat(64), state: "applied" as const },
    resourceId: key.authResourceId,
    sequence: 1,
    tenantId: null,
  };
  await expect(checkpoint({ ...frame, effectId: "auth-signup-policy" })).rejects.toMatchObject({
    code: "resource_mismatch",
  });
  await checkpoint(frame);
  await checkpoint(frame);
  const saved = await store.read(key);
  expect(saved?.record.checkpoint).toEqual(frame);
  expect(await loser.claimFirstDispatch()).toBe(false);
  const cancellation = await read(key, approvalInput, [
    req,
    settled(),
    settled("request", authority.ownerUserId, "cancelled"),
  ]);
  expect(cancellation?.outcome).toBe("cancelled");
  if (cancellation === null) {
    throw new Error("Expected authenticated cancellation");
  }
  await store.settle(key, cancellation);
  await expect(winner.assertCurrent()).rejects.toMatchObject({ code: "authorization_required" });
});
