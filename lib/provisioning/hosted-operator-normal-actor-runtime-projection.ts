import { HostedOperatorError } from "./hosted-operator-contract";
import {
  assertNormalActorState,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import type {
  NormalActorProgram,
  NormalActorState,
  NormalActorRuntimeProjection,
} from "./hosted-operator-normal-actor-program";

const scopedSessionFor = (input: {
  state: NormalActorState;
  program: NormalActorProgram;
  actorKey: string;
  actorId: string;
  organizationId: string;
}) => {
  const scoped = input.state.organizationSessions?.find(
    (entry) => entry.actorKey === input.actorKey && entry.organizationId === input.organizationId,
  );
  if (scoped === undefined) {
    throw new HostedOperatorError("auth_identity_required");
  }
  if (scoped.session.actorId !== input.actorId || scoped.session.origin !== input.program.origin) {
    throw new Error("normal_actor_program_mismatch");
  }
  if (
    scoped.selection !== "selected" ||
    scoped.session.activeOrganizationId !== input.organizationId
  ) {
    throw new HostedOperatorError("auth_identity_required");
  }
  return scoped;
};

/** Server-only projection of captured normal sessions. Never return this from a public tool. */
export const projectNormalActorRuntime = (input: {
  program: NormalActorProgram;
  state: NormalActorState;
  operationRef: string;
}): NormalActorRuntimeProjection => {
  let program: NormalActorProgram;
  let state: NormalActorState;
  try {
    program = normalActorProgramSchema.parse(input.program);
    state = assertNormalActorState(program, input.state, input.operationRef);
  } catch (error) {
    if (error instanceof Error && error.message === "normal_actor_session_selection_required") {
      throw new HostedOperatorError("auth_identity_required");
    }
    // oxlint-disable-next-line eslint/preserve-caught-error -- Parser diagnostics can include private session data; expose only the closed authority failure.
    throw new Error("normal_actor_program_mismatch");
  }
  if (
    state.organizations.some((organization) => organization.status !== "complete") ||
    state.memberships.some((membership) => membership.status !== "complete")
  ) {
    throw new Error("normal_actor_preparation_incomplete");
  }
  const files: Record<string, string> = {};
  const actors: NormalActorRuntimeProjection["identities"]["actors"] = [];
  for (const actor of state.actors) {
    if (
      actor.signup !== "complete" ||
      actor.session === undefined ||
      actor.storageState === undefined
    ) {
      throw new Error("normal_actor_preparation_incomplete");
    }

    const { actorId } = actor.session;
    const memberships = program.memberships.filter(
      (membership) => membership.actorKey === actor.actorKey,
    );
    if (memberships.length === 0) {
      const storageState = `${actor.actorKey}-${actor.session.reference}.storage.json`;
      files[storageState] = JSON.stringify(actor.storageState);
      actors.push({
        actorKey: actor.actorKey,
        actorId,
        organizationId: null,
        roles: [],
        storageState,
      });
    } else {
      const realmSessions = new Set<string>();
      const references = new Set<string>();
      for (const membership of memberships) {
        const scoped = scopedSessionFor({
          state,
          program,
          actorKey: actor.actorKey,
          actorId,
          organizationId: membership.organizationId,
        });
        const { reference, realmSessionId } = scoped.session;
        // Active organization belongs to the real Realm session; one session cannot attest two contexts.
        if (realmSessions.has(realmSessionId) || references.has(reference)) {
          throw new HostedOperatorError("auth_identity_required");
        }
        realmSessions.add(realmSessionId);
        references.add(reference);
        const storageState = `${actor.actorKey}-${reference}.storage.json`;
        files[storageState] = JSON.stringify(scoped.storageState);
        const access = program.appAccess.find(
          (grant) =>
            grant.actorKey === actor.actorKey && grant.organizationId === membership.organizationId,
        );
        actors.push({
          actorKey: actor.actorKey,
          actorId,
          organizationId: membership.organizationId,
          roles: [...(access?.roles ?? [])],
          storageState,
        });
      }
    }
  }
  return { origin: program.origin, identities: { version: 1, actors }, files };
};
