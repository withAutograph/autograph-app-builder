import { z } from "zod";
import {
  repositoryProductionDigest,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";

type Json = z.infer<ReturnType<typeof z.json>>;
const CREATOR_LINK_KIND = "repository-production-creator-link-v1";
const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const linkedCreatorSchema = z.strictObject({
  sourceInvitationId: z.uuid(),
  sourceScopeDigest: digest,
  actorId: id,
});
const frameSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal(CREATOR_LINK_KIND),
  invitationId: z.uuid(),
  scopeDigest: digest,
  sessionId: id,
  email: z.email(),
  roles: z.array(id),
  returnUrl: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  realmDigest: digest.optional(),
  linkedCreator: linkedCreatorSchema.optional(),
  renewal: z
    .strictObject({ requestId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) })
    .optional(),
});
type CreatorFrame = z.infer<typeof frameSchema>;
const invitationSchema = z.object({
  id: z.uuid(),
  workspaceId: id,
  appId: id,
  organizationId: id,
  email: z.email(),
  roles: z.array(id),
  returnUrl: z.url(),
  operationRef: z.uuid(),
  scopeDigest: digest,
  expiresAt: z.iso.datetime({ offset: true }),
  status: z.enum(["pending", "verified", "accepted", "cancelled"]),
  verifiedActorId: id.nullable(),
  verifiedSessionId: id.nullable(),
  linkedFromInvitationId: z.uuid().nullable().optional(),
  deliveryStatus: z.enum(["ready", "sending", "sent", "unknown"]),
});
type Invitation = z.infer<typeof invitationSchema>;
export type RepositoryProductionManagedCreator =
  | {
      kind: "managed-invitation";
      invitationId: string;
      actorId: string;
      scopeDigest: string;
    }
  | { state: "required"; signInUrl?: string };

export interface RepositoryProductionCreatorDependencies {
  builderOrigin: string;
  /** Identifies the Auth resource and issuer; excludes app membership and delivery metadata. */
  realmDigest: (scope: RepositoryProductionScope) => string;
  /** Completed setup journals for the same authenticated Builder owner, paged without a total cap. */
  linkedCreatorCandidates: (row: RepositoryProductionRow) => AsyncIterable<RepositoryProductionRow>;
  /** Canonical authenticated Builder owner. Email is delivery information, never identity proof. */
  readOwner: (row: RepositoryProductionRow) => Promise<{ email: string }>;
  readCurrent: (scope: RepositoryProductionScope) => Promise<RepositoryProductionRow | undefined>;
  findInvitation: (invitationId: string) => Promise<RepositoryProductionRow | undefined>;
  /** Protected Auth read; returns the raw invitation, or null when authoritatively absent. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- This untrusted worker boundary is parsed by invitationSchema before use.
  readInvitation: (row: RepositoryProductionRow, invitationId: string) => Promise<unknown>;
  /** Protected Auth request, using the supplied stable operation and attempt identities. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Mutation output is never trusted; an independent parsed read confirms it.
  invokeAuth: (context: RepositoryProductionEffectContext, request: Json) => Promise<unknown>;
  assertAuthorized: (row: RepositoryProductionRow) => Promise<void>;
  /** Resume the original approved setup through its normal lease and continuation. */
  resume: (row: RepositoryProductionRow, originalSessionId: string) => Promise<{ state: string }>;
  now?: () => Date;
}

const operationId = (invitationId: string, step: string) => {
  const value = repositoryProductionDigest({ invitationId, step });
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
};
const rolesEqual = (left: string[], right: string[]) =>
  repositoryProductionDigest(left.toSorted()) === repositoryProductionDigest(right.toSorted());

