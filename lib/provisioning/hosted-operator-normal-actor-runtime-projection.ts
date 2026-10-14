import {
  assertNormalActorState,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import type {
  NormalActorProgram,
  NormalActorState,
  NormalActorRuntimeProjection,
} from "./hosted-operator-normal-actor-program";

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
  } catch {
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
    // The validated semantic alias is unique per approved actor and safe as a private filename.
    const storageState = `${actor.actorKey}.storage.json`;
    files[storageState] = JSON.stringify(actor.storageState);
    const memberships = program.memberships.filter(
      (membership) => membership.actorKey === actor.actorKey,
    );
    if (memberships.length === 0) {
      actors.push({
        actorKey: actor.actorKey,
        actorId: actor.session.actorId,
        organizationId: null,
        roles: [],
        storageState,
      });
    } else {
      for (const membership of memberships) {
        const access = program.appAccess.find(
          (grant) =>
            grant.actorKey === actor.actorKey && grant.organizationId === membership.organizationId,
        );
        actors.push({
          actorKey: actor.actorKey,
          actorId: actor.session.actorId,
          organizationId: membership.organizationId,
          roles: [...(access?.roles ?? [])],
          storageState,
        });
      }
    }
  }
  return { origin: program.origin, identities: { version: 1, actors }, files };
};
