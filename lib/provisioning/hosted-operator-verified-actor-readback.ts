import { verifiedActorReadbackSchema } from "./hosted-operator-verified-actor-contract";
import { HostedOperatorError } from "./hosted-operator-contract";
import { createNormalActorRuntimeBindings } from "./hosted-operator-normal-actor-runtime-bindings";
import {
  normalActorIdentityManifestSchema,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";

/** Reuse current-owner, original account approval and live normal-session verification.
 * The private runtime projection may include cookies: only return the allowlisted result. */
export const createVerifiedActorReadback = (
  deps: Parameters<typeof createNormalActorRuntimeBindings>[0],
) => {
  const verifiedBindings = createNormalActorRuntimeBindings(deps);
  return async (input: Parameters<ReturnType<typeof createNormalActorRuntimeBindings>>[0]) => {
    const projection = await verifiedBindings(input);
    if (projection === undefined || input.plan.normalActorProgram === undefined) {
      throw new HostedOperatorError("auth_identity_required");
    }
    const program = normalActorProgramSchema.parse(input.plan.normalActorProgram);
    const manifest = normalActorIdentityManifestSchema.parse(projection.identities);
    const seen = new Set<string>();
    const actors = manifest.actors.map((identity) => {
      const actor = program.actors.find((entry) => entry.actorKey === identity.actorKey);
      const membership = program.memberships.find(
        (entry) =>
          entry.actorKey === identity.actorKey && entry.organizationId === identity.organizationId,
      );
      const grant = program.appAccess.find(
        (entry) =>
          entry.actorKey === identity.actorKey && entry.organizationId === identity.organizationId,
      );
      const key = JSON.stringify([identity.actorKey, identity.organizationId]);
      const roles = grant?.roles ?? [];
      if (
        // oxlint-disable-next-line sonarjs/expression-complexity -- Identity, membership, duplicates and approved roles are independent authority checks.
        actor === undefined ||
        seen.has(key) ||
        (identity.organizationId !== null && membership === undefined) ||
        (identity.organizationId === null &&
          program.memberships.some((entry) => entry.actorKey === identity.actorKey)) ||
        JSON.stringify(identity.roles.toSorted()) !== JSON.stringify(roles.toSorted())
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      seen.add(key);
      return {
        actorKey: actor.actorKey,
        account: actor.account,
        email: actor.email,
        actorId: identity.actorId,
        organizationId: identity.organizationId,
        membershipRole: membership?.role ?? null,
        appRoles: roles,
      };
    });
    if (
      program.actors.some((actor) => !actors.some((row) => row.actorKey === actor.actorKey)) ||
      program.memberships.some(
        (entry) => !seen.has(JSON.stringify([entry.actorKey, entry.organizationId])),
      )
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return verifiedActorReadbackSchema.parse({ requestCorrelation: "not_established", actors });
  };
};
