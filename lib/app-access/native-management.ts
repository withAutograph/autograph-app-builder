import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  RepositoryProductionScope,
  RepositoryProductionRow,
} from "../provisioning/repository-production-contract";
import { repositoryProductionOperationRef } from "../provisioning/repository-production-contract";
import type { RepositoryProductionEffectContext } from "../provisioning/repository-production-setup";
import type { createRepositoryProductionWorkers } from "../provisioning/repository-production-workers";
import { AppAccessError } from "./errors";
import { createAppAccessManagementService } from "./management";
import type { AppAccessEffectContext, AppAccessManagementDependencies } from "./management";
import { appAccessSnapshotSchema } from "./contracts";
import type { AppAccessCommand, AppAccessSnapshot } from "./contracts";

type Json = z.infer<ReturnType<typeof z.json>>;
type Workers = Pick<
  ReturnType<typeof createRepositoryProductionWorkers>,
  "invokeAuthManagement" | "mutateAppAccess" | "inspectAppAccess"
>;
export interface RepositoryProductionManagementDependencies extends Pick<
  AppAccessManagementDependencies,
  // oxlint-disable-next-line sonarjs/max-union-size -- This enumerates required service ports, not alternative runtime states.
  "resolve" | "assertAuthorized" | "withLease" | "journal"
> {
  builderOrigin: string;
  readSetup: (scope: RepositoryProductionScope) => Promise<RepositoryProductionRow | undefined>;
  workers: (scope: RepositoryProductionScope) => Workers;
  realm: (scope: RepositoryProductionScope) => Json;
  appUrl: (scope: RepositoryProductionScope) => Promise<string>;
  roles: (scope: RepositoryProductionScope) => Promise<string[]>;
  retrySetup: (scope: RepositoryProductionScope, context: AppAccessEffectContext) => Promise<void>;
  renewSignIn: (scope: RepositoryProductionScope, context: AppAccessEffectContext) => Promise<void>;
}

const CHANGE_ROLE_ACTION = "change-role";

