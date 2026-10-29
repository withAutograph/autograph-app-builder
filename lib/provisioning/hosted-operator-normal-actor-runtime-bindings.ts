import { reportOperatorRuntimeIdentityFailure } from "./hosted-operator-consent-diagnostic";
import type { OperatorRuntimeIdentityFailure } from "./hosted-operator-consent-diagnostic";
import { HostedOperatorError } from "./hosted-operator-contract";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import type { NormalActorRuntimeProjection } from "./hosted-operator-normal-actor-program";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import { projectNormalActorRuntime } from "./hosted-operator-normal-actor-runtime-projection";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";

const retainFirstIdentityFailure = (
  failures: Map<unknown, OperatorRuntimeIdentityFailure>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Arbitrary original rejections are opaque map keys, never inspected or emitted.
  error: unknown,
  failure: OperatorRuntimeIdentityFailure,
) => {
  if (!failures.has(error)) {
    failures.set(error, failure);
  }
};

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
    let failure: OperatorRuntimeIdentityFailure = { stage: "authority", reason: "read_failed" };
    const identityFailures = new Map<unknown, OperatorRuntimeIdentityFailure>();
    try {
      await deps.assertCurrentPlan(input);
      failure = { stage: "journal", reason: "read_failed" };
      const prepared = await journal.read(input);
      if (prepared === undefined) {
        failure = { stage: "preparation", reason: "unavailable" };
        throw new HostedOperatorError("auth_identity_required");
      }
      failure = { stage: "preparation", reason: "scope_mismatch" };
      const { preparation, state } = prepared;
      const frozen = input.plan.normalActorPreparation;
      if (frozen === undefined) {
        throw new HostedOperatorError("resource_mismatch");
      }
      if (
        [
          normalActorProgramDigest(input.plan.normalActorProgram) === preparation.programDigest,
          frozen.programDigest === preparation.programDigest,
          frozen.accountOperationRef === preparation.accountOperationRef,
          frozen.accountPlanDigest === preparation.accountPlanDigest,
          frozen.accountApprovalId === preparation.accountApprovalId,
          frozen.accountApprovedByCallId === preparation.accountApprovedByCallId,
        ].some((matches) => !matches)
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      failure = { stage: "projection", reason: "read_failed" };
      const projection = projectNormalActorRuntime({
        program: preparation.program,
        state,
        operationRef: preparation.accountOperationRef,
      });
      failure = { stage: "transport", reason: "read_failed" };
      const fetch = await deps.normalRealmFetch({ context: input, origin: projection.origin });
      await Promise.all(
        projection.identities.actors.map(async (identity) => {
          let identityFailure: OperatorRuntimeIdentityFailure = {
            stage: "session_binding",
            reason: "read_failed",
          };
          try {
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
              identityFailure = { stage: "session_binding", reason: "unavailable" };
              throw new HostedOperatorError("auth_identity_required");
            }
            const client = createHostedOperatorNormalAuthClient({
              origin: projection.origin,
              storageState,
              fetch,
            });
            identityFailure = { stage: "get_session", reason: "read_failed" };
            const actual = await client.getSession();
            if (actual === null) {
              identityFailure = { stage: "get_session", reason: "unavailable" };
              throw new HostedOperatorError("auth_identity_required");
            }
            const selectedOrganization =
              identity.organizationId === null ||
              actual.activeOrganizationId === identity.organizationId;
            const checks: { reason: OperatorRuntimeIdentityFailure["reason"]; matches: boolean }[] =
              [
                { reason: "actor_mismatch", matches: actual.actorId === expected.actorId },
                {
                  reason: "session_mismatch",
                  matches: actual.sessionId === expected.realmSessionId,
                },
                {
                  reason: "email_mismatch",
                  matches: actual.email.toLowerCase() === actor.email.toLowerCase(),
                },
                {
                  reason: "expired",
                  matches: Date.parse(actual.expiresAt) > deps.journalPorts.now(),
                },
                { reason: "selected_organization_mismatch", matches: selectedOrganization },
              ];
            const mismatched = checks.find((check) => !check.matches);
            if (mismatched !== undefined) {
              identityFailure = { stage: "identity", reason: mismatched.reason };
              throw new HostedOperatorError("auth_identity_required");
            }
            if (identity.organizationId !== null) {
              identityFailure = { stage: "membership", reason: "read_failed" };
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
                identityFailure = { stage: "membership", reason: "unavailable" };
                throw new HostedOperatorError("auth_identity_required");
              }
              if (
                [
                  observed.total === 1,
                  observed.members.length === 1,
                  matchesMember(observed.members[0], identity, actor.email, membership.role),
                ].some((matches) => !matches)
              ) {
                identityFailure = { stage: "membership", reason: "membership_mismatch" };
                throw new HostedOperatorError("auth_identity_required");
              }
            }
          } catch (error) {
            retainFirstIdentityFailure(identityFailures, error, identityFailure);
            throw error;
          }
        }),
      );
      failure = { stage: "final_authority", reason: "read_failed" };
      await deps.assertCurrentPlan(input);
      return projection;
    } catch (error) {
      reportOperatorRuntimeIdentityFailure(
        input.target.sessionId,
        identityFailures.get(error) ?? failure,
      );
      throw error;
    }
  };
};
