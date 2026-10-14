import { HostedOperatorError } from "./hosted-operator-contract";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import type { NormalActorRuntimeProjection } from "./hosted-operator-normal-actor-program";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import { projectNormalActorRuntime } from "./hosted-operator-normal-actor-runtime-projection";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";

const matchesMember = (
  member:
    | Awaited<
        ReturnType<ReturnType<typeof createHostedOperatorNormalAuthClient>["listMembers"]>
      >["members"][number]
    | undefined,
  identity: NormalActorRuntimeProjection["identities"]["actors"][number],
  email: string,
  role: string,
) =>
  member !== undefined &&
  [
    member.userId === identity.actorId,
    member.user.id === identity.actorId,
    member.user.email.toLowerCase() === email.toLowerCase(),
    member.organizationId === identity.organizationId,
    member.role === role,
  ].every(Boolean);

/** Private runtime handoff: authenticate the actual retained sessions before exporting their jars. */
export const createNormalActorRuntimeBindings = (
  deps: Pick<
    NormalActorOperationsDependencies,
    "journalPorts" | "assertCurrentPlan" | "normalRealmFetch"
  >,
) => {
  const journal = createNormalActorJournal(deps.journalPorts);
  return async (
    input: HostedOperatorContext & { plan: HostedOperatorPlan; operationRef: string },
  ): Promise<NormalActorRuntimeProjection | undefined> => {
    if (input.plan.normalActorProgram === undefined) {
      return undefined;
    }
    await deps.assertCurrentPlan(input);
    const prepared = await journal.read(input);
    if (prepared === undefined) {
      throw new HostedOperatorError("auth_identity_required");
    }
    const { preparation, state } = prepared;
    const frozen = input.plan.normalActorPreparation;
    if (frozen === undefined) {
      throw new HostedOperatorError("resource_mismatch");
    }
    if (
      [
        normalActorProgramDigest(input.plan.normalActorProgram) === preparation.programDigest,
        frozen.accountOperationRef === preparation.accountOperationRef,
        frozen.accountPlanDigest === preparation.accountPlanDigest,
        frozen.accountApprovalId === preparation.accountApprovalId,
        frozen.accountApprovedByCallId === preparation.accountApprovedByCallId,
      ].some((matches) => !matches)
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const projection = projectNormalActorRuntime({
      program: preparation.program,
      state,
      operationRef: preparation.accountOperationRef,
    });
    const fetch = await deps.normalRealmFetch({ context: input, origin: projection.origin });
    await Promise.all(
      projection.identities.actors.map(async (identity) => {
        const actor = preparation.program.actors.find(
          (entry) => entry.actorKey === identity.actorKey,
        );
        const retained = state.actors.find((entry) => entry.actorKey === identity.actorKey);
        const scoped = state.organizationSessions?.find(
          (entry) =>
            entry.actorKey === identity.actorKey &&
            entry.organizationId === identity.organizationId,
        );
        const expected = identity.organizationId === null ? retained?.session : scoped?.session;
        const storageState =
          identity.organizationId === null ? retained?.storageState : scoped?.storageState;
        if (actor === undefined || expected === undefined || storageState === undefined) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const client = createHostedOperatorNormalAuthClient({
          origin: projection.origin,
          storageState,
          fetch,
        });
        const actual = await client.getSession();
        if (actual === null) {
          throw new HostedOperatorError("auth_identity_required");
        }
        const selectedOrganization =
          identity.organizationId === null
            ? actual.activeOrganizationId === null || actual.activeOrganizationId === undefined
            : actual.activeOrganizationId === identity.organizationId;
        if (
          [
            actual.actorId === expected.actorId,
            actual.sessionId === expected.realmSessionId,
            actual.email.toLowerCase() === actor.email.toLowerCase(),
            Date.parse(actual.expiresAt) > deps.journalPorts.now(),
            selectedOrganization,
          ].some((matches) => !matches)
        ) {
          throw new HostedOperatorError("auth_identity_required");
        }
        if (identity.organizationId !== null) {
          const membership = preparation.program.memberships.find(
            (entry) =>
              entry.actorKey === identity.actorKey &&
              entry.organizationId === identity.organizationId,
          );
          const observed = await client.listMembers({
            organizationId: identity.organizationId,
            userId: identity.actorId,
          });
          if (membership === undefined) {
            throw new HostedOperatorError("auth_identity_required");
          }
          if (
            [
              observed.total === 1,
              observed.members.length === 1,
              matchesMember(observed.members[0], identity, actor.email, membership.role),
            ].some((matches) => !matches)
          ) {
            throw new HostedOperatorError("auth_identity_required");
          }
        }
      }),
    );
    await deps.assertCurrentPlan(input);
    return projection;
  };
};
