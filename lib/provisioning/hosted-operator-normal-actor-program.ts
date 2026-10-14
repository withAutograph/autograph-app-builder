import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().min(1).max(512);
const actorKey = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const role = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});

/** Public approval input. Credentials and normal session bytes never belong in this program. */
export const normalActorProgramSchema = z
  .strictObject({
    version: z.literal(1),
    appId: actorKey,
    origin,
    actors: z
      .array(
        z.strictObject({
          actorKey,
          email: z.email(),
          name: z.string().min(1).max(120),
          account: z.enum(["capture-existing", "create-email-password"]),
        }),
      )
      .min(1),
    organizations: z.array(
      z.strictObject({
        organizationId: id,
        ownerActorKey: actorKey,
        name: z.string().min(1).max(120),
        slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u),
      }),
    ),
    memberships: z.array(z.strictObject({ actorKey, organizationId: id, role })),
    appAccess: z.array(
      z.strictObject({ actorKey, organizationId: id, roles: z.array(role).min(1) }),
    ),
  })
  .superRefine((program, ctx) => {
    const keys = new Set(program.actors.map((actor) => actor.actorKey));
    const emails = new Set(program.actors.map((actor) => actor.email.toLowerCase()));
    const organizations = new Map(
      program.organizations.map((organization) => [organization.organizationId, organization]),
    );
    const memberships = new Set(
      program.memberships.map((member) => `${member.organizationId}:${member.actorKey}`),
    );
    const access = new Set(
      program.appAccess.map((grant) => `${grant.organizationId}:${grant.actorKey}`),
    );
    const valid = [
      keys.size === program.actors.length,
      emails.size === program.actors.length,
      organizations.size === program.organizations.length,
      memberships.size === program.memberships.length,
      access.size === program.appAccess.length,
      new Set(program.organizations.map((organization) => organization.slug)).size ===
        program.organizations.length,
      program.organizations.every(
        (organization) =>
          keys.has(organization.ownerActorKey) &&
          program.memberships.some(
            (member) =>
              member.organizationId === organization.organizationId &&
              member.actorKey === organization.ownerActorKey &&
              member.role === "owner",
          ),
      ),
      program.memberships.every(
        (member) => keys.has(member.actorKey) && organizations.has(member.organizationId),
      ),
      program.appAccess.every(
        (grant) =>
          memberships.has(`${grant.organizationId}:${grant.actorKey}`) &&
          new Set(grant.roles).size === grant.roles.length,
      ),
    ].every(Boolean);
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        message:
          "Participant program has ambiguous actors or unauthorized organization references.",
      });
    }
  });
export type NormalActorProgram = z.infer<typeof normalActorProgramSchema>;

const canonical = (value: z.infer<ReturnType<typeof z.json>>): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Value is JSON already parsed at the participant program boundary; this branches on its JSON object member.
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",");
    return `{${entries}}`;
  }
  return JSON.stringify(value);
};
export const normalActorProgramDigest = (program: NormalActorProgram): string =>
  createHash("sha256")
    .update(canonical(normalActorProgramSchema.parse(program)))
    .digest("hex");

/** Actual normal Auth cookie bytes. This type is private and must never enter tool results. */
export const normalBrowserStorageStateSchema = z.strictObject({
  cookies: z.array(
    z.strictObject({
      name: id,
      value: z.string().min(1),
      domain: id,
      path: z.string().startsWith("/"),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(["Strict", "Lax", "None"]),
    }),
  ),
  origins: z.array(
    z.strictObject({
      origin,
      localStorage: z.array(z.strictObject({ name: id, value: z.string() })),
    }),
  ),
});
export type NormalBrowserStorageState = z.infer<typeof normalBrowserStorageStateSchema>;
export const normalActorSessionRefSchema = z.strictObject({
  reference: z.uuid(),
  actorId: id,
  realmSessionId: id,
  origin,
  expiresAt: z.iso.datetime({ offset: true }),
});
export type NormalActorSessionRef = z.infer<typeof normalActorSessionRefSchema>;
const stepSchema = z.enum(["pending", "attempted", "complete"]);
export const normalActorCheckpointSchema = z.strictObject({
  actorKey,
  signup: stepSchema,
  credentials: z.strictObject({ password: z.string().min(32).max(512) }).optional(),
  session: normalActorSessionRefSchema.optional(),
  storageState: normalBrowserStorageStateSchema.optional(),
});
export type NormalActorCheckpoint = z.infer<typeof normalActorCheckpointSchema>;
export const normalActorStateSchema = z.strictObject({
  version: z.literal(1),
  operationRef: z.uuid(),
  programDigest: digest,
  actors: z.array(normalActorCheckpointSchema),
  organizations: z.array(z.strictObject({ organizationId: id, status: stepSchema })),
  memberships: z.array(
    z.strictObject({
      actorKey,
      organizationId: id,
      role,
      status: stepSchema,
      invitationId: id.optional(),
    }),
  ),
});
export type NormalActorState = z.infer<typeof normalActorStateSchema>;

