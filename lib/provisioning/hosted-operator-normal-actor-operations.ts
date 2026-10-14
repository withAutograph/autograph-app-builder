/* oxlint-disable eslint/no-await-in-loop -- Account, session and membership reads preserve the same approval and private journal scope. */
import {
  HostedOperatorError,
  operatorPlanDigest,
  selectHostedOperatorOwnedOrganizationSpec,
} from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  HostedOperatorOwnedOrganizationSpec,
} from "./hosted-operator-contract";
import type { HostedOperatorNormalActorPorts } from "./hosted-operator-composition";
import type {
  HostedOperatorContext,
  HostedOperatorEffectContext,
  HostedOperatorWorkerEffectContext,
} from "./hosted-operator-service";
import {
  assertNormalActorState,
  normalActorProgramDigest,
  proposeResolvedNormalActorAccess,
} from "./hosted-operator-normal-actor-program";
import type {
  NormalActorProgram,
  NormalActorSessionRef,
  NormalActorState,
} from "./hosted-operator-normal-actor-program";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type {
  NormalActorAccountPreparation,
  NormalActorJournalPorts,
} from "./hosted-operator-normal-actor-journal";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import type { NormalAuthClient, NormalAuthSession } from "./hosted-operator-normal-auth-client";
import {
  prepareNormalActorAccounts,
  prepareNormalActorMemberships,
} from "./hosted-operator-normal-actors";
import type { NormalActorOrganizationOwnerProof } from "./hosted-operator-normal-actors";

interface OrganizationWorkerInput {
  effect: HostedOperatorEffectContext;
  organizationId: string;
  owner: NormalActorSessionRef;
  ownerProof: NormalActorOrganizationOwnerProof;
}
/** Every dependency is a real deployment-owned capability. None has a successful default. */
export interface NormalActorOperationsDependencies {
  journalPorts: NormalActorJournalPorts;
  assertPlanningAuthorized: (context: HostedOperatorContext) => Promise<void>;
  assertCurrentPlan: (
    input: HostedOperatorContext & { plan: HostedOperatorPlan; operationRef?: string },
  ) => Promise<void>;
  normalRealmFetch: (input: {
    context: HostedOperatorContext;
    origin: string;
  }) => Promise<typeof fetch>;
  prepareActorCapture: (
    input: HostedOperatorContext & {
      preparation: NormalActorAccountPreparation;
      actorKey: string;
      organizationId?: string;
    },
  ) => ReturnType<HostedOperatorNormalActorPorts["normalActorAuthIdentityInput"]>;
  collectOrganizationOwnerProof: (
    input: HostedOperatorContext & {
      plan: HostedOperatorPlan;
      preparation: NormalActorAccountPreparation;
      state: NormalActorState;
      organizationId: string;
      owner: NormalActorSessionRef;
    },
  ) => Promise<HostedOperatorOwnedOrganizationSpec>;
  executeOrganization: (
    input: OrganizationWorkerInput & { effect: HostedOperatorWorkerEffectContext },
  ) => Promise<void>;
  inspectOrganization: (
    input: OrganizationWorkerInput,
  ) => Promise<"absent" | "applied" | "unknown">;
}