const invitationSchema = z.object({
  id: z.uuid(),
  appId: z.string(),
  organizationId: z.string(),
  email: z.email(),
  roles: z.array(z.string()),
  scopeDigest: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  status: z.enum(["pending", "verified", "accepted", "cancelled"]),
  verifiedActorId: z.string().nullable(),
  deliveryStatus: z.enum(["ready", "sending", "sent", "unknown"]).optional(),
  deliveryAttemptId: z.string().nullable().optional(),
});
const memberPreimageSchema = z.object({
  kind: z.literal("access-member-preimage"),
  id: z.string(),
  email: z.email(),
  roles: z.array(z.string()),
});
const readMemberPreimage = (effect: AppAccessEffectContext, memberId: string) => {
  for (const frame of effect.readCheckpoints()) {
    const parsed = memberPreimageSchema.safeParse(frame);
    if (parsed.success && parsed.data.id === memberId) {
      return parsed.data;
    }
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- No saved member snapshot exists before the first execution.
  return undefined;
};
const operationId = (requestId: string, step: string) => {
  const hex = createHash("sha256").update(`${requestId}:${step}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const readEffect = (assertCurrent: () => Promise<void>): AppAccessEffectContext => ({
  operationRef: randomUUID(),
  createdAt: new Date().toISOString(),
  assertCurrent,
  checkpoint: () => Promise.resolve(),
  readCheckpoints: () => [],
});

/** Concrete access adapter over the same pinned Auth and generated-data workers as setup. */
export const createRepositoryProductionManagement = (
  deps: RepositoryProductionManagementDependencies,
) => {
  const contextFor = async (
    scope: RepositoryProductionScope,
    effect: AppAccessEffectContext,
    step: string,
  ): Promise<RepositoryProductionEffectContext> => {
    await effect.assertCurrent();
    const setup = await deps.readSetup(scope);
    if (!setup?.record.lease) {
      throw new AppAccessError("app_access_unavailable");
    }
    const id = operationId(effect.operationRef, step);
    return {
      row: {
        ...setup,
        operationRef: id,
        record: {
          ...setup.record,
          effects: {
            ...setup.record.effects,
            "creator-access": { state: "pending", attemptId: id },
          },
        },
      },
      effect: "creator-access",
      assertCurrent: effect.assertCurrent,
      checkpoint: effect.checkpoint,
    };
  };
  const auth = async (
    scope: RepositoryProductionScope,
    request: Json,
    readOnly: boolean,
    effect: AppAccessEffectContext,
    step: string,
  ): Promise<Json> => {
    const context = await contextFor(scope, effect, step);
    const response = await deps.workers(scope).invokeAuthManagement(
      context,
      {
        version: 1,
        realm: deps.realm(scope),
        builderOrigin: deps.builderOrigin,
        scope: { appId: scope.appId, organizationId: scope.organizationId },
        request,
      },
      readOnly,
    );
    await effect.assertCurrent();
    return z.object({ result: z.json() }).parse(response).result;
  };
  const invitation = async (
    scope: RepositoryProductionScope,
    id: string,
    effect: AppAccessEffectContext,
  ) => {
    const raw = await auth(scope, { action: "read", invitationId: id }, true, effect, `read:${id}`);
    if (raw === null) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- An absent invitation is part of the read contract.
      return undefined;
    }
    const found = invitationSchema.parse(raw);
    if (found.appId !== scope.appId || found.organizationId !== scope.organizationId) {
      throw new AppAccessError("app_access_denied");
    }
    return found;
  };
  const members = async (scope: RepositoryProductionScope, effect: AppAccessEffectContext) =>
    appAccessSnapshotSchema.shape.members.parse(
      await auth(scope, { action: "list-members" }, true, effect, "list-members"),
    );

  const setAccess = async (
    scope: RepositoryProductionScope,
    actorId: string,
    roles: string[],
    active: boolean,
    effect: AppAccessEffectContext,
    step: string,
  ) => {
    const context = await contextFor(scope, effect, step);
    if (context.row.record.intent.storage.kind === "none") {
      await auth(scope, { action: "set-access", actorId, roles, active }, false, effect, step);
      return;
    }
    await deps.workers(scope).mutateAppAccess(context, { actorId, roles, active });
  };
  const accessState = async (
    scope: RepositoryProductionScope,
    actorId: string,
    roles: string[],
    active: boolean,
    effect: AppAccessEffectContext,
  ) => {
    const context = await contextFor(scope, effect, `inspect:${actorId}:${active}`);
    if (context.row.record.intent.storage.kind === "none") {
      const people = await members(scope, effect);
      const member = people.find((person) => person.id === actorId);
      const assigned = new Set(member?.roles);
      if (active) {
        return member !== undefined && roles.every((role) => assigned.has(role))
          ? ("applied" as const)
          : ("absent" as const);
      }
      return member === undefined || !roles.some((role) => assigned.has(role))
        ? ("applied" as const)
        : ("absent" as const);
    }
    const result = await deps.workers(scope).inspectAppAccess(context, { actorId, roles, active });
    return result.state === "not-applied" ? ("absent" as const) : result.state;
  };
  const cancelMemberInvitations = async (
    scope: RepositoryProductionScope,
    member: { id: string; email: string },
    effect: AppAccessEffectContext,
  ) => {
    const cancellationSchema = z.object({
      kind: z.literal("access-member-invitation-cancellations"),
      memberId: z.string(),
      invitations: z.array(z.object({ id: z.string(), scopeDigest: z.string() })),
    });
    let captured: z.infer<typeof cancellationSchema> | undefined;
    for (const frame of effect.readCheckpoints()) {
      const parsed = cancellationSchema.safeParse(frame);
      if (parsed.success && parsed.data.memberId === member.id) {
        captured = parsed.data;
        break;
      }
    }
    if (captured === undefined) {
      const existing = z
        .array(invitationSchema)
        .parse(await auth(scope, { action: "list" }, true, effect, "remove-invitations"));
      captured = {
        kind: "access-member-invitation-cancellations",
        memberId: member.id,
        invitations: [],
      };
      for (const item of existing) {
        const sameApp = item.appId === scope.appId && item.organizationId === scope.organizationId;
        const samePerson =
          item.email.toLowerCase() === member.email.toLowerCase() ||
          item.verifiedActorId === member.id;
        const pending = item.status === "pending" || item.status === "verified";
        if (
          sameApp &&
          samePerson &&
          pending &&
          item.id !== repositoryProductionOperationRef(scope)
        ) {
          captured.invitations.push({ id: item.id, scopeDigest: item.scopeDigest });
        }
      }
      await effect.checkpoint(captured);
    }
    // Each cancellation is reconciled before advancing; these mutations share the held app lease.
    /* oxlint-disable eslint/no-await-in-loop */
    for (const item of captured.invitations) {
      const found = await invitation(scope, item.id, effect);
      if (found === undefined || found.status === "cancelled" || found.status === "accepted") {
        continue;
      }
      if (found.scopeDigest !== item.scopeDigest) {
        throw new AppAccessError("app_access_denied");
      }
      await auth(
        scope,
        { action: "cancel", invitationId: item.id, scopeDigest: item.scopeDigest },
        false,
        effect,
        `remove-invitation:${item.id}`,
      );
      const confirmed = await invitation(scope, item.id, effect);
      if (confirmed !== undefined && confirmed.status !== "cancelled") {
        throw new AppAccessError("app_access_unknown");
      }
    }
    /* oxlint-enable eslint/no-await-in-loop */
  };
  const updateMember = async (
    scope: RepositoryProductionScope,
    command: Extract<AppAccessCommand, { action: "change-role" | "remove" }>,
    effect: AppAccessEffectContext,
  ) => {
    const preimage = readMemberPreimage(effect, command.memberId);
    const people = preimage === undefined ? await members(scope, effect) : [];
    const member = preimage ?? people.find((person) => person.id === command.memberId);
    if (member === undefined) {
      return "rejected" as const;
    }
    if (preimage === undefined) {
      await effect.checkpoint({
        kind: "access-member-preimage",
        id: member.id,
        email: member.email,
        roles: member.roles,
      });
    }
    if (command.action === "remove") {
      await cancelMemberInvitations(scope, member, effect);
    }
    const desired = command.action === "remove" ? [] : command.roles;
    if (member.roles.length === 0 && desired.length > 0) {
      const setup = await deps.readSetup(scope);
      if (setup?.record.intent.storage.kind === "postgres") {
        await setAccess(scope, member.id, [], false, effect, "revoke-roleless");
      }
    }
    const selected = new Set(desired);
    const removed = member.roles.filter((role) => !selected.has(role));
    if (removed.length > 0 || command.action === "remove") {
      await setAccess(scope, member.id, removed, false, effect, "revoke");
    }
    if (command.action === CHANGE_ROLE_ACTION) {
      await setAccess(scope, member.id, desired, true, effect, "grant");
    }
    return "applied" as const;
  };
  const reconcileInvitation = async (
    scope: RepositoryProductionScope,
    command: Extract<AppAccessCommand, { action: "invite" | "resend" | "cancel" }>,
    effect: AppAccessEffectContext,
  ) => {
    const id = command.action === "invite" ? command.clientRequestId : command.invitationId;
    const found = await invitation(scope, id, effect);
    if (!found) {
      return command.action === "invite" ? ("absent" as const) : ("unknown" as const);
    }
    if (command.action === "cancel") {
      return found.status === "cancelled" ? ("applied" as const) : ("absent" as const);
    }
    // A retained sending attempt may have delivered before its acknowledgement was lost.
    // Only an explicit new Resend may authorize another token and message.
    const deliveryCompleted =
      found.deliveryStatus === "sent" ||
      found.deliveryStatus === "unknown" ||
      found.deliveryStatus === "sending";
    const sameAttempt = found.deliveryAttemptId === operationId(effect.operationRef, "send");
    return (deliveryCompleted && sameAttempt) || found.status !== "pending"
      ? ("applied" as const)
      : ("absent" as const);
  };
  const reconcileMember = async (
    scope: RepositoryProductionScope,
    command: Extract<AppAccessCommand, { action: "change-role" | "remove" }>,
    effect: AppAccessEffectContext,
  ) => {
    const people = await members(scope, effect);
    const member = people.find((person) => person.id === command.memberId);
    if (command.action === "remove") {
      if (member !== undefined) {
        return "absent" as const;
      }
      return await accessState(scope, command.memberId, await deps.roles(scope), false, effect);
    }
    const assigned = new Set(member?.roles);
    if (
      member === undefined ||
      member.roles.length !== command.roles.length ||
      !command.roles.every((role) => assigned.has(role))
    ) {
      return "absent" as const;
    }
    const preimage = readMemberPreimage(effect, member.id);
    if (preimage?.roles.length === 0 && command.roles.length > 0) {
      const setup = await deps.readSetup(scope);
      if (setup?.record.intent.storage.kind === "postgres") {
        const admission = await accessState(scope, member.id, [], false, effect);
        if (admission !== "applied") {
          return admission;
        }
      }
    }
    const available = await deps.roles(scope);
    const selected = new Set(command.roles);
    const removed = available.filter((role) => !selected.has(role));
    if (
      removed.length > 0 &&
      (await accessState(scope, member.id, removed, false, effect)) !== "applied"
    ) {
      return "absent" as const;
    }
    return await accessState(scope, member.id, command.roles, true, effect);
  };
  const service = createAppAccessManagementService({
    ...deps,
    readPeople: async (scope, cursor) => {
      if (!(await deps.readSetup(scope))) {
        return { members: [], invitations: [] };
      }
      return await deps.withLease(scope, async (assertCurrent) => {
        const effect = readEffect(assertCurrent);
        const people = await members(scope, effect);
        const invites = z
          .array(invitationSchema)
          .parse(await auth(scope, { action: "list" }, true, effect, "list"));
        const visible: AppAccessSnapshot["invitations"] = [];
        for (const item of invites) {
          if (
            item.id === repositoryProductionOperationRef(scope) ||
            (item.status !== "pending" && item.status !== "verified")
          ) {
            continue;
          }
          const projected: AppAccessSnapshot["invitations"][number] = {
            id: item.id,
            email: item.email,
            roles: item.roles,
            status: Date.parse(item.expiresAt) <= Date.now() ? "expired" : "pending",
            expiresAt: item.expiresAt,
          };
          if (item.deliveryStatus !== undefined) {
            projected.deliveryStatus =
              item.deliveryStatus === "sending" ? "unknown" : item.deliveryStatus;
          }
          visible.push(projected);
        }
        // Pages bound a response, never the number of people an app can have.
        const offset = cursor === undefined ? 0 : Number(cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new AppAccessError("request_invalid");
        }
        const pageSize = 50;
        const page: Pick<AppAccessSnapshot, "members" | "invitations" | "nextCursor"> = {
          members: people.slice(offset, offset + pageSize),
          invitations: visible.slice(offset, offset + pageSize),
        };
        if (Math.max(people.length, visible.length) > offset + pageSize) {
          page.nextCursor = String(offset + pageSize);
        }
        return page;
      });
    },
    execute: async (scope, command, effect) => {
      if (
        (command.action === "resend" || command.action === "cancel") &&
        command.invitationId === repositoryProductionOperationRef(scope)
      ) {
        return "rejected";
      }
      const expiresAt = new Date(
        Date.parse(effect.createdAt) + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      if (command.action === "invite") {
        const existing = await invitation(scope, command.clientRequestId, effect);
        if (!existing) {
          await auth(
            scope,
            {
              action: "create",
              invitation: {
                id: command.clientRequestId,
                email: command.email,
                roles: command.roles,
                expiresAt,
                returnUrl: await deps.appUrl(scope),
              },
            },
            false,
            effect,
            "create",
          );
        }
        await auth(
          scope,
          { action: "send", invitationId: command.clientRequestId },
          false,
          effect,
          "send",
        );
      } else if (command.action === "resend" || command.action === "cancel") {
        const found = await invitation(scope, command.invitationId, effect);
        if (!found || found.status === "accepted" || found.status === "cancelled") {
          return "rejected";
        }
        await auth(
          scope,
          {
            action: command.action === "cancel" ? "cancel" : "renew",
            invitationId: found.id,
            scopeDigest: found.scopeDigest,
            ...(command.action === "resend" ? { expiresAt } : {}),
          },
          false,
          effect,
          command.action,
        );
        if (command.action === "resend") {
          await auth(scope, { action: "send", invitationId: found.id }, false, effect, "send");
        }
      } else if (command.action === CHANGE_ROLE_ACTION || command.action === "remove") {
        const result = await updateMember(scope, command, effect);
        if (result === "rejected") {
          return result;
        }
      } else if (command.action === "retry-setup") {
        await deps.retrySetup(scope, effect);
      } else {
        await deps.renewSignIn(scope, effect);
      }
      await effect.assertCurrent();
      return "applied";
    },
    reconcile: async (scope, command, effect) => {
      if (
        (command.action === "resend" || command.action === "cancel") &&
        command.invitationId === repositoryProductionOperationRef(scope)
      ) {
        throw new AppAccessError("request_invalid");
      }
      if (
        command.action === "invite" ||
        command.action === "resend" ||
        command.action === "cancel"
      ) {
        return await reconcileInvitation(scope, command, effect);
      }
      if (command.action === CHANGE_ROLE_ACTION || command.action === "remove") {
        return await reconcileMember(scope, command, effect);
      }
      // Setup and link renewal have their own durable same-operation reconciliation.
      return "absent";
    },
    readVerifiedInvitation: async (scope, id, effect) => {
      const found = await invitation(scope, id, effect);
      const verified = found?.status === "verified" || found?.status === "accepted";
      if (found === undefined || !verified) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- No verified invitation must remain distinct from an actor identity.
        return undefined;
      }
      if (found.verifiedActorId === null || found.verifiedActorId === "") {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing verified actor cannot grant access.
        return undefined;
      }
      return {
        actorId: found.verifiedActorId,
        email: found.email,
        roles: found.roles,
        accepted: found.status === "accepted",
      };
    },
    enrollInvitee: async (scope, id, actorId, roles, effect) => {
      const found = await invitation(scope, id, effect);
      if (!found || found.verifiedActorId !== actorId) {
        throw new AppAccessError("app_access_denied");
      }
      await auth(
        scope,
        { action: "prepare-member", invitationId: id, scopeDigest: found.scopeDigest, actorId },
        false,
        effect,
        "join",
      );
      await setAccess(scope, actorId, roles, true, effect, "invitee-grant");
    },
    reconcileInvitee: async (scope, _id, actorId, roles, effect) =>
      await accessState(scope, actorId, roles, true, effect),
    acceptInvitation: async (scope, id, actorId, effect) => {
      const found = await invitation(scope, id, effect);
      if (!found || found.verifiedActorId !== actorId) {
        throw new AppAccessError("app_access_denied");
      }
      await auth(
        scope,
        { action: "complete", invitationId: id, scopeDigest: found.scopeDigest, actorId },
        false,
        effect,
        "complete",
      );
    },
  });
  return service;
};
