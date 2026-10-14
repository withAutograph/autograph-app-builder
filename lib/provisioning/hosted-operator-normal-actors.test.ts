/* oxlint-disable eslint/require-await -- Test authority callbacks mirror asynchronous journal ports. */
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import {
  prepareNormalActorAccounts,
  prepareNormalActorMemberships,
} from "./hosted-operator-normal-actors";
import type {
  NormalActorAccountPorts,
  NormalActorPreparationPorts,
} from "./hosted-operator-normal-actors";
import {
  assertNormalActorState,
  initialNormalActorState,
  normalActorProgramSchema,
  proposeResolvedNormalActorAccess,
  resolvedNormalActorAccess,
} from "./hosted-operator-normal-actor-program";
import type { NormalActorProgram } from "./hosted-operator-normal-actor-program";
import {
  decryptNormalActorState,
  encryptNormalActorState,
} from "./hosted-operator-normal-actor-state";

const operationRef = "8b2b0941-c702-4ac7-8a9e-1a2bf1a8dc73";
const program: NormalActorProgram = {
  version: 1,
  appId: "spend-review",
  origin: "https://normal-actors.example.com",
  actors: [
    {
      actorKey: "owner",
      email: "owner@example.com",
      name: "Owner",
      account: "create-email-password",
    },
    { actorKey: "peer", email: "peer@example.com", name: "Peer", account: "create-email-password" },
  ],
  organizations: [{ organizationId: "org-one", ownerActorKey: "owner", name: "One", slug: "one" }],
  memberships: [
    { actorKey: "owner", organizationId: "org-one", role: "owner" },
    { actorKey: "peer", organizationId: "org-one", role: "member" },
  ],
  appAccess: [{ actorKey: "peer", organizationId: "org-one", roles: ["requester"] }],
};

const fixture = (
  options: { loseFirstSignupReply?: boolean; loseFirstInvitationReply?: boolean } = {},
) => {
  // Installed Better Auth memory storage is isolated source behavior evidence, never hosted proof.
  const auth = betterAuth({
    secret: "isolated-source-auth-secret-at-least-32-bytes",
    baseURL: program.origin,
    emailAndPassword: { enabled: true },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: proposal }) => ({
            data: { ...proposal, id: "org-one" },
          }),
        },
      }),
    ],
    logger: { disabled: true },
  });
  let state = initialNormalActorState(program, operationRef);
  const requests: string[] = [];
  let loseReply = options.loseFirstSignupReply ?? false;
  let loseInvitation = options.loseFirstInvitationReply ?? false;
  const privateFetch: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    requests.push(new URL(request.url).pathname);
    const response = await auth.handler(request);
    if (loseReply && new URL(request.url).pathname === "/api/auth/sign-up/email") {
      loseReply = false;
      throw new Error("Simulated transport failure after normal account creation");
    }
    if (
      loseInvitation &&
      new URL(request.url).pathname === "/api/auth/organization/invite-member"
    ) {
      loseInvitation = false;
      throw new Error("Simulated transport failure after normal invitation creation");
    }
    return response;
  };
  const ports: NormalActorAccountPorts = {
    assertCurrent: async () => {},
    checkpoint: async (next) => {
      state = structuredClone(next);
    },
    readCapturedActor: async () => null,
    clientFactory: (input) =>
      createHostedOperatorNormalAuthClient({ ...input, fetch: privateFetch }),
  };
  return { auth, ports, requests, getState: () => state };
};