/** A durable owner-to-Auth link inside the existing app setup journal; no separate provisioning engine. */
export const createRepositoryProductionCreator = (
  deps: RepositoryProductionCreatorDependencies,
) => {
  const origin = new URL(deps.builderOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.origin !== deps.builderOrigin
  ) {
    throw new Error("repository_production_builder_origin_invalid");
  }
  const now = () => deps.now?.() ?? new Date();
  // Invitation lifetime bounds a bearer sign-in opportunity, not the app/session lifetime.
  const expiresAt = () => new Date(now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const returnUrl = (sessionId: string) =>
    `${origin.origin}/builds/${encodeURIComponent(sessionId)}/access`;
  const frameFor = (row: RepositoryProductionRow): CreatorFrame | undefined => {
    const frames: CreatorFrame[] = [];
    for (const value of row.record.workerCheckpoints) {
      if (
        z.object({ kind: z.literal(CREATOR_LINK_KIND) }).safeParse(value)
          .success
      ) {
        frames.push(frameSchema.parse(value));
      }
    }
    const [first] = frames;
    for (const frame of frames) {
      const sameOriginalOwner =
        first === undefined ||
        repositoryProductionDigest({ ...frame, renewal: null }) ===
          repositoryProductionDigest({ ...first, renewal: null });
      if (
        frame.scopeDigest !== repositoryProductionDigest(row.record.scope) ||
        frame.invitationId !== repositoryProductionOperationRef(row.record.scope) ||
        frame.returnUrl !== returnUrl(frame.sessionId) ||
        !sameOriginalOwner
      ) {
        throw new Error("repository_production_creator_owner_mismatch");
      }
    }
    return frames.at(-1);
  };
  const read = async (
    row: RepositoryProductionRow,
    frame: CreatorFrame,
  ): Promise<Invitation | undefined> => {
    await deps.assertAuthorized(row);
    const raw = await deps.readInvitation(row, frame.invitationId);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const value = invitationSchema.parse(raw);
    const { scope } = row.record;
    const sameApp =
      value.id === frame.invitationId &&
      value.workspaceId === scope.authority.workspaceId &&
      value.appId === scope.appId &&
      value.organizationId === scope.organizationId;
    const sameOwner =
      value.email.toLowerCase() === frame.email && value.returnUrl === frame.returnUrl;
    if (
      !sameApp ||
      !sameOwner ||
      value.operationRef !== operationId(frame.invitationId, "create") ||
      !rolesEqual(value.roles, frame.roles)
    ) {
      throw new Error("repository_production_creator_invitation_mismatch");
    }
    return value;
  };
  const signInUrl = (row: RepositoryProductionRow, frame: CreatorFrame) => {
    const url = new URL("/api/auth/platform/app-invitation/accept", row.record.scope.publicOrigin);
    url.searchParams.set("invitationId", frame.invitationId);
    return url.toString();
  };
  const isVerified = (value: Invitation, frame: CreatorFrame) => {
    if (
      (value.status !== "verified" && value.status !== "accepted") ||
      value.verifiedActorId === null
    ) {
      return false;
    }
    if (frame.linkedCreator === undefined) {
      return value.verifiedSessionId !== null;
    }
    return (
      value.linkedFromInvitationId === frame.linkedCreator.sourceInvitationId &&
      value.verifiedActorId === frame.linkedCreator.actorId
    );
  };
  const current = async (context: RepositoryProductionEffectContext) => {
    await context.assertCurrent();
    const row = await deps.readCurrent(context.row.record.scope);
    if (row === undefined) {
      throw new Error("repository_production_creator_setup_missing");
    }
    await deps.assertAuthorized(row);
    return row;
  };
  const linkedCreator = async (row: RepositoryProductionRow) => {
    const authority = repositoryProductionDigest(row.record.scope.authority);
    const realm = deps.realmDigest(row.record.scope);
    for await (const candidate of deps.linkedCreatorCandidates(row)) {
      if (
        candidate.record.scope.appId === row.record.scope.appId ||
        repositoryProductionDigest(candidate.record.scope.authority) !== authority ||
        candidate.record.effects["creator-access"].state !== "applied"
      ) {
        continue;
      }
      const frame = frameFor(candidate);
      if (frame?.realmDigest !== realm) {
        continue;
      }
      const invitation = await read(candidate, frame);
      if (invitation?.status === "accepted" && isVerified(invitation, frame)) {
        return linkedCreatorSchema.parse({
          sourceInvitationId: invitation.id,
          sourceScopeDigest: invitation.scopeDigest,
          actorId: invitation.verifiedActorId,
        });
      }
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined -- No verified identity exists for this exact owner and Auth realm.
    return undefined;
  };
  const invoke = async (
    context: RepositoryProductionEffectContext,
    frame: CreatorFrame,
    step: string,
    request: Json,
  ) => {
    const row = await current(context);
    const ref = operationId(frame.invitationId, step);
    const result = await deps.invokeAuth(
      {
        ...context,
        effect: "creator-access",
        row: {
          ...row,
          operationRef: ref,
          record: {
            ...row.record,
            effects: {
              ...row.record.effects,
              "creator-access": { state: "pending", attemptId: ref },
            },
          },
        },
      },
      request,
    );
    await context.assertCurrent();
    return result;
  };
  const ensure = async (context: RepositoryProductionEffectContext, frame: CreatorFrame) => {
    let row = await current(context);
    let invitation = await read(row, frame);
    if (invitation === undefined) {
      await invoke(context, frame, "create", {
        action: "create",
        invitation: {
          id: frame.invitationId,
          email: frame.email,
          roles: frame.roles,
          expiresAt: frame.expiresAt,
          returnUrl: frame.returnUrl,
        },
      });
      row = await current(context);
      invitation = await read(row, frame);
      if (invitation === undefined) {
        throw new Error("repository_production_creator_invitation_unconfirmed");
      }
    }
    if (invitation.status !== "pending") {
      return;
    }
    if (frame.linkedCreator !== undefined) {
      await invoke(context, frame, "link-creator", {
        action: "link-creator",
        invitationId: frame.invitationId,
        ...frame.linkedCreator,
      });
      invitation = await read(await current(context), frame);
      if (invitation === undefined || !isVerified(invitation, frame)) {
        throw new Error("repository_production_creator_link_unconfirmed");
      }
      return;
    }
    const { renewal } = frame;
    if (
      renewal !== undefined &&
      Date.parse(invitation.expiresAt) !== Date.parse(renewal.expiresAt)
    ) {
      await invoke(context, frame, `renew:${renewal.requestId}`, {
        action: "renew",
        invitationId: frame.invitationId,
        scopeDigest: invitation.scopeDigest,
        expiresAt: renewal.expiresAt,
      });
      invitation = await read(await current(context), frame);
      if (
        invitation === undefined ||
        Date.parse(invitation.expiresAt) !== Date.parse(renewal.expiresAt)
      ) {
        throw new Error("repository_production_creator_renewal_unconfirmed");
      }
    }
    // An uncertain delivery is reconciled by reading; only a new explicit renewal permits another email.
    if (
      invitation.deliveryStatus === "ready" &&
      Date.parse(invitation.expiresAt) > now().getTime()
    ) {
      await invoke(context, frame, renewal === undefined ? "send" : `send:${renewal.requestId}`, {
        action: "send",
        invitationId: frame.invitationId,
      });
    }
  };
  return {
    async prepare(context: RepositoryProductionEffectContext) {
      const row = await current(context);
      let frame = frameFor(row);
      if (frame === undefined) {
        const owner = await deps.readOwner(row);
        const linked = await linkedCreator(row);
        frame = frameSchema.parse({
          version: 1,
          kind: CREATOR_LINK_KIND,
          invitationId: repositoryProductionOperationRef(row.record.scope),
          scopeDigest: repositoryProductionDigest(row.record.scope),
          sessionId: row.record.intent.sessionId,
          email: owner.email.toLowerCase(),
          roles: [...new Set(row.record.intent.creatorRoles)].toSorted(),
          returnUrl: returnUrl(row.record.intent.sessionId),
          expiresAt: expiresAt(),
          realmDigest: deps.realmDigest(row.record.scope),
          ...(linked === undefined ? {} : { linkedCreator: linked }),
        });
        await context.assertCurrent();
        await context.checkpoint(frame);
      }
      await ensure(context, frame);
    },
    async renew(context: RepositoryProductionEffectContext, requestId: string) {
      z.uuid().parse(requestId);
      const row = await current(context);
      let frame = frameFor(row);
      if (frame === undefined) {
        throw new Error("repository_production_creator_setup_missing");
      }
      const invitation = await read(row, frame);
      if (invitation !== undefined && isVerified(invitation, frame)) {
        return;
      }
      if (invitation?.status === "cancelled") {
        throw new Error("repository_production_creator_invitation_cancelled");
      }
      if (frame.renewal?.requestId !== requestId) {
        const expiry = new Date(
          Math.max(
            Date.parse(expiresAt()),
            Date.parse(invitation?.expiresAt ?? frame.expiresAt) + 1,
          ),
        ).toISOString();
        frame = { ...frame, renewal: { requestId, expiresAt: expiry } };
        await context.assertCurrent();
        await context.checkpoint(frame);
      }
      await ensure(context, frame);
    },
    async readCreator(row: RepositoryProductionRow): Promise<RepositoryProductionManagedCreator> {
      await deps.assertAuthorized(row);
      const frame = frameFor(row);
      if (frame === undefined) {
        return { state: "required" };
      }
      const value = await read(row, frame);
      if (value !== undefined && isVerified(value, frame) && value.verifiedActorId !== null) {
        return {
          kind: "managed-invitation",
          invitationId: frame.invitationId,
          actorId: value.verifiedActorId,
          scopeDigest: value.scopeDigest,
        };
      }
      return { state: "required", signInUrl: signInUrl(row, frame) };
    },
    async describe(row: RepositoryProductionRow) {
      await deps.assertAuthorized(row);
      const frame = frameFor(row);
      if (frame === undefined) {
        return { status: "setting_up" as const };
      }
      const value = await read(row, frame);
      if (value !== undefined && isVerified(value, frame)) {
        return {
          status:
            row.record.effects["creator-access"].state === "applied"
              ? ("ready" as const)
              : ("setting_up" as const),
        };
      }
      return {
        status: "sign_in_required" as const,
        signInUrl: signInUrl(row, frame),
        expiresAt: value?.expiresAt ?? frame.renewal?.expiresAt ?? frame.expiresAt,
        message:
          "Use the secure sign-in link in your email. Builder will finish setting up your app when you return.",
      };
    },
    async complete(invitationId: string): Promise<"not-owned" | "ready" | "pending"> {
      if (!z.uuid().safeParse(invitationId).success) {
        return "not-owned";
      }
      const row = await deps.findInvitation(invitationId);
      if (row === undefined) {
        return "not-owned";
      }
      const frame = frameFor(row);
      if (frame === undefined || frame.invitationId !== invitationId) {
        return "not-owned";
      }
      const value = await read(row, frame);
      if (value === undefined || !isVerified(value, frame)) {
        return "pending";
      }
      const result = await deps.resume(row, frame.sessionId);
      return result.state === "ready" ? "ready" : "pending";
    },
  };
};
