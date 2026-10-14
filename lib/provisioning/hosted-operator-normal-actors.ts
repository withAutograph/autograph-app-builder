import { randomBytes, randomUUID } from "node:crypto";
import {
  assertNormalActorState,
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
  normalActorSessionRefSchema,
  normalBrowserStorageStateSchema,
  proposeResolvedNormalActorAccess,
  resolvedNormalActorAccess,
} from "./hosted-operator-normal-actor-program";
import type {
  NormalActorProgram,
  NormalActorCheckpoint,
  NormalActorSessionRef,
  NormalActorState,
  NormalBrowserStorageState,
} from "./hosted-operator-normal-actor-program";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import type { NormalAuthClient } from "./hosted-operator-normal-auth-client";

export interface NormalActorOrganizationOwnerProof {
  actorId: string;
  realmSessionId: string;
  reference: string;
  sha256: string;
}
export interface NormalActorAccountPorts {
  /** Re-read durable approval for this exact program and the existing resource lease/fence. */
  assertCurrent: (input: { operationRef: string; programDigest: string }) => Promise<void>;
  /** Existing owner-journal CAS; encrypt state with encryptNormalActorState before writing. */
  checkpoint: (state: NormalActorState) => Promise<void>;
  /** Only the approved, normal-owner Gateway capture adapter may supply an existing session. */
  readCapturedActor: (actorKey: string) => Promise<{
    session: NormalActorSessionRef;
    storageState: NormalBrowserStorageState;
  } | null>;
  clientFactory?: (input: {
    origin: string;
    storageState?: NormalBrowserStorageState;
    assertApprovedEffect: () => Promise<void>;
  }) => NormalAuthClient;
}
export interface NormalActorPreparationPorts extends NormalActorAccountPorts {
  /** Durable second approval names the resolved actors, proofs, organizations, invites, memberships and roles. */
  assertMembershipApproved: (input: {
    program: NormalActorProgram;
    state: NormalActorState;
    proposedAccess: ReturnType<typeof proposeResolvedNormalActorAccess>;
  }) => Promise<void>;
  /** Gateway-signed proof for this actual normal session; GetSession alone is not worker authority. */
  readOrganizationOwnerProof: (
    session: NormalActorSessionRef,
  ) => Promise<NormalActorOrganizationOwnerProof | null>;
  /** Bound fixed protected worker; receives the complete approved program, never a substituted plan. */
  prepareOrganization: (input: {
    program: NormalActorProgram;
    organizationId: string;
    owner: NormalActorSessionRef;
    ownerProof: NormalActorOrganizationOwnerProof;
  }) => Promise<void>;
  reconcileOrganization: (input: {
    program: NormalActorProgram;
    organizationId: string;
    owner: NormalActorSessionRef;
    ownerProof: NormalActorOrganizationOwnerProof;
  }) => Promise<"absent" | "applied" | "unknown">;
}

interface NormalActorAccountInput {
  program: NormalActorProgram;
  operationRef: string;
  state?: NormalActorState;
  ports: NormalActorAccountPorts;
}
interface NormalActorMembershipInput extends Omit<NormalActorAccountInput, "ports" | "state"> {
  state: NormalActorState;
  ports: NormalActorPreparationPorts;
}
type StageInput =
  | (NormalActorAccountInput & { stage: "accounts" })
  | (NormalActorMembershipInput & { stage: "memberships" });

const CAPTURE_EXISTING = "capture-existing";

