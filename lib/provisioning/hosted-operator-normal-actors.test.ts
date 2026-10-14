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
  normalActorProgramDigest,
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
  options: {
    loseFirstSignupReply?: boolean;
    loseFirstInvitationReply?: boolean;
    program?: NormalActorProgram;
  } = {},
) => {
  const approvedProgram = options.program ?? program;
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
            data: {
              ...proposal,
              id: approvedProgram.organizations.find((entry) => entry.slug === proposal.slug)
                ?.organizationId,
            },
          }),
        },
      }),
    ],
    logger: { disabled: true },
  });
  let state = initialNormalActorState(approvedProgram, operationRef);
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
    readOrganizationSession: async () => null,
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
    expect(
      local.requests.filter((path) => path === "/api/auth/sign-in/email").length,
    ).toBeGreaterThanOrEqual(1);
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
    expect(
      local.requests.filter((path) => path === "/api/auth/sign-in/email").length,
    ).toBeGreaterThanOrEqual(1);
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

  it("prepares two organizations sequentially with distinct real sessions and no effects on the other target", async () => {
    const twoOrganizations = normalActorProgramSchema.parse({
      ...program,
      organizations: [
        ...program.organizations,
        { organizationId: "org-two", ownerActorKey: "owner", name: "Two", slug: "two" },
      ],
      memberships: [
        ...program.memberships,
        { actorKey: "owner", organizationId: "org-two", role: "owner" },
        { actorKey: "peer", organizationId: "org-two", role: "member" },
      ],
      appAccess: [
        ...program.appAccess,
        { actorKey: "peer", organizationId: "org-two", roles: ["requester"] },
      ],
    });
    const local = fixture({ program: twoOrganizations });
    const accounts = await prepareNormalActorAccounts({
      program: twoOrganizations,
      operationRef,
      ports: local.ports,
    });
    expect(
      accounts.state.organizationSessions?.every((entry) => entry.selection === "pending"),
    ).toBe(true);
    expect(local.requests.some((path) => path.includes("organization"))).toBe(false);
    const preparedOrganizations = new Set<string>();
    const effects: string[] = [];
    const ports: NormalActorPreparationPorts = {
      ...local.ports,
      assertMembershipApproved: async () => {},
      readOrganizationOwnerProof: async (session) => ({
        actorId: session.actorId,
        realmSessionId: session.realmSessionId,
        reference: `proof-${session.realmSessionId}`,
        sha256: "a".repeat(64),
      }),
      prepareOrganization: async ({ organizationId, owner }) => {
        effects.push(`prepare:${organizationId}`);
        const target = twoOrganizations.organizations.find(
          (entry) => entry.organizationId === organizationId,
        );
        if (!target) {
          throw new Error("Unapproved test organization");
        }
        await local.auth.api.createOrganization({
          body: { name: target.name, slug: target.slug, userId: owner.actorId },
        });
        preparedOrganizations.add(organizationId);
      },
      reconcileOrganization: async ({ organizationId }) => {
        effects.push(`read:${organizationId}`);
        return preparedOrganizations.has(organizationId) ? "applied" : "absent";
      },
    };
    const first = await prepareNormalActorMemberships({
      program: twoOrganizations,
      operationRef,
      state: accounts.state,
      ports,
      organizationId: "org-one",
    });
    expect(effects.every((effect) => effect.endsWith(":org-one"))).toBe(true);
    expect(
      first.state.memberships
        .filter((member) => member.organizationId === "org-two")
        .every((member) => member.status === "pending"),
    ).toBe(true);
    expect(
      first.state.organizationSessions
        ?.filter((entry) => entry.organizationId === "org-two")
        .every((entry) => entry.selection === "pending"),
    ).toBe(true);
    expect(first.proposedAccess.map((grant) => grant.organizationId)).toEqual([
      "org-one",
      "org-two",
    ]);
    expect(() => resolvedNormalActorAccess(twoOrganizations, first.state)).toThrow(
      "preparation_incomplete",
    );
    const firstSessions = structuredClone(
      first.state.organizationSessions?.filter((entry) => entry.organizationId === "org-one"),
    );
    effects.length = 0;
    const second = await prepareNormalActorMemberships({
      program: twoOrganizations,
      operationRef,
      state: first.state,
      ports,
      organizationId: "org-two",
    });
    expect(effects.every((effect) => effect.endsWith(":org-two"))).toBe(true);
    expect(
      second.state.organizationSessions?.filter((entry) => entry.organizationId === "org-one"),
    ).toEqual(firstSessions);
    expect(
      second.state.organizationSessions?.every(
        (entry) =>
          entry.selection === "selected" &&
          entry.session.activeOrganizationId === entry.organizationId,
      ),
    ).toBe(true);
    const peerContexts =
      second.state.organizationSessions?.filter((entry) => entry.actorKey === "peer") ?? [];
    expect(new Set(peerContexts.map((entry) => entry.session.realmSessionId)).size).toBe(2);
    await Promise.all(
      peerContexts.map(async (entry) => {
        const normal = await local.ports
          .clientFactory?.({
            origin: twoOrganizations.origin,
            storageState: entry.storageState,
            assertApprovedEffect: async () => {},
          })
          .getSession();
        expect(normal?.activeOrganizationId).toBe(entry.organizationId);
        expect(normal?.sessionId).toBe(entry.session.realmSessionId);
      }),
    );
    expect(resolvedNormalActorAccess(twoOrganizations, second.state)).toEqual(
      second.proposedAccess,
    );
    const before = local.requests.length;
    await expect(
      prepareNormalActorMemberships({
        program: twoOrganizations,
        operationRef,
        state: second.state,
        ports,
        organizationId: "unapproved",
      }),
    ).rejects.toThrow("program_mismatch");
    expect(local.requests.length).toBe(before);
  });

  it("does not treat a pending candidate as selected and rejects contradictory organization session evidence", async () => {
    const local = fixture();
    const prepared = await prepareNormalActorAccounts({
      program,
      operationRef,
      ports: local.ports,
    });
    const pending = prepared.state.organizationSessions?.at(0);
    if (!pending) {
      throw new Error("Missing actual normal session candidate");
    }
    expect(pending.selection).toBe("pending");
    expect(pending.session.activeOrganizationId).not.toBe(pending.organizationId);
    const contradictory = structuredClone(prepared.state);
    const candidate = contradictory.organizationSessions?.at(0);
    if (!candidate) {
      throw new Error("Missing candidate");
    }
    candidate.selection = "selected";
    expect(() => assertNormalActorState(program, contradictory, operationRef)).toThrow(
      "program_mismatch",
    );
    const duplicated = structuredClone(prepared.state);
    duplicated.organizationSessions?.push(pending);
    expect(() => assertNormalActorState(program, duplicated, operationRef)).toThrow(
      "program_mismatch",
    );
  });

  it("requires an additional real capture for an existing actor in another organization", async () => {
    const local = fixture();
    const actual = await prepareNormalActorAccounts({ program, operationRef, ports: local.ports });
    const owner = actual.state.actors.find((actor) => actor.actorKey === "owner");
    if (!owner?.session || !owner.storageState) {
      throw new Error("Missing ordinary authenticated owner");
    }
    const capturedProgram = normalActorProgramSchema.parse({
      ...program,
      actors: program.actors.map((actor) => ({ ...actor, account: "capture-existing" })),
      organizations: [
        ...program.organizations,
        { organizationId: "org-two", ownerActorKey: "owner", name: "Two", slug: "two" },
      ],
      memberships: [
        ...program.memberships,
        { actorKey: "owner", organizationId: "org-two", role: "owner" },
      ],
    });
    const additionalRequests: string[] = [];
    const ports: NormalActorAccountPorts = {
      ...local.ports,
      readCapturedActor: async (actorKey) => {
        const captured = actual.state.actors.find((actor) => actor.actorKey === actorKey);
        const session = captured?.session;
        const storageState = captured?.storageState;
        return session === undefined || storageState === undefined
          ? null
          : { session, storageState };
      },
      readOrganizationSession: async (actorKey, organizationId) => {
        additionalRequests.push(`${actorKey}:${organizationId}`);
        return null;
      },
    };
    await expect(
      prepareNormalActorAccounts({ program: capturedProgram, operationRef, ports }),
    ).rejects.toThrow("normal_actor_session_selection_required");
    expect(additionalRequests).toEqual(["owner:org-two"]);
    expect(
      local.getState().actors.find((actor) => actor.actorKey === "owner")?.credentials,
    ).toBeUndefined();
    expect(
      local
        .getState()
        .organizationSessions?.some(
          (entry) => entry.actorKey === "owner" && entry.organizationId === "org-two",
        ),
    ).toBe(false);
    expect(local.getState().organizations.every((entry) => entry.status === "pending")).toBe(true);
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

describe("internal actor save observation wrappers", () => {
  it("uses observations for save wrappers while retaining full outward guards and fallback behavior", async () => {
    const run = async (observed: boolean) => {
      const local = fixture();
      let full = 0;
      let observation = 0;
      let checkpoints = 0;
      const originalCheckpoint = local.ports.checkpoint;
      local.ports.assertCurrent = async () => {
        full += 1;
      };
      if (observed) {
        local.ports.assertCurrentObservation = async (scope) => {
          expect(scope.operationRef).toBe(operationRef);
          expect(scope.programDigest).toBe(normalActorProgramDigest(program));
          observation += 1;
        };
      }
      local.ports.checkpoint = async (state) => {
        checkpoints += 1;
        await originalCheckpoint(state);
      };
      await prepareNormalActorAccounts({ program, operationRef, ports: local.ports });
      return { full, observation, checkpoints, requests: local.requests };
    };
    const fallback = await run(false);
    const observed = await run(true);
    expect(observed.checkpoints).toBe(fallback.checkpoints);
    expect(observed.requests).toEqual(fallback.requests);
    expect(observed.observation).toBe(observed.checkpoints * 2);
    expect(fallback.full - observed.full).toBe(observed.observation);
    expect(observed.full).toBeGreaterThan(0);
  });
  it.each(["owner_revoked", "lease_expired"])(
    "blocks checkpoint before save when observation rejects %s",
    async (reason) => {
      const local = fixture();
      local.ports.assertCurrentObservation = async () => {
        throw new Error(reason);
      };
      await expect(
        prepareNormalActorAccounts({ program, operationRef, ports: local.ports }),
      ).rejects.toThrow(reason);
      expect(local.requests).toEqual([]);
      expect(local.getState().actors.every((actor) => actor.credentials === undefined)).toBe(true);
    },
  );
});