describe("normal actor preparation", () => {
  it("stops before requests or credential checkpoints when the first program approval is missing", async () => {
    const local = fixture();
    local.ports.assertCurrent = async () => {
      throw new Error("approval_required");
    };
    await expect(
      prepareNormalActorAccounts({ program, operationRef, ports: local.ports }),
    ).rejects.toThrow("approval_required");
    expect(local.requests).toEqual([]);
    expect(local.getState().actors.every((actor) => actor.credentials === undefined)).toBe(true);
  });

  it("recovers a lost real signup reply using retained credentials and the same actual account", async () => {
    const local = fixture({ loseFirstSignupReply: true });
    await expect(
      prepareNormalActorAccounts({ program, operationRef, ports: local.ports }),
    ).rejects.toThrow("transport_failed");
    const interrupted = local.getState();
    expect(interrupted.actors[0]?.signup).toBe("attempted");
    expect(interrupted.actors[0]?.credentials?.password.length).toBeGreaterThanOrEqual(32);
    const resumed = await prepareNormalActorAccounts({
      program,
      operationRef,
      ports: local.ports,
      state: interrupted,
    });
    expect(
      resumed.state.actors.every(
        (actor) =>
          actor.signup === "complete" &&
          actor.session !== undefined &&
          (actor.storageState?.cookies.length ?? 0) > 0,
      ),
    ).toBe(true);
    expect(local.requests.filter((path) => path === "/api/auth/sign-up/email")).toHaveLength(2);
    expect(local.requests.filter((path) => path === "/api/auth/sign-in/email")).toHaveLength(1);
    expect(local.requests.some((path) => path.includes("organization"))).toBe(false);
    expect(resumed.proposedAccess[0]?.actorId).toBe(resumed.state.actors[1]?.session?.actorId);
    expect(() => resolvedNormalActorAccess(program, resumed.state)).toThrow(
      "preparation_incomplete",
    );
  });

  it("re-authenticates a completed created actor with the retained password and never repeats signup", async () => {
    const local = fixture();
    const first = await prepareNormalActorAccounts({ program, operationRef, ports: local.ports });
    const revoked = structuredClone(first.state);
    revoked.actors[0].storageState = { cookies: [], origins: [] };
    const resumed = await prepareNormalActorAccounts({
      program,
      operationRef,
      ports: local.ports,
      state: revoked,
    });
    expect(resumed.state.actors[0]?.session?.actorId).toBe(first.state.actors[0]?.session?.actorId);
    expect(local.requests.filter((path) => path === "/api/auth/sign-up/email")).toHaveLength(2);
    expect(local.requests.filter((path) => path === "/api/auth/sign-in/email")).toHaveLength(1);
  });

  it("requires ordinary reconnection for an expired existing capture instead of creating an account", async () => {
    const local = fixture();
    const first = await prepareNormalActorAccounts({ program, operationRef, ports: local.ports });
    const existingProgram = normalActorProgramSchema.parse({
      ...program,
      actors: program.actors.map((actor) => ({ ...actor, account: "capture-existing" })),
    });
    const existing = initialNormalActorState(existingProgram, operationRef);
    existing.actors = first.state.actors.map((actor) => ({
      ...actor,
      credentials: undefined,
      storageState: { cookies: [], origins: [] },
    }));
    const before = local.requests.length;
    await expect(
      prepareNormalActorAccounts({
        program: existingProgram,
        operationRef,
        ports: local.ports,
        state: existing,
      }),
    ).rejects.toThrow("capture_required");
    expect(local.requests.slice(before).every((path) => path === "/api/auth/get-session")).toBe(
      true,
    );
  });

  it("requires resolved-ID public approval before the organization or invitation stage", async () => {
    const local = fixture();
    const first = await prepareNormalActorAccounts({ program, operationRef, ports: local.ports });
    const effects: string[] = [];
    const ports: NormalActorPreparationPorts = {
      ...local.ports,
      assertMembershipApproved: async () => {
        throw new Error("resolved_approval_required");
      },
      readOrganizationOwnerProof: async () => {
        effects.push("proof");
        return null;
      },
      reconcileOrganization: async () => {
        effects.push("readback");
        return "absent";
      },
      prepareOrganization: async () => {
        effects.push("prepare");
      },
    };
    const before = local.requests.length;
    await expect(
      prepareNormalActorMemberships({ program, operationRef, state: first.state, ports }),
    ).rejects.toThrow("resolved_approval_required");
    expect(effects).toEqual([]);
    expect(local.requests.slice(before)).toEqual([]);
  });

  it("reconciles a lost real invitation reply without resending and verifies normal acceptance", async () => {
    const local = fixture({ loseFirstInvitationReply: true });
    const prepared = await prepareNormalActorAccounts({
      program,
      operationRef,
      ports: local.ports,
    });
    let organizationPrepared = false;
    const ports: NormalActorPreparationPorts = {
      ...local.ports,
      assertMembershipApproved: async () => {},
      // Synthetic signed-proof and fixed-worker boundaries test orchestration, not Gateway/SQL authority.
      readOrganizationOwnerProof: async (session) => ({
        actorId: session.actorId,
        realmSessionId: session.realmSessionId,
        reference: "isolated-proof-reference",
        sha256: "a".repeat(64),
      }),
      prepareOrganization: async ({ owner }) => {
        await local.auth.api.createOrganization({
          body: { name: "One", slug: "one", userId: owner.actorId },
        });
        organizationPrepared = true;
      },
      reconcileOrganization: async () => (organizationPrepared ? "applied" : "absent"),
    };
    await expect(
      prepareNormalActorMemberships({ program, operationRef, ports, state: prepared.state }),
    ).rejects.toThrow("transport_failed");
    const interrupted = local.getState();
    expect(interrupted.memberships[1]?.status).toBe("attempted");
    expect(interrupted.memberships[1]?.invitationId).toBeUndefined();
    const resumed = await prepareNormalActorMemberships({
      program,
      operationRef,
      ports,
      state: interrupted,
    });
    expect(resumed.state.memberships.every((member) => member.status === "complete")).toBe(true);
    expect(
      local.requests.filter((path) => path === "/api/auth/organization/invite-member"),
    ).toHaveLength(1);
    expect(
      local.requests.filter((path) => path === "/api/auth/organization/accept-invitation"),
    ).toHaveLength(1);
    expect(resolvedNormalActorAccess(program, resumed.state)).toEqual(resumed.proposedAccess);
    await prepareNormalActorMemberships({ program, operationRef, ports, state: resumed.state });
    expect(
      local.requests.filter((path) => path === "/api/auth/organization/invite-member"),
    ).toHaveLength(1);
    expect(
      local.requests.filter((path) => path === "/api/auth/organization/accept-invitation"),
    ).toHaveLength(1);
  });

  it("rejects swapped actual identities and extra membership authority in retained state", async () => {
    const local = fixture();
    const prepared = await prepareNormalActorAccounts({
      program,
      operationRef,
      ports: local.ports,
    });
    const swapped = structuredClone(prepared.state);
    swapped.actors[1].session = swapped.actors[0].session;
    expect(() => assertNormalActorState(program, swapped, operationRef)).toThrow(
      "program_mismatch",
    );
    const extra = structuredClone(prepared.state);
    extra.memberships.push({
      actorKey: "peer",
      organizationId: "unapproved-org",
      role: "owner",
      status: "complete",
    });
    expect(() => proposeResolvedNormalActorAccess(program, extra)).toThrow("program_mismatch");
  });

  it("binds encrypted normal credentials to owner, session, operation and approved program", () => {
    const scope = {
      authority: {
        issuer: "https://builder.example.com/api/auth",
        audience: "https://builder.example.com/mcp",
        ownerUserId: "owner-user",
        workspaceId: "workspace-one",
      },
      ownerSessionId: "builder-session",
      operationRef,
      program,
      config: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "test-v1" },
    };
    const state = initialNormalActorState(program, operationRef);
    state.actors[0].credentials = { password: `synthetic-private-${"a".repeat(32)}` };
    const sealed = encryptNormalActorState({ ...scope, state });
    expect(JSON.stringify(sealed)).not.toContain(state.actors[0].credentials.password);
    expect(decryptNormalActorState({ ...scope, sealed }).actors[0]?.credentials).toEqual(
      state.actors[0]?.credentials,
    );
    expect(() =>
      decryptNormalActorState({ ...scope, sealed, ownerSessionId: "other-session" }),
    ).toThrow("state_unavailable");
    expect(() =>
      decryptNormalActorState({
        ...scope,
        sealed,
        authority: { ...scope.authority, ownerUserId: "other-owner" },
      }),
    ).toThrow("state_unavailable");
    expect(() =>
      decryptNormalActorState({ ...scope, sealed, program: { ...program, appId: "other-app" } }),
    ).toThrow("state_unavailable");
  });
});
