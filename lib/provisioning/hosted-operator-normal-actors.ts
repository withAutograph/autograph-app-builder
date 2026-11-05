import { randomBytes, randomUUID } from "node:crypto";
import {
  assertNormalActorState,
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
  normalActorSessionRefSchema,
  normalBrowserStorageStateSchema,
  proposeResolvedNormalActorAccess,
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
  /** Additional owner-confirmed normal capture, before organization creation when necessary. */
  readOrganizationSession: (
    actorKey: string,
    organizationId: string,
  ) => Promise<{
    session: NormalActorSessionRef;
    storageState: NormalBrowserStorageState;
  } | null>;
  /** Re-read durable approval for this exact program and the existing resource lease/fence. */
  assertCurrent: (input: { operationRef: string; programDigest: string }) => Promise<void>;
  /** Actual current approval/owner/lease/fence observation for internal save wrappers only. */
  assertCurrentObservation?: (input: {
    operationRef: string;
    programDigest: string;
  }) => Promise<void>;
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
  organizationId?: string;
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
  const targetOrganizationId = input.stage === "memberships" ? input.organizationId : undefined;
  if (
    targetOrganizationId !== undefined &&
    !program.organizations.some(
      (organization) => organization.organizationId === targetOrganizationId,
    )
  ) {
    throw new Error("normal_actor_program_mismatch");
  }
  const programDigest = normalActorProgramDigest(program);
  const assertCurrent = async () => {
    await input.ports.assertCurrent({ operationRef: input.operationRef, programDigest });
  };
  const assertSaveCurrent = async () => {
    if (input.ports.assertCurrentObservation === undefined) {
      await assertCurrent();
      return;
    }
    await input.ports.assertCurrentObservation({ operationRef: input.operationRef, programDigest });
  };
  const save = async () => {
    assertNormalActorState(program, state, input.operationRef);
    await assertSaveCurrent();
    await input.ports.checkpoint(structuredClone(state));
    await assertSaveCurrent();
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
    if (
      actor.account === CAPTURE_EXISTING &&
      checkpoint.signup === "complete" &&
      !program.memberships.some((membership) => membership.actorKey === actor.actorKey)
    ) {
      if (checkpoint.session?.realmSessionId !== session.sessionId) {
        throw new Error("normal_actor_identity_mismatch");
      }
      // This opaque capture is immutable provenance; live organization selection is app-owned scope.
      await assertCurrent();
      return;
    }
    checkpoint.session = normalActorSessionRefSchema.parse({
      actorId: session.actorId,
      realmSessionId: session.sessionId,
      expiresAt: session.expiresAt,
      reference: checkpoint.session?.reference ?? randomUUID(),
      origin: program.origin,
      activeOrganizationId: session.activeOrganizationId,
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
  const selectedActors =
    input.stage === "accounts" || targetOrganizationId === undefined
      ? program.actors
      : program.actors.filter((actor) =>
          program.memberships.some(
            (membership) =>
              membership.organizationId === targetOrganizationId &&
              membership.actorKey === actor.actorKey,
          ),
        );
  for (const actor of selectedActors) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each actor effect shares the same durable journal checkpoint and fence.
    await prepareAccount(actor);
  }

  const candidateStorage = async (
    actor: NormalActorProgram["actors"][number],
    session: NormalActorSessionRef,
    baseStorage: NormalBrowserStorageState | undefined,
    organizationId: string,
    existing: NonNullable<NormalActorState["organizationSessions"]>[number] | undefined,
  ) => {
    if (actor.account !== CAPTURE_EXISTING || existing !== undefined) {
      return {
        storageState: existing?.storageState,
        expectedSessionId: existing?.session.realmSessionId,
      };
    }
    const another =
      state.organizationSessions?.some(
        (entry) => entry.actorKey === actor.actorKey && entry.organizationId !== organizationId,
      ) ?? false;
    if (!another) {
      return { storageState: baseStorage, expectedSessionId: session.realmSessionId };
    }
    await assertCurrent();
    const captured = await input.ports.readOrganizationSession(actor.actorKey, organizationId);
    if (
      !captured ||
      captured.session.actorId !== session.actorId ||
      captured.session.origin !== program.origin
    ) {
      throw new Error("normal_actor_session_selection_required");
    }
    return {
      storageState: captured.storageState,
      expectedSessionId: captured.session.realmSessionId,
    };
  };
  const prepareOrganizationCandidate = async (
    membership: NormalActorState["memberships"][number],
  ) => {
    const actor = program.actors.find((candidate) => candidate.actorKey === membership.actorKey);
    const checkpoint = checkpointFor(membership.actorKey);
    if (!actor || !checkpoint.session) {
      throw new Error("normal_actor_preparation_incomplete");
    }
    state.organizationSessions ??= [];
    const existing = state.organizationSessions.find(
      (entry) =>
        entry.actorKey === membership.actorKey &&
        entry.organizationId === membership.organizationId,
    );
    const candidate = await candidateStorage(
      actor,
      checkpoint.session,
      checkpoint.storageState,
      membership.organizationId,
      existing,
    );
    const { storageState } = candidate;
    let { expectedSessionId } = candidate;
    const client = (input.ports.clientFactory ?? createHostedOperatorNormalAuthClient)({
      origin: program.origin,
      storageState,
      assertApprovedEffect: assertCurrent,
    });
    await assertCurrent();
    let normal = await client.getSession();
    if (normal === null) {
      if (actor.account === CAPTURE_EXISTING || checkpoint.credentials === undefined) {
        throw new Error("normal_actor_session_selection_required");
      }
      await save();
      await assertCurrent();
      await client.signIn({ email: actor.email, password: checkpoint.credentials.password });
      normal = await client.getSession();
      expectedSessionId = normal?.sessionId;
    }
    if (normal === null) {
      throw new Error("normal_actor_session_selection_required");
    }
    if (
      ![
        normal.actorId === checkpoint.session.actorId,
        normal.email.toLowerCase() === actor.email.toLowerCase(),
        normal.sessionId === expectedSessionId,
        Date.parse(normal.expiresAt) > Date.now(),
      ].every(Boolean)
    ) {
      throw new Error("normal_actor_session_selection_required");
    }
    const otherSession = state.organizationSessions.some(
      (entry) =>
        entry.actorKey === actor.actorKey &&
        entry.organizationId !== membership.organizationId &&
        entry.session.realmSessionId === normal.sessionId,
    );
    if (otherSession) {
      throw new Error("normal_actor_session_selection_required");
    }
    const retained: NonNullable<NormalActorState["organizationSessions"]>[number] = {
      actorKey: actor.actorKey,
      organizationId: membership.organizationId,
      selection:
        existing?.selection === "selected" &&
        normal.activeOrganizationId === membership.organizationId
          ? "selected"
          : "pending",
      session: normalActorSessionRefSchema.parse({
        actorId: normal.actorId,
        realmSessionId: normal.sessionId,
        origin: program.origin,
        expiresAt: normal.expiresAt,
        reference: existing?.session.reference ?? randomUUID(),
        activeOrganizationId: normal.activeOrganizationId,
      }),
      storageState: normalBrowserStorageStateSchema.parse(client.exportStorageState()),
    };
    if (existing === undefined) {
      state.organizationSessions.push(retained);
    } else {
      Object.assign(existing, retained);
    }
    await save();
  };
  if (input.stage === "accounts") {
    for (const membership of state.memberships) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each real login candidate is encrypted in the same journal before preparing another.
      await prepareOrganizationCandidate(membership);
    }
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
    const owner = state.organizationSessions?.find(
      (entry) =>
        entry.actorKey === organization.ownerActorKey &&
        entry.organizationId === organization.organizationId,
    )?.session;
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
  const selectedOrganizations = program.organizations.filter(
    (organization) =>
      targetOrganizationId === undefined || organization.organizationId === targetOrganizationId,
  );
  for (const organization of selectedOrganizations) {
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
  const selectedMemberships = state.memberships.filter(
    (membership) =>
      targetOrganizationId === undefined || membership.organizationId === targetOrganizationId,
  );
  for (const membership of selectedMemberships) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Invite, acceptance and readback checkpoint one membership before the next.
    await prepareMembership(membership);
  }
  const selectOrganizationSession = async (membership: NormalActorState["memberships"][number]) => {
    if (membership.status !== "complete") {
      throw new Error("normal_actor_preparation_incomplete");
    }
    const retained = state.organizationSessions?.find(
      (entry) =>
        entry.actorKey === membership.actorKey &&
        entry.organizationId === membership.organizationId,
    );
    const checkpoint = checkpointFor(membership.actorKey);
    if (!retained || !checkpoint.session) {
      throw new Error("normal_actor_session_selection_required");
    }
    const client = (input.ports.clientFactory ?? createHostedOperatorNormalAuthClient)({
      origin: program.origin,
      storageState: retained.storageState,
      assertApprovedEffect: assertMembershipCurrent,
    });
    await assertMembershipCurrent();
    let normal = await client.getSession();
    if (
      normal === null ||
      normal.actorId !== checkpoint.session.actorId ||
      normal.sessionId !== retained.session.realmSessionId
    ) {
      throw new Error("normal_actor_session_selection_required");
    }
    if (normal.activeOrganizationId !== membership.organizationId) {
      await save();
      await assertMembershipCurrent();
      await client.setActiveOrganization({ organizationId: membership.organizationId });
      normal = await client.getSession();
    }
    if (normal === null) {
      throw new Error("normal_actor_session_selection_required");
    }
    if (
      ![
        normal.activeOrganizationId === membership.organizationId,
        normal.actorId === checkpoint.session.actorId,
        normal.sessionId === retained.session.realmSessionId,
        Date.parse(normal.expiresAt) > Date.now(),
      ].every(Boolean)
    ) {
      throw new Error("normal_actor_session_selection_required");
    }
    retained.selection = "selected";
    retained.session.activeOrganizationId = normal.activeOrganizationId;
    retained.session.expiresAt = normal.expiresAt;
    retained.storageState = normalBrowserStorageStateSchema.parse(client.exportStorageState());
    await save();
  };
  for (const membership of selectedMemberships) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each actual organization selection is checkpointed before preparing the next context.
    await selectOrganizationSession(membership);
  }
  await assertCurrent();
  // No role-grant client is present: returned actual IDs require the existing fresh access approval.
  return {
    state: structuredClone(state),
    proposedAccess: proposeResolvedNormalActorAccess(program, state),
  };
};

export const prepareNormalActorAccounts = async (input: NormalActorAccountInput) =>
  await prepareNormalActorStage({ ...input, stage: "accounts" });
export const prepareNormalActorMemberships = async (input: NormalActorMembershipInput) =>
  await prepareNormalActorStage({ ...input, stage: "memberships" });
