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
    cancellationRevision: 2,
    resumedCancellationRevision: 2,
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
    parentCancellationRevision: original.cancellationRevision ?? 0,
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
    cancellationRevision: 1,
    resumedCancellationRevision: 1,
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
  return { child, original };
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
  const canonicalOwner = async (owner: AppAccessOwner) =>
    await readCanonicalAppOwnerSession(
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
  const read = async (owner: AppAccessOwner): Promise<AppAccessSnapshot> => {
    const canonical = await canonicalOwner(owner);
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
  const route = createAppAccessRouteHandler({ execute, origin, read, resolveOwner });
  return {
    canonicalOwner,
    execute,
    reads,
    resolveOwner,
    revoke: () => {
      activeMember = false;
    },
    route,
    selected,
    sessions,
    setSignedIn: (value: HostedSessionTenantAuthority | null) => {
      signedIn = value;
    },
    unrelated,
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
        ownerContext: {
          adapterSessionId: f.selected.child.adapterSessionId,
          principal,
          sessionId: f.selected.original.sessionId,
        },
        sessionId: f.selected.original.sessionId,
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
      ownerContext: { adapterSessionId: f.selected.child.adapterSessionId },
      sessionId: f.selected.original.sessionId,
    });
    expect(call?.[1]).toEqual(command);
    expect(await response.json()).toMatchObject({ sessionId });
  });

  it("uses the current worker's cancellation fence while preserving the original session key", async () => {
    const f = await fixture();
    const { child, original } = f.selected;
    const response = await f.route(request(child.sessionId), child.sessionId);
    expect(response.status).toBe(200);
    const [owner] = f.reads;
    if (owner === undefined) {
      throw new Error("Expected the recovered operator owner.");
    }
    await expect(f.canonicalOwner(owner)).resolves.toMatchObject({
      sessionId: original.sessionId,
      adapterSessionId: child.adapterSessionId,
      cancellationRevision: child.cancellationRevision,
      resumedCancellationRevision: child.resumedCancellationRevision,
    });
    await f.sessions.recordCancellationIntent({
      principal,
      sessionId: child.sessionId,
      nowEpochMs: child.updatedAtEpochMs + 1,
    });
    await expect(f.canonicalOwner(owner)).rejects.toThrow();
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
      execute: f.execute,
      origin,
      read,
      resolveOwner: f.resolveOwner,
    });
    const { sessionId } = f.selected.child;
    const response = await route(request(sessionId), sessionId);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("organizationName");
  });

  it("refuses a cancelled current worker without falling back to the old original", async () => {
    const f = await fixture();
    await f.sessions.recordCancellationIntent({
      nowEpochMs: 200,
      principal,
      sessionId: f.selected.child.sessionId,
    });
    const { sessionId } = f.selected.original;
    const response = await f.route(request(sessionId), sessionId);
    expect(response.status).not.toBe(200);
    expect(f.reads).toEqual([]);
  });
});
