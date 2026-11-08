import { createHash } from "node:crypto";
import { observeRepositoryProductionPhase } from "../provisioning/repository-production-diagnostic";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { repositoryProductionScopeSchema } from "../provisioning/repository-production-contract";
import { centralHostCanonicalBytes } from "../provisioning/central-integration-host-contract";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import type { RepositoryProductionScope } from "../provisioning/repository-production-contract";
import { appAccessCommandSchema, appAccessSnapshotSchema } from "./contracts";
import type { AppAccessCommand, AppAccessSnapshot } from "./contracts";
import type { AppAccessOwner } from "./operator-client";
import { AppAccessError } from "./errors";

export const appAccessOperationSchema = z.strictObject({
  kind: z.literal("app-access-operation-v1"),
  scope: repositoryProductionScopeSchema,
  ownerContext: operatorOwnerContextSchema,
  command: appAccessCommandSchema,
  state: z.enum(["pending", "applied", "rejected"]),
  dispatched: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  workerCheckpoints: z.array(z.json()).default([]),
  enrollment: z
    .strictObject({ actorId: z.string().min(1), state: z.enum(["pending", "applied"]) })
    .optional(),
});
export type AppAccessOperation = z.infer<typeof appAccessOperationSchema>;
export interface AppAccessOperationRow {
  record: AppAccessOperation;
  revision: number;
}
export interface AppAccessOperationStore {
  reserve: (record: AppAccessOperation) => Promise<AppAccessOperationRow>;
  pending: (scope: RepositoryProductionScope) => Promise<readonly AppAccessOperationRow[]>;
  update: (
    row: AppAccessOperationRow,
    record: AppAccessOperation,
  ) => Promise<AppAccessOperationRow | undefined>;
  findInvitation: (invitationId: string) => Promise<AppAccessOperationRow | undefined>;
}
export interface ManagedAppAccess {
  scope: RepositoryProductionScope;
  appName: string;
  organizationName: string;
  roles: AppAccessSnapshot["roles"];
  creator: AppAccessSnapshot["creator"];
  canManage: boolean;
  appUrl?: string;
}
export interface AppAccessEffectContext {
  operationRef: string;
  createdAt: string;
  assertCurrent: () => Promise<void>;
  checkpoint: (frame: z.infer<ReturnType<typeof z.json>>) => Promise<void>;
  readCheckpoints: () => readonly z.infer<ReturnType<typeof z.json>>[];
}
export interface AppAccessManagementDependencies {
  resolve: (owner: AppAccessOwner) => Promise<ManagedAppAccess>;
  assertAuthorized: (
    owner: AppAccessOwner,
    scope: RepositoryProductionScope,
    mutating: boolean,
  ) => Promise<void>;
  readPeople: (
    scope: RepositoryProductionScope,
    cursor?: string,
  ) => Promise<Pick<AppAccessSnapshot, "members" | "invitations" | "nextCursor">>;
  withLease: <T>(
    scope: RepositoryProductionScope,
    run: (assertCurrent: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  journal: AppAccessOperationStore;
  execute: (
    scope: RepositoryProductionScope,
    command: AppAccessCommand,
    context: AppAccessEffectContext,
  ) => Promise<"applied" | "rejected">;
  reconcile: (
    scope: RepositoryProductionScope,
    command: AppAccessCommand,
    context: AppAccessEffectContext,
  ) => Promise<"applied" | "absent" | "unknown">;
  readVerifiedInvitation: (
    scope: RepositoryProductionScope,
    invitationId: string,
    context: AppAccessEffectContext,
  ) => Promise<{ actorId: string; email: string; roles: string[]; accepted: boolean } | undefined>;
  enrollInvitee: (
    scope: RepositoryProductionScope,
    invitationId: string,
    actorId: string,
    roles: string[],
    context: AppAccessEffectContext,
  ) => Promise<void>;
  reconcileInvitee: (
    scope: RepositoryProductionScope,
    invitationId: string,
    actorId: string,
    roles: string[],
    context: AppAccessEffectContext,
  ) => Promise<"applied" | "absent" | "unknown">;
  acceptInvitation: (
    scope: RepositoryProductionScope,
    invitationId: string,
    actorId: string,
    context: AppAccessEffectContext,
  ) => Promise<void>;
}

const normalizeCommand = (command: AppAccessCommand): AppAccessCommand => {
  const parsed = appAccessCommandSchema.parse(command);
  if (parsed.action === "choose-creator-account") {
    return { ...parsed, email: parsed.email.toLowerCase() };
  }
  return "roles" in parsed ? { ...parsed, roles: [...new Set(parsed.roles)].toSorted() } : parsed;
};

export const appAccessOperationDigest = (
  scope: RepositoryProductionScope,
  command: AppAccessCommand,
): string =>
  createHash("sha256")
    .update(centralHostCanonicalBytes({ scope, command: normalizeCommand(command) }))
    .digest("hex");

/** Access changes use the existing app lock and journal; a lost response is never a new invitation. */
export const createAppAccessManagementService = (deps: AppAccessManagementDependencies) => {
  const read = async (owner: AppAccessOwner, cursor?: string): Promise<AppAccessSnapshot> => {
    const app = await observeRepositoryProductionPhase(
      "access_scope_resolve",
      "binding_unavailable",
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
      () => deps.resolve(owner),
    );
    await deps.assertAuthorized(owner, app.scope, false);
    const people = app.canManage
      ? // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
        await observeRepositoryProductionPhase("access_people", "binding_unavailable", () =>
          deps.readPeople(app.scope, cursor),
        )
      : { members: [], invitations: [] };
    const pending = app.canManage ? await deps.journal.pending(app.scope) : [];
    const pendingCommand = pending.find((row) => row.record.state === "pending")?.record.command;
    await deps.assertAuthorized(owner, app.scope, false);
    const snapshotInput = () => {
      const appDetails: Pick<
        z.input<typeof appAccessSnapshotSchema>,
        | "sessionId"
        | "appId"
        | "appName"
        | "organizationName"
        | "roles"
        | "canManage"
        | "creator"
        | "appUrl"
      > = {
        sessionId: owner.sessionId,
        appId: app.scope.appId,
        appName: app.appName,
        organizationName: app.organizationName,
        roles: app.roles,
        canManage: app.canManage,
        creator: app.creator,
      };
      if (app.appUrl !== undefined) {
        appDetails.appUrl = app.appUrl;
      }
      const snapshot: z.input<typeof appAccessSnapshotSchema> = { ...appDetails, ...people };
      if (pendingCommand !== undefined) {
        snapshot.pendingCommand = pendingCommand;
      }
      return snapshot;
    };
    return appAccessSnapshotSchema.parse(snapshotInput());
  };
  const execute = async (
    owner: AppAccessOwner,
    raw: AppAccessCommand,
  ): Promise<AppAccessSnapshot> => {
    const command = normalizeCommand(raw);
    const app = await deps.resolve(owner);
    if (!app.canManage) {
      throw new AppAccessError("app_access_denied");
    }
    await deps.assertAuthorized(owner, app.scope, true);
    if (
      "roles" in command &&
      command.roles.some((role) => !app.roles.some((allowed) => allowed.id === role))
    ) {
      throw new AppAccessError("app_access_denied");
    }
    await deps.withLease(app.scope, async (assertFence) => {
      const assertCurrent = async () => {
        await assertFence();
        await deps.assertAuthorized(owner, app.scope, true);
      };
      await assertCurrent();
      // Resolving an uncertain mutation precedes a conflicting access change.
      const pending = await deps.journal.pending(app.scope);
      if (pending.some((row) => row.record.command.clientRequestId !== command.clientRequestId)) {
        throw new AppAccessError("app_access_unknown");
      }
      let row = await deps.journal.reserve({
        kind: "app-access-operation-v1",
        scope: app.scope,
        ownerContext: owner.ownerContext,
        command,
        state: "pending",
        dispatched: false,
        createdAt: new Date().toISOString(),
        workerCheckpoints: [],
      });
      if (
        !isDeepStrictEqual(row.record.scope, app.scope) ||
        !isDeepStrictEqual(normalizeCommand(row.record.command), command)
      ) {
        throw new AppAccessError("request_id_conflict");
      }
      if (row.record.state === "applied") {
        return;
      }
      if (row.record.state === "rejected") {
        throw new AppAccessError("app_access_denied");
      }
      const save = async (record: AppAccessOperation) => {
        await assertCurrent();
        const next = await deps.journal.update(row, record);
        if (next === undefined) {
          throw new AppAccessError("app_access_unknown");
        }
        row = next;
      };
      const context = {
        operationRef: command.clientRequestId,
        createdAt: row.record.createdAt,
        assertCurrent,
        readCheckpoints: () => row.record.workerCheckpoints,
        checkpoint: async (frame: z.infer<ReturnType<typeof z.json>>) => {
          await save({
            ...row.record,
            workerCheckpoints: [...row.record.workerCheckpoints, frame],
          });
        },
      };
      if (row.record.dispatched) {
        const result = await deps.reconcile(app.scope, command, context);
        await assertCurrent();
        if (result === "unknown") {
          throw new AppAccessError("app_access_unknown");
        }
        if (result === "applied") {
          await save({ ...row.record, state: "applied" });
          return;
        }
      }
      await save({ ...row.record, dispatched: true });
      let result: "applied" | "rejected";
      try {
        result = await deps.execute(app.scope, command, context);
      } catch {
        throw new AppAccessError("app_access_unknown");
      }
      await save({ ...row.record, state: result });
      if (result === "rejected") {
        throw new AppAccessError("app_access_denied");
      }
    });
    return await read(owner);
  };
  // Called only by the operator's authenticated Auth-workload route. Identity is read
  // from Auth's verified invitation, never accepted from the callback request.
  const completeInvitation = async (invitationId: string): Promise<void> => {
    const saved = await deps.journal.findInvitation(invitationId);
    if (!saved || saved.record.command.action !== "invite" || saved.record.state !== "applied") {
      throw new AppAccessError("app_access_denied");
    }
    const { scope } = saved.record;
    const owner = {
      appId: scope.appId,
      sessionId: saved.record.ownerContext.sessionId,
      ownerContext: saved.record.ownerContext,
    };
    await deps.assertAuthorized(owner, scope, true);
    await deps.withLease(scope, async (assertFence) => {
      const found = await deps.journal.findInvitation(invitationId);
      if (!found || found.record.command.action !== "invite") {
        throw new AppAccessError("app_access_denied");
      }
      let row: AppAccessOperationRow = found;
      if (row.record.enrollment?.state === "applied") {
        return;
      }
      const assertCurrent = async () => {
        await assertFence();
        await deps.assertAuthorized(owner, scope, true);
      };
      await assertCurrent();
      const { command } = found.record;
      const invitation = await deps.readVerifiedInvitation(scope, invitationId, {
        operationRef: invitationId,
        createdAt: row.record.createdAt,
        assertCurrent,
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
        checkpoint: () => Promise.reject(new AppAccessError("app_access_unknown")),
        readCheckpoints: () => row.record.workerCheckpoints,
      });
      if (!invitation) {
        throw new AppAccessError("app_access_denied");
      }
      const identityChanged =
        row.record.enrollment !== undefined && row.record.enrollment.actorId !== invitation.actorId;
      if (
        invitation.email.toLowerCase() !== command.email.toLowerCase() ||
        !isDeepStrictEqual([...invitation.roles].toSorted(), [...command.roles].toSorted()) ||
        identityChanged
      ) {
        throw new AppAccessError("app_access_denied");
      }
      const conflicts = await deps.journal.pending(scope);
      if (conflicts.some((other) => other.record.command.clientRequestId !== invitationId)) {
        throw new AppAccessError("app_access_unknown");
      }
      const context = {
        operationRef: invitationId,
        createdAt: row.record.createdAt,
        assertCurrent,
        readCheckpoints: () => row.record.workerCheckpoints,
        checkpoint: async (frame: z.infer<ReturnType<typeof z.json>>) => {
          await assertCurrent();
          const next = await deps.journal.update(row, {
            ...row.record,
            workerCheckpoints: [...row.record.workerCheckpoints, frame],
          });
          if (!next) {
            throw new AppAccessError("app_access_unknown");
          }
          row = next;
        },
      };
      const saveEnrollment = async (state: "pending" | "applied") => {
        await assertCurrent();
        const next = await deps.journal.update(row, {
          ...row.record,
          enrollment: { actorId: invitation.actorId, state },
        });
        if (!next) {
          throw new AppAccessError("app_access_unknown");
        }
        row = next;
      };
      const reconciled = row.record.enrollment
        ? await deps.reconcileInvitee(
            scope,
            invitationId,
            invitation.actorId,
            command.roles,
            context,
          )
        : "absent";
      if (reconciled === "unknown") {
        throw new AppAccessError("app_access_unknown");
      }
      if (reconciled === "absent") {
        await saveEnrollment("pending");
        await deps.enrollInvitee(scope, invitationId, invitation.actorId, command.roles, context);
      }
      await assertCurrent();
      await deps.acceptInvitation(scope, invitationId, invitation.actorId, context);
      await saveEnrollment("applied");
    });
  };
  return { read, execute, completeInvitation };
};