export const initialNormalActorState = (
  programInput: NormalActorProgram,
  operationRef: string,
): NormalActorState => {
  const program = normalActorProgramSchema.parse(programInput);
  return normalActorStateSchema.parse({
    version: 1,
    operationRef,
    programDigest: normalActorProgramDigest(program),
    actors: program.actors.map((actor) => ({ actorKey: actor.actorKey, signup: "pending" })),
    organizations: program.organizations.map((organization) => ({
      organizationId: organization.organizationId,
      status: "pending",
    })),
    memberships: program.memberships.map((member) => ({ ...member, status: "pending" })),
  });
};

/** State references are authority: never accept extra actors, memberships, or swapped normal identities. */
export const assertNormalActorState = (
  programInput: NormalActorProgram,
  stateInput: NormalActorState,
  operationRef: string,
): NormalActorState => {
  const program = normalActorProgramSchema.parse(programInput);
  const state = normalActorStateSchema.parse(stateInput);
  const expected = initialNormalActorState(program, operationRef);
  const sessions = state.actors.flatMap((actor) => (actor.session ? [actor.session] : []));
  const matches = [
    state.operationRef === operationRef,
    state.programDigest === expected.programDigest,
    state.actors.length === expected.actors.length,
    new Set(state.actors.map((actor) => actor.actorKey)).size === state.actors.length,
    state.actors.every((actor) =>
      [
        expected.actors.some((entry) => entry.actorKey === actor.actorKey),
        actor.session === undefined || actor.session.origin === program.origin,
        (actor.session === undefined) === (actor.storageState === undefined),
        actor.signup !== "complete" || actor.session !== undefined,
      ].every(Boolean),
    ),
    new Set(sessions.map((session) => session.actorId)).size === sessions.length,
    state.organizations.length === expected.organizations.length,
    new Set(state.organizations.map((organization) => organization.organizationId)).size ===
      state.organizations.length,
    state.organizations.every((organization) =>
      expected.organizations.some((entry) => entry.organizationId === organization.organizationId),
    ),
    state.memberships.length === expected.memberships.length,
    new Set(state.memberships.map((member) => `${member.organizationId}:${member.actorKey}`))
      .size === state.memberships.length,
    state.memberships.every((member) =>
      expected.memberships.some(
        (entry) =>
          entry.actorKey === member.actorKey &&
          entry.organizationId === member.organizationId &&
          entry.role === member.role,
      ),
    ),
  ].every(Boolean);
  if (!matches) {
    throw new Error("normal_actor_program_mismatch");
  }
  return state;
};

/** References only; the actual browser state files are delivered on a private binding channel. */
export const normalActorIdentityManifestSchema = z.strictObject({
  version: z.literal(1),
  actors: z.array(
    z.strictObject({
      actorKey,
      actorId: id,
      organizationId: id.nullable(),
      roles: z.array(role),
      storageState: id,
    }),
  ),
});
export type NormalActorIdentityManifest = z.infer<typeof normalActorIdentityManifestSchema>;
export interface NormalActorRuntimeProjection {
  origin: string;
  identities: NormalActorIdentityManifest;
  files: Record<string, string>;
}

/** Resolve a fresh grant proposal after normal authentication; this does not authorize grants. */
export const proposeResolvedNormalActorAccess = (
  programInput: NormalActorProgram,
  stateInput: NormalActorState,
) => {
  const program = normalActorProgramSchema.parse(programInput);
  const state = assertNormalActorState(program, stateInput, stateInput.operationRef);
  return program.appAccess.map((access) => {
    const actor = state.actors.find((candidate) => candidate.actorKey === access.actorKey);
    if (actor?.signup !== "complete" || !actor.session) {
      throw new Error("normal_actor_preparation_incomplete");
    }
    return {
      actorId: actor.session.actorId,
      organizationId: access.organizationId,
      roles: access.roles,
    };
  });
};

/** Membership verification is required for execution, although the public grant proposal precedes it. */
export const resolvedNormalActorAccess = (program: NormalActorProgram, state: NormalActorState) => {
  const access = proposeResolvedNormalActorAccess(program, state);
  if (
    program.appAccess.some(
      (grant) =>
        !state.memberships.some(
          (member) =>
            member.actorKey === grant.actorKey &&
            member.organizationId === grant.organizationId &&
            member.status === "complete",
        ),
    )
  ) {
    throw new Error("normal_actor_preparation_incomplete");
  }
  return access;
};