const required = () => new HostedOperatorError("auth_identity_required");
const mismatch = () => new HostedOperatorError("resource_mismatch");
const normalPreparation = async <T>(operation: Promise<T>): Promise<T> => {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof Error) {
      const codes = new Map<
        string,
        "auth_identity_required" | "reconciliation_required" | "resource_mismatch"
      >([
        ["normal_actor_capture_required", "auth_identity_required"],
        ["normal_actor_session_selection_required", "auth_identity_required"],
        ["normal_actor_session_required", "auth_identity_required"],
        ["normal_actor_identity_mismatch", "resource_mismatch"],
        ["normal_actor_program_mismatch", "resource_mismatch"],
        ["normal_actor_preparation_incomplete", "reconciliation_required"],
        ["normal_actor_signup_reconciliation_required", "reconciliation_required"],
        ["normal_actor_invitation_reconciliation_required", "reconciliation_required"],
        ["normal_actor_membership_reconciliation_required", "reconciliation_required"],
        ["normal_actor_organization_reconciliation_required", "reconciliation_required"],
        ["normal_actor_organization_owner_proof_required", "auth_identity_required"],
      ]);
      const code = codes.get(error.message);
      if (code !== undefined) {
        throw new HostedOperatorError(code);
      }
    }
    throw error;
  }
};
const selectedProgram = (plan: HostedOperatorPlan): NormalActorProgram => {
  if (plan.normalActorProgram === undefined) {
    throw mismatch();
  }
  return plan.normalActorProgram;
};
const canonicalAccess = (access: HostedOperatorPlan["access"]) =>
  access
    .map((grant) => ({
      actorId: grant.actorId,
      organizationId: grant.organizationId,
      roles: grant.roles.toSorted(),
    }))
    .toSorted((left, right) =>
      `${left.organizationId}:${left.actorId}`.localeCompare(
        `${right.organizationId}:${right.actorId}`,
      ),
    );
const assertResolvedAccess = (plan: HostedOperatorPlan, state: NormalActorState) => {
  if (
    JSON.stringify(canonicalAccess(plan.access)) !==
    JSON.stringify(canonicalAccess(proposeResolvedNormalActorAccess(selectedProgram(plan), state)))
  ) {
    throw mismatch();
  }
};
const assertSession = (
  session: NormalAuthSession | null,
  actor: NormalActorProgram["actors"][number],
  expected: NormalActorSessionRef,
  now: number,
  organizationId?: string,
): NormalAuthSession => {
  const matches =
    session !== null &&
    [
      session.actorId === expected.actorId,
      session.sessionId === expected.realmSessionId,
      session.email.toLowerCase() === actor.email.toLowerCase(),
      Date.parse(session.expiresAt) > now,
      organizationId === undefined || session.activeOrganizationId === organizationId,
    ].every(Boolean);
  if (!matches || session === null) {
    throw required();
  }
  return session;
};
const selectedOrganization = (input: HostedOperatorEffectContext) => {
  const program = selectedProgram(input.plan);
  const organization = program.organizations.find(
    (candidate) => input.effect.id === `auth-membership:${candidate.organizationId}`,
  );
  if (
    input.effect.kind !== "auth-membership" ||
    organization === undefined ||
    input.plan.authMembership === undefined
  ) {
    throw mismatch();
  }
  const spec = selectHostedOperatorOwnedOrganizationSpec(input.plan.authMembership, organization);
  return { program, organization, spec };
};

