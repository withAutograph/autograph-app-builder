/* oxlint-disable eslint/require-await -- Controlled adapters implement the asynchronous owner and native-store ports. */
import { describe, expect, it, vi } from "vitest";
import { createAppAccessOwnerResolver } from "./owner";
import { createAppAccessRouteHandler } from "./route";
import type { AppAccessSnapshot, AppAccessCommand } from "./contracts";
import type { AppAccessOwner } from "./operator-client";
import type { HostedSessionTenantAuthority } from "../hosted/session-authority";
import { InMemoryHostedEveStore, durableHostedSessionRecordSchema } from "../eve/hosted-store";
import { createHostedOperatorOwnerContextResolver } from "../provisioning/hosted-operator-owner-context";
import { readCanonicalAppOwnerSession } from "../provisioning/hosted-operator-owner";

const origin = "https://builder.test";
const authority = {
  issuer: `${origin}/api/auth`,
  audience: `${origin}/mcp`,
  ownerUserId: "creator",
  workspaceId: "workspace",
};
const principal = { ...authority, scopes: ["autograph:session"] };
const workloadPolicy = {
  issuer: "https://oidc.vercel.com",
  audience: "https://vercel.com/team/project",
  subject: "team/project/production",
  environment: "production" as const,
  ownerId: "team",
  projectId: "project",
};

const createRecoveredBuild = async (store: InMemoryHostedEveStore, appId: string, at: number) => {
  const original = durableHostedSessionRecordSchema.parse({
    version: 2,
    appId,
    sessionId: `${appId}-original`,
    adapterSessionId: `${appId}-root-run`,
    originAdapterSessionId: `${appId}-root-run`,
    adapterGeneration: 1,
    principal,
    createdAtEpochMs: at,
    updatedAtEpochMs: at + 1,
    lastProgressAtEpochMs: at + 1,
    title: appId,
    status: "failed",
    stage: "needs_attention",
    resumability: "terminal",
  });
  const initial = {
    version: 1 as const,
    kind: "start" as const,
    clientRequestId: `${appId}-initial`,
    operationId: `${appId}-initial-operation`,
    requestDigest: `sha256:${"a".repeat(64)}`,
    principal,
    state: "reserved" as const,
    createdAtEpochMs: at,
    updatedAtEpochMs: at,
  };
  await store.reserveOperation(principal, initial);
  await store.settleSucceeded({
    principal,
    operationId: initial.operationId,
    requestDigest: initial.requestDigest,
    nowEpochMs: at + 1,
    session: original,
    result: { cursor: 0, events: [], sessionId: original.sessionId, status: "failed" },
  });
  const descriptor = {
    version: 1 as const,
    operationId: `${appId}-recovery-operation`,
    sourcePublicSessionId: original.sessionId,
    sourceOwnerRunId: original.adapterSessionId,
    sourceAdapterGeneration: original.adapterGeneration,
    originalAuthoritySessionId: original.sessionId,
    logicalSessionId: original.adapterSessionId,
    parentCancellationRevision: 0,
  };
  const binding = {
    ...descriptor,
    ownerRunId: `${appId}-current-run`,
    provenance: {
      kind: "committed-turn-output" as const,
      sourceStepId: `${appId}-step`,
      sourceEventId: `${appId}-event`,
      sourceSlot: 1,
      checkpointVersion: 1 as const,
    },
  };
  const operation = {
    ...initial,
    operationId: descriptor.operationId,
    clientRequestId: `${appId}-recovery`,
    nativeRecovery: descriptor,
    resumeSessionId: original.sessionId,
    createdAtEpochMs: at + 2,
    updatedAtEpochMs: at + 2,
  };
  await store.reserveOperation(principal, operation);
  await store.commitNativeRecoveryReceipt({
    principal,
    descriptor,
    recoveryBinding: binding,
    nowEpochMs: at + 2,
  });
  const child = durableHostedSessionRecordSchema.parse({
    ...original,
    sessionId: `${appId}-child`,
    parentSessionId: original.sessionId,
    adapterSessionId: binding.ownerRunId,
    originAdapterSessionId: binding.ownerRunId,
    nativeRecoveryBinding: binding,
    createdAtEpochMs: at + 3,
    updatedAtEpochMs: at + 3,
    lastProgressAtEpochMs: at + 3,
    status: "waiting",
    stage: "ready",
    resumability: "live",
  });
  await store.settleSucceeded({
    principal,
    operationId: operation.operationId,
    requestDigest: operation.requestDigest,
    nowEpochMs: at + 3,
    session: child,
    result: { cursor: 0, events: [], sessionId: child.sessionId, status: "waiting" },
  });
  return { original, child };
};