/** Stages preserve the same state; concrete memberships cannot precede the second public approval. */
const prepareNormalActorStage = async (input: StageInput) => {
  const program = normalActorProgramSchema.parse(input.program);
  const state = assertNormalActorState(
    program,
    input.state ?? initialNormalActorState(program, input.operationRef),
    input.operationRef,
  );
  const programDigest = normalActorProgramDigest(program);
  const assertCurrent = async () => {
    await input.ports.assertCurrent({ operationRef: input.operationRef, programDigest });
  };
  const save = async () => {
    assertNormalActorState(program, state, input.operationRef);
    await assertCurrent();
    await input.ports.checkpoint(structuredClone(state));
    await assertCurrent();
  };
  const clients = new Map<string, NormalAuthClient>();
  if (input.stage === "memberships") {
    await assertCurrent();
    if (state.actors.some((actor) => actor.signup !== "complete")) {
      throw new Error("normal_actor_preparation_incomplete");
    }
    await input.ports.assertMembershipApproved({
      program,
      state: structuredClone(state),
      proposedAccess: proposeResolvedNormalActorAccess(program, state),
    });
  }
  const checkpointFor = (key: string) => {
    const actor = state.actors.find((candidate) => candidate.actorKey === key);
    if (!actor) {
      throw new Error("normal_actor_program_mismatch");
    }
    return actor;
  };
  const clientFor = (key: string) => {
    const client = clients.get(key);
    if (!client) {
      throw new Error("normal_actor_preparation_incomplete");
    }
    return client;
  };
  const retainSession = async (key: string, client: NormalAuthClient) => {
    await assertCurrent();
    const session = await client.getSession();
    const actor = program.actors.find((candidate) => candidate.actorKey === key);
    if (
      !actor ||
      !session ||
      session.email.toLowerCase() !== actor.email.toLowerCase() ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      throw new Error("normal_actor_session_required");
    }
    const checkpoint = checkpointFor(key);
    if (checkpoint.session && checkpoint.session.actorId !== session.actorId) {
      throw new Error("normal_actor_identity_mismatch");
    }
    checkpoint.session = normalActorSessionRefSchema.parse({
      actorId: session.actorId,
      realmSessionId: session.sessionId,
      expiresAt: session.expiresAt,
      reference: checkpoint.session?.reference ?? randomUUID(),
      origin: program.origin,
    });
    checkpoint.storageState = normalBrowserStorageStateSchema.parse(client.exportStorageState());
    checkpoint.signup = "complete";
    await save();
  };

  await assertCurrent();
  const restoreExistingCapture = async (
    actor: NormalActorProgram["actors"][number],
    checkpoint: NormalActorCheckpoint,
  ) => {
    if (actor.account !== CAPTURE_EXISTING || checkpoint.session !== undefined) {
      return;
    }
    await assertCurrent();
    const captured = await input.ports.readCapturedActor(actor.actorKey);
    if (!captured) {
      throw new Error("normal_actor_capture_required");
    }
    checkpoint.session = normalActorSessionRefSchema.parse(captured.session);
    checkpoint.storageState = normalBrowserStorageStateSchema.parse(captured.storageState);
    if (checkpoint.session.origin !== program.origin) {
      throw new Error("normal_actor_identity_mismatch");
    }
    await save();
  };
  const prepareAccount = async (actor: NormalActorProgram["actors"][number]) => {
    const checkpoint = checkpointFor(actor.actorKey);
    await restoreExistingCapture(actor, checkpoint);
    const client = (input.ports.clientFactory ?? createHostedOperatorNormalAuthClient)({
      origin: program.origin,
      storageState: checkpoint.storageState,
      assertApprovedEffect: assertCurrent,
    });
    clients.set(actor.actorKey, client);
    if (checkpoint.signup === "complete") {
      // Retained completion never substitutes for current normal authentication.
      await assertCurrent();
      if (!(await client.getSession())) {
        if (actor.account === CAPTURE_EXISTING) {
          throw new Error("normal_actor_capture_required");
        }
        if (!checkpoint.credentials) {
          throw new Error("normal_actor_signup_reconciliation_required");
        }
        await assertCurrent();
        await client.signIn({ email: actor.email, password: checkpoint.credentials.password });
      }
      await retainSession(actor.actorKey, client);
      return;
    }
    if (actor.account === CAPTURE_EXISTING) {
      await retainSession(actor.actorKey, client);
      return;
    }
    if (!checkpoint.credentials) {
      checkpoint.credentials = { password: randomBytes(32).toString("base64url") };
      await save();
    }
    if (checkpoint.signup === "attempted") {
      // A lost signup reply cannot authorize another account or an altered email.
      try {
        await assertCurrent();
        await client.signIn({ email: actor.email, password: checkpoint.credentials.password });
      } catch {
        throw new Error("normal_actor_signup_reconciliation_required");
      }
    } else {
      checkpoint.signup = "attempted";
      await save();
      await assertCurrent();
      await client.signUp({
        email: actor.email,
        name: actor.name,
        password: checkpoint.credentials.password,
      });
      if (!(await client.getSession())) {
        await assertCurrent();
        await client.signIn({ email: actor.email, password: checkpoint.credentials.password });
      }
    }
    await retainSession(actor.actorKey, client);
  };
  for (const actor of program.actors) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each actor effect shares the same durable journal checkpoint and fence.
    await prepareAccount(actor);
  }

  if (input.stage === "accounts") {
    await assertCurrent();
    return {
      state: structuredClone(state),
      proposedAccess: proposeResolvedNormalActorAccess(program, state),
    };
  }
  const assertMembershipCurrent = async () => {
    await assertCurrent();
    await input.ports.assertMembershipApproved({
      program,
      state: structuredClone(state),
      proposedAccess: proposeResolvedNormalActorAccess(program, state),
    });
  };

  const prepareOrganization = async (organization: NormalActorProgram["organizations"][number]) => {
    const checkpoint = state.organizations.find(
      (candidate) => candidate.organizationId === organization.organizationId,
    );
    const owner = checkpointFor(organization.ownerActorKey).session;
    if (!checkpoint || !owner) {
      throw new Error("normal_actor_preparation_incomplete");
    }
    await assertMembershipCurrent();
    const ownerProof = await input.ports.readOrganizationOwnerProof(owner);
    if (!ownerProof) {
      throw new Error("normal_actor_organization_owner_proof_required");
    }
    if (
      ![
        ownerProof.actorId === owner.actorId,
        ownerProof.realmSessionId === owner.realmSessionId,
        ownerProof.reference !== "",
        /^[a-f0-9]{64}$/u.test(ownerProof.sha256),
      ].every(Boolean)
    ) {
      throw new Error("normal_actor_organization_owner_proof_required");
    }
    const effect = { program, organizationId: organization.organizationId, owner, ownerProof };
    await assertCurrent();
    const observed = await input.ports.reconcileOrganization(effect);
    if (observed === "unknown") {
      throw new Error("normal_actor_organization_reconciliation_required");
    }
    if (observed === "absent") {
      if (checkpoint.status === "complete") {
        throw new Error("normal_actor_organization_reconciliation_required");
      }
      checkpoint.status = "attempted";
      await save();
      await assertMembershipCurrent();
      await input.ports.prepareOrganization(effect);
      await assertCurrent();
      if ((await input.ports.reconcileOrganization(effect)) !== "applied") {
        throw new Error("normal_actor_organization_reconciliation_required");
      }
    }
    checkpoint.status = "complete";
    await save();
  };
  for (const organization of program.organizations) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Organization writes and uncertainty readbacks share one fenced journal.
    await prepareOrganization(organization);
  }

  const prepareMembership = async (membership: NormalActorState["memberships"][number]) => {
    const organization = program.organizations.find(
      (candidate) => candidate.organizationId === membership.organizationId,
    );
    const actor = program.actors.find((candidate) => candidate.actorKey === membership.actorKey);
    const { session } = checkpointFor(membership.actorKey);
    if (!organization || !actor || !session) {
      throw new Error("normal_actor_program_mismatch");
    }
    const ownerClient = clientFor(organization.ownerActorKey);
    const participantClient = clientFor(membership.actorKey);
    const readMembership = async () => {
      await assertCurrent();
      const result = await ownerClient.listMembers({
        organizationId: membership.organizationId,
        userId: session.actorId,
      });
      const matches = result.members.filter((member) => member.userId === session.actorId);
      if (matches.length > 1) {
        throw new Error("normal_actor_membership_reconciliation_required");
      }
      const current = matches.at(0);
      if (
        current &&
        ![
          current.organizationId === membership.organizationId,
          current.role === membership.role,
          current.user.id === session.actorId,
          current.user.email.toLowerCase() === actor.email.toLowerCase(),
        ].every(Boolean)
      ) {
        throw new Error("normal_actor_membership_reconciliation_required");
      }
      return current;
    };
    if (await readMembership()) {
      membership.status = "complete";
      await save();
      return;
    }
    if (membership.status === "complete" || organization.ownerActorKey === membership.actorKey) {
      throw new Error("normal_actor_membership_reconciliation_required");
    }
    if (membership.invitationId === undefined) {
      if (membership.status === "attempted") {
        await assertCurrent();
        const invitations = await ownerClient.listInvitations({
          organizationId: membership.organizationId,
        });
        const candidates = invitations.filter((invitation) =>
          [
            invitation.organizationId === membership.organizationId,
            invitation.email.toLowerCase() === actor.email.toLowerCase(),
            invitation.role === membership.role,
            invitation.status === "pending",
            Date.parse(invitation.expiresAt) > Date.now(),
          ].every(Boolean),
        );
        const candidate = candidates.at(0);
        if (candidates.length !== 1 || candidate === undefined) {
          throw new Error("normal_actor_invitation_reconciliation_required");
        }
        membership.invitationId = candidate.id;
      } else {
        membership.status = "attempted";
        await save();
        await assertMembershipCurrent();
        const invitation = await ownerClient.inviteMember({
          organizationId: membership.organizationId,
          email: actor.email,
          role: membership.role,
        });
        if (
          invitation.organizationId !== membership.organizationId ||
          invitation.email.toLowerCase() !== actor.email.toLowerCase() ||
          invitation.role !== membership.role
        ) {
          throw new Error("normal_actor_invitation_reconciliation_required");
        }
        membership.invitationId = invitation.id;
      }
      await save();
    }
    await assertMembershipCurrent();
    await participantClient.acceptInvitation({ invitationId: membership.invitationId });
    await retainSession(membership.actorKey, participantClient);
    if (!(await readMembership())) {
      throw new Error("normal_actor_membership_reconciliation_required");
    }
    membership.status = "complete";
    await save();
  };
  for (const membership of state.memberships) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Invite, acceptance and readback checkpoint one membership before the next.
    await prepareMembership(membership);
  }
  await assertCurrent();
  // No role-grant client is present: returned actual IDs require the existing fresh access approval.
  return {
    state: structuredClone(state),
    proposedAccess: resolvedNormalActorAccess(program, state),
  };
};

export const prepareNormalActorAccounts = async (input: NormalActorAccountInput) =>
  await prepareNormalActorStage({ ...input, stage: "accounts" });
export const prepareNormalActorMemberships = async (input: NormalActorMembershipInput) =>
  await prepareNormalActorStage({ ...input, stage: "memberships" });