/** Private normal HTTP operations under the original account approval and current full-plan approval. */
export const createHostedOperatorNormalActorOperations = (
  deps: NormalActorOperationsDependencies,
): HostedOperatorNormalActorPorts => {
  const journal = createNormalActorJournal(deps.journalPorts);
  const read = async (context: HostedOperatorContext, plan?: HostedOperatorPlan) => {
    await deps.assertPlanningAuthorized(context);
    const prepared = await journal.read(context);
    if (prepared !== undefined && plan !== undefined) {
      const program = selectedProgram(plan);
      if (prepared.preparation.programDigest !== normalActorProgramDigest(program)) {
        throw mismatch();
      }
      const frozen = plan.normalActorPreparation;
      if (
        frozen !== undefined &&
        [
          frozen.accountOperationRef !== prepared.preparation.accountOperationRef,
          frozen.accountPlanDigest !== prepared.preparation.accountPlanDigest,
          frozen.accountApprovalId !== prepared.preparation.accountApprovalId,
          frozen.accountApprovedByCallId !== prepared.preparation.accountApprovedByCallId,
        ].some(Boolean)
      ) {
        throw mismatch();
      }
    }
    return prepared;
  };
  const readRequired = async (context: HostedOperatorContext, plan: HostedOperatorPlan) => {
    const prepared = await read(context, plan);
    if (prepared === undefined) {
      throw required();
    }
    return prepared;
  };
  const transport = async (context: HostedOperatorContext, program: NormalActorProgram) =>
    await deps.normalRealmFetch({ context, origin: program.origin });
  const freshAccounts = async (
    context: HostedOperatorContext,
    preparation: NormalActorAccountPreparation,
    stateInput: NormalActorState,
  ) => {
    const state = assertNormalActorState(
      preparation.program,
      stateInput,
      preparation.accountOperationRef,
    );
    const fetch = await transport(context, preparation.program);
    const checkpoints = new Map(state.actors.map((actor) => [actor.actorKey, actor]));
    await Promise.all(
      preparation.program.actors.map(async (actor) => {
        const checkpoint = checkpoints.get(actor.actorKey);
        if (
          checkpoint?.signup !== "complete" ||
          checkpoint.session === undefined ||
          checkpoint.storageState === undefined
        ) {
          throw required();
        }
        const client = createHostedOperatorNormalAuthClient({
          origin: preparation.program.origin,
          storageState: checkpoint.storageState,
          fetch,
        });
        assertSession(
          await client.getSession(),
          actor,
          checkpoint.session,
          deps.journalPorts.now(),
        );
      }),
    );
    return state;
  };
  const checkpoint = async (input: HostedOperatorEffectContext, state: NormalActorState) => {
    if (input.checkpointAccountPreparation === undefined) {
      throw new HostedOperatorError("operation_in_progress");
    }
    await input.assertCurrent();
    const saved = await journal.checkpoint(input, state);
    await input.checkpointAccountPreparation(saved);
    await input.assertCurrent();
  };
  const accountPorts = async (
    input: HostedOperatorEffectContext,
    preparation: NormalActorAccountPreparation,
  ) => {
    const fetch = await transport(input, preparation.program);
    return {
      assertCurrent: async (scope: { operationRef: string; programDigest: string }) => {
        if (
          scope.operationRef !== preparation.accountOperationRef ||
          scope.programDigest !== preparation.programDigest
        ) {
          throw mismatch();
        }
        await deps.assertCurrentPlan(input);
        await input.assertCurrent();
      },
      checkpoint: async (state: NormalActorState) => {
        await checkpoint(input, state);
      },
      readCapturedActor: async (actorKey: string) => {
        // Only the consumed owner-confirmed state is usable. Staged captures are never consulted.
        const prepared = await readRequired(input, input.plan);
        const actor = prepared.state.actors.find((candidate) => candidate.actorKey === actorKey);
        return actor?.session === undefined || actor.storageState === undefined
          ? null
          : { session: actor.session, storageState: actor.storageState };
      },
      readOrganizationSession: async (actorKey: string, organizationId: string) => {
        const current = await readRequired(input, input.plan);
        const scoped = current.state.organizationSessions?.find(
          (candidate) =>
            candidate.actorKey === actorKey && candidate.organizationId === organizationId,
        );
        return scoped === undefined
          ? null
          : { session: scoped.session, storageState: scoped.storageState };
      },
      clientFactory: (
        options: Parameters<typeof createHostedOperatorNormalAuthClient>[0],
      ): NormalAuthClient => createHostedOperatorNormalAuthClient({ ...options, fetch }),
    };
  };
  const verifyMemberships = async (input: HostedOperatorEffectContext, organizationId?: string) => {
    await deps.assertCurrentPlan(input);
    await input.assertCurrent();
    const prepared = await readRequired(input, input.plan);
    const state = await freshAccounts(input, prepared.preparation, prepared.state);
    const { program } = prepared.preparation;
    const fetch = await transport(input, program);
    const memberships = program.memberships.filter(
      (membership) => organizationId === undefined || membership.organizationId === organizationId,
    );
    const actors = new Map(program.actors.map((actor) => [actor.actorKey, actor]));
    const scopedSessions = new Map(
      (state.organizationSessions ?? []).map((entry) => [
        `${entry.organizationId}:${entry.actorKey}`,
        entry,
      ]),
    );
    const observations = await Promise.all(
      memberships.map(async (membership) => {
        const actor = actors.get(membership.actorKey);
        const scoped = scopedSessions.get(`${membership.organizationId}:${membership.actorKey}`);
        if (actor === undefined || scoped === undefined || scoped.selection !== "selected") {
          return false;
        }
        const client = createHostedOperatorNormalAuthClient({
          origin: program.origin,
          storageState: scoped.storageState,
          fetch,
        });
        assertSession(
          await client.getSession(),
          actor,
          scoped.session,
          deps.journalPorts.now(),
          membership.organizationId,
        );
        const actual = await client.listMembers({
          organizationId: membership.organizationId,
          userId: scoped.session.actorId,
        });
        const matches = actual.members.filter((member) =>
          [
            member.userId === scoped.session.actorId,
            member.user.id === scoped.session.actorId,
            member.organizationId === membership.organizationId,
            member.role === membership.role,
            member.user.email.toLowerCase() === actor.email.toLowerCase(),
          ].every(Boolean),
        );
        return matches.length === 1 && actual.total === 1;
      }),
    );
    await input.assertCurrent();
    return { state, complete: observations.every(Boolean) };
  };

  const freshOrganizationCandidates = async (
    context: HostedOperatorContext,
    preparation: NormalActorAccountPreparation,
    state: NormalActorState,
    organizationId?: string,
  ) => {
    const actors = new Map(preparation.program.actors.map((actor) => [actor.actorKey, actor]));
    const candidates = new Map(
      (state.organizationSessions ?? []).map((entry) => [
        `${entry.organizationId}:${entry.actorKey}`,
        entry,
      ]),
    );
    const fetch = await transport(context, preparation.program);
    await Promise.all(
      preparation.program.memberships.map(async (membership) => {
        if (organizationId !== undefined && membership.organizationId !== organizationId) {
          return;
        }
        const actor = actors.get(membership.actorKey);
        const candidate = candidates.get(`${membership.organizationId}:${membership.actorKey}`);
        if (actor === undefined || candidate === undefined) {
          throw required();
        }
        const client = createHostedOperatorNormalAuthClient({
          origin: preparation.program.origin,
          storageState: candidate.storageState,
          fetch,
        });
        assertSession(await client.getSession(), actor, candidate.session, deps.journalPorts.now());
      }),
    );
  };
  const firstUnusableCapture = async (
    context: HostedOperatorContext,
    prepared: { preparation: NormalActorAccountPreparation; state: NormalActorState },
  ): Promise<{ actorKey: string; organizationId?: string } | undefined> => {
    const { program } = prepared.preparation;
    const fetch = await transport(context, program);
    const actors = new Map(prepared.state.actors.map((actor) => [actor.actorKey, actor]));
    const candidates = new Map(
      (prepared.state.organizationSessions ?? []).map((entry) => [
        `${entry.organizationId}:${entry.actorKey}`,
        entry,
      ]),
    );
    for (const actor of program.actors.filter((entry) => entry.account === "capture-existing")) {
      const saved = actors.get(actor.actorKey);
      if (saved?.session === undefined || saved.storageState === undefined) {
        return { actorKey: actor.actorKey };
      }
      const normal = createHostedOperatorNormalAuthClient({
        origin: program.origin,
        storageState: saved.storageState,
        fetch,
      });
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- Stop at the first needed capture; issuing multiple owner capture requests would overwrite the pending namespace.
      const session = await normal.getSession();
      if (session === null) {
        return { actorKey: actor.actorKey };
      }
      assertSession(session, actor, saved.session, deps.journalPorts.now());
      const memberships = program.memberships.filter((entry) => entry.actorKey === actor.actorKey);
      const usedSessions = new Set<string>();
      for (const [index, membership] of memberships.entries()) {
        const candidate = candidates.get(`${membership.organizationId}:${actor.actorKey}`);
        if (candidate === undefined || usedSessions.has(candidate.session.realmSessionId)) {
          // The first context may use the confirmed base session; every additional context needs a distinct capture.
          if (index > 0) {
            return { actorKey: actor.actorKey, organizationId: membership.organizationId };
          }
          usedSessions.add(saved.session.realmSessionId);
          continue;
        }
        usedSessions.add(candidate.session.realmSessionId);
        const scoped = createHostedOperatorNormalAuthClient({
          origin: program.origin,
          storageState: candidate.storageState,
          fetch,
        });
        // oxlint-disable-next-line react-doctor/async-await-in-loop -- Capture preflight stops at one pending reconnect without creating multiple nonce requests.
        const actual = await scoped.getSession();
        if (actual === null) {
          return { actorKey: actor.actorKey, organizationId: membership.organizationId };
        }
        assertSession(actual, actor, candidate.session, deps.journalPorts.now());
      }
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined -- The explicit optional result is the capture preflight contract.
    return undefined;
  };
  return {
    readNormalActorPreparation: async (context) => await read(context),
    async ensureNormalActorCapture(input) {
      await deps.assertCurrentPlan(input);
      if (
        input.plan.stage !== "auth-participants" ||
        input.planDigest !== operatorPlanDigest(input.plan)
      ) {
        throw mismatch();
      }
      const program = selectedProgram(input.plan);
      let prepared = await read(input, input.plan);
      if (prepared === undefined) {
        await journal.retain(input, {
          program,
          programDigest: normalActorProgramDigest(program),
          accountOperationRef: input.operationRef,
          accountPlan: input.plan,
          accountPlanDigest: input.planDigest,
          accountApprovalId: input.approvalId,
          accountApprovedByCallId: input.callId,
        });
        prepared = await readRequired(input, input.plan);
      }
      const actor = await firstUnusableCapture(input, prepared);
      if (actor !== undefined) {
        await deps.prepareActorCapture({
          ...input,
          preparation: prepared.preparation,
          actorKey: actor.actorKey,
          organizationId: actor.organizationId,
        });
        return "required";
      }
      return "ready";
    },
    async normalActorAuthIdentityInput(input) {
      await deps.assertCurrentPlan(input);
      const prepared = await readRequired(input, input.plan);
      const actor = await firstUnusableCapture(input, prepared);
      if (actor === undefined) {
        throw required();
      }
      return await deps.prepareActorCapture({
        ...input,
        preparation: prepared.preparation,
        actorKey: actor.actorKey,
        organizationId: actor.organizationId,
      });
    },
    async prepareNormalActorAccounts(input) {
      if (input.effect.kind !== "normal-accounts" || input.plan.stage !== "auth-participants") {
        throw mismatch();
      }
      const prepared = await readRequired(input, input.plan);
      const result = await normalPreparation(
        prepareNormalActorAccounts({
          program: prepared.preparation.program,
          operationRef: prepared.preparation.accountOperationRef,
          state: prepared.state,
          ports: await accountPorts(input, prepared.preparation),
        }),
      );
      return result.state;
    },
    async verifyNormalActorAccounts(input) {
      await deps.assertCurrentPlan(input);
      await input.assertCurrent();
      const prepared = await readRequired(input, input.plan);
      const state = await freshAccounts(input, prepared.preparation, prepared.state);
      await freshOrganizationCandidates(input, prepared.preparation, state);
      await input.assertCurrent();
      return state;
    },
    async readNormalActorOrganizationProofs(input) {
      await deps.assertPlanningAuthorized(input);
      const prepared = await readRequired(input, input.plan);
      const state = await freshAccounts(input, prepared.preparation, prepared.state);
      await freshOrganizationCandidates(input, prepared.preparation, state);
      const result: HostedOperatorOwnedOrganizationSpec[] = [];
      for (const organization of prepared.preparation.program.organizations) {
        const owner = state.organizationSessions?.find(
          (entry) =>
            entry.actorKey === organization.ownerActorKey &&
            entry.organizationId === organization.organizationId,
        )?.session;
        if (owner === undefined) {
          throw required();
        }
        // oxlint-disable-next-line react-doctor/async-await-in-loop -- Each proof collection writes its own correlated pending nonce under the same owner journal CAS.
        const spec = await deps.collectOrganizationOwnerProof({
          ...input,
          preparation: prepared.preparation,
          state,
          organizationId: organization.organizationId,
          owner,
        });
        if (
          [
            spec.actorId !== owner.actorId,
            spec.identityCapture.realmSessionId !== owner.realmSessionId,
            spec.organizationId !== organization.organizationId,
            spec.name !== organization.name,
            spec.slug !== organization.slug,
          ].some(Boolean)
        ) {
          throw mismatch();
        }
        result.push(spec);
      }
      return result;
    },
    async prepareNormalActorMemberships(input) {
      const { organization, spec } = selectedOrganization(input);
      const prepared = await readRequired(input, input.plan);
      assertResolvedAccess(input.plan, prepared.state);
      await freshOrganizationCandidates(
        input,
        prepared.preparation,
        prepared.state,
        organization.organizationId,
      );
      const result = await normalPreparation(
        prepareNormalActorMemberships({
          program: prepared.preparation.program,
          operationRef: prepared.preparation.accountOperationRef,
          state: prepared.state,
          organizationId: organization.organizationId,
          ports: {
            ...(await accountPorts(input, prepared.preparation)),
            assertMembershipApproved: async () => {
              await deps.assertCurrentPlan(input);
              await input.assertCurrent();
            },
            readOrganizationOwnerProof: async (owner) => {
              await deps.assertCurrentPlan(input);
              await input.assertCurrent();
              if (
                spec.actorId !== owner.actorId ||
                spec.identityCapture.realmSessionId !== owner.realmSessionId
              ) {
                throw mismatch();
              }
              return {
                actorId: spec.actorId,
                realmSessionId: spec.identityCapture.realmSessionId,
                reference: spec.identityProof.reference,
                sha256: spec.identityProof.sha256,
              };
            },
            prepareOrganization: async (effect) => {
              if (effect.organizationId !== organization.organizationId) {
                throw mismatch();
              }
              await deps.executeOrganization({
                effect: input,
                organizationId: effect.organizationId,
                owner: effect.owner,
                ownerProof: effect.ownerProof,
              });
            },
            reconcileOrganization: async (effect) =>
              await deps.inspectOrganization({
                effect: input,
                organizationId: effect.organizationId,
                owner: effect.owner,
                ownerProof: effect.ownerProof,
              }),
          },
        }),
      );
      return result.state;
    },
    async verifyNormalActorMemberships(input) {
      const verified = await verifyMemberships(input);
      if (
        !verified.complete ||
        verified.state.memberships.some((membership) => membership.status !== "complete") ||
        verified.state.organizations.some((organization) => organization.status !== "complete")
      ) {
        throw new HostedOperatorError("reconciliation_required");
      }
      assertResolvedAccess(input.plan, verified.state);
      return verified.state;
    },
    async reconcileNormalActorMemberships(input) {
      const { organization, spec } = selectedOrganization(input);
      await deps.assertCurrentPlan(input);
      await input.assertCurrent();
      const prepared = await readRequired(input, input.plan);
      const owner = prepared.state.organizationSessions?.find(
        (entry) =>
          entry.actorKey === organization.ownerActorKey &&
          entry.organizationId === organization.organizationId,
      )?.session;
      if (owner === undefined) {
        throw required();
      }
      if (
        owner.actorId !== spec.actorId ||
        owner.realmSessionId !== spec.identityCapture.realmSessionId
      ) {
        throw mismatch();
      }
      const observed = await deps.inspectOrganization({
        effect: input,
        organizationId: organization.organizationId,
        owner,
        ownerProof: {
          actorId: spec.actorId,
          realmSessionId: spec.identityCapture.realmSessionId,
          reference: spec.identityProof.reference,
          sha256: spec.identityProof.sha256,
        },
      });
      if (observed !== "applied") {
        return { status: observed };
      }
      try {
        const verified = await verifyMemberships(input, organization.organizationId);
        return { status: verified.complete ? "applied" : "absent" };
      } catch {
        return { status: "unknown" };
      }
    },
  };
};