const fixture = async () => {
  const sessions = new InMemoryHostedEveStore();
  const selected = await createRecoveredBuild(sessions, "requests", 1);
  const unrelated = await createRecoveredBuild(sessions, "expenses", 100);
  let signedIn: HostedSessionTenantAuthority | null = authority;
  let activeMember = true;
  const handoffs = {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Direct build fixtures have no prepared handoff.
    read: async () => undefined,
  };
  const resolveOwner = createAppAccessOwnerResolver({
    sessions,
    authenticate: async () => signedIn,
    resolveOwnerContext: createHostedOperatorOwnerContextResolver({
      sessions,
      handoffs,
      issuer: authority.issuer,
      audience: authority.audience,
      isActiveMember: async () => activeMember,
    }),
  });
  const reads: AppAccessOwner[] = [];
  const read = async (owner: AppAccessOwner): Promise<AppAccessSnapshot> => {
    const canonical = await readCanonicalAppOwnerSession(
      {
        eve: sessions,
        handoffs,
        membership: { isMember: async () => activeMember },
        workloadPolicy,
      },
      {
        authority: owner.ownerContext.authority,
        ownerContext: owner.ownerContext,
        target: { appId: owner.appId, sessionId: owner.sessionId },
      },
    );
    expect(canonical.sessionId).toBe(selected.original.sessionId);
    expect(canonical.adapterSessionId).toBe(selected.child.adapterSessionId);
    reads.push(owner);
    return {
      sessionId: canonical.sessionId,
      appId: owner.appId,
      appName: "Requests",
      organizationName: "Dev",
      canManage: true,
      roles: [],
      members: [],
      invitations: [],
      creator: { status: "setting_up" },
    };
  };
  const execute = vi.fn(
    async (owner: AppAccessOwner, _command: AppAccessCommand) => await read(owner),
  );
  const route = createAppAccessRouteHandler({ origin, resolveOwner, read, execute });
  return {
    selected,
    unrelated,
    sessions,
    resolveOwner,
    route,
    reads,
    execute,
    setSignedIn: (value: HostedSessionTenantAuthority | null) => {
      signedIn = value;
    },
    revoke: () => {
      activeMember = false;
    },
  };
};
const request = (sessionId: string) =>
  new Request(`${origin}/api/builder/sessions/${sessionId}/access`);

describe("recovered web app access owner", () => {
  it.each(["original", "child"] as const)(
    "opens the %s handle using its own original grant and current physical worker",
    async (handle) => {
      const f = await fixture();
      const requested = f.selected[handle].sessionId;
      const originalBefore = await f.sessions.getSession(principal, f.selected.original.sessionId);
      const response = await f.route(request(requested), requested);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ appId: "requests", sessionId: requested });
      expect(f.reads[0]).toMatchObject({
        appId: "requests",
        sessionId: f.selected.original.sessionId,
        ownerContext: {
          sessionId: f.selected.original.sessionId,
          adapterSessionId: f.selected.child.adapterSessionId,
          principal,
        },
      });
      expect(f.reads[0]?.sessionId).not.toBe(f.unrelated.original.sessionId);
      expect(await f.sessions.getSession(principal, f.selected.original.sessionId)).toEqual(
        originalBefore,
      );
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps a recovered command's request identity and original operator scope", async () => {
    const f = await fixture();
    const { sessionId } = f.selected.child;
    const command = {
      action: "retry-setup",
      clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const response = await f.route(
      new Request(request(sessionId), {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
      sessionId,
    );
    expect(response.status).toBe(200);
    expect(f.execute).toHaveBeenCalledTimes(1);
    const [call] = f.execute.mock.calls;
    expect(call?.[0]).toMatchObject({
      sessionId: f.selected.original.sessionId,
      ownerContext: { adapterSessionId: f.selected.child.adapterSessionId },
    });
    expect(call?.[1]).toEqual(command);
    expect(await response.json()).toMatchObject({ sessionId });
  });

  it.each([
    { ...authority, ownerUserId: "another-user" },
    { ...authority, workspaceId: "another-workspace" },
    { ...authority, issuer: "https://another.test/api/auth" },
  ])("denies another authenticated owner or tenant", async (signedIn) => {
    const f = await fixture();
    f.setSignedIn(signedIn);
    const { sessionId } = f.selected.child;
    const response = await f.route(request(sessionId), sessionId);
    expect(response.status).toBe(403);
    expect(f.reads).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("requires an authenticated Builder account", async () => {
    const f = await fixture();
    f.setSignedIn(null);
    const { sessionId } = f.selected.child;
    const response = await f.route(request(sessionId), sessionId);
    expect(response.status).toBe(401);
    expect(f.reads).toEqual([]);
  });

  it("rechecks membership before disclosing an access snapshot", async () => {
    const f = await fixture();
    const read = vi.fn(async () => {
      f.revoke();
      return {
        sessionId: f.selected.original.sessionId,
        appId: "requests",
        appName: "Requests",
        organizationName: "Dev",
        canManage: true,
        roles: [],
        members: [],
        invitations: [],
        creator: { status: "setting_up" as const },
      };
    });
    const route = createAppAccessRouteHandler({
      origin,
      resolveOwner: f.resolveOwner,
      read,
      execute: f.execute,
    });
    const { sessionId } = f.selected.child;
    const response = await route(request(sessionId), sessionId);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("organizationName");
  });

  it("refuses a cancelled current worker without falling back to the old original", async () => {
    const f = await fixture();
    await f.sessions.recordCancellationIntent({
      principal,
      sessionId: f.selected.child.sessionId,
      nowEpochMs: 200,
    });
    const { sessionId } = f.selected.original;
    const response = await f.route(request(sessionId), sessionId);
    expect(response.status).not.toBe(200);
    expect(f.reads).toEqual([]);
  });
});
