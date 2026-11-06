import { z } from "zod";
import type { AppAccessCommand } from "../app-access/contracts";
import { AppAccessError } from "../app-access/errors";
import type { RepositoryProductionRow } from "./repository-production-contract";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";

const preimageSchema = z.object({
  kind: z.literal("repository-production-creator-role-preimage"),
  commandId: z.uuid(),
  actorId: z.string(),
  active: z.boolean(),
});

/** A pending schema/role update and ordinary People mutations share the same app lease. */
export const assertNoConflictingCreatorRoleUpdate = (input: {
  row: RepositoryProductionRow | undefined;
  commandId?: string;
  pendingCommandIds: readonly string[];
}) => {
  if (input.row?.record.creatorRoleUpdate?.state !== "pending") {
    return;
  }
  if (input.commandId !== undefined && input.pendingCommandIds.includes(input.commandId)) {
    return;
  }
  throw new AppAccessError("app_access_unknown");
};

/** Newly approved roles update an existing active grant. A removed creator never becomes active again. */
export const createRepositoryProductionRoleUpdater =
  (deps: {
    readMembers: (context: RepositoryProductionEffectContext) => Promise<readonly { id: string }[]>;
    execute: (
      context: RepositoryProductionEffectContext,
      command: AppAccessCommand,
    ) => Promise<void>;
  }) =>
  async (context: RepositoryProductionEffectContext): Promise<"applied" | "skipped"> => {
    const update = context.row.record.creatorRoleUpdate;
    const actorId = context.row.record.creatorActorId;
    if (update === undefined || actorId === undefined || update.state !== "pending") {
      throw new Error("repository_production_role_update_unavailable");
    }
    await context.assertCurrent();
    let preimage = context.row.record.workerCheckpoints
      .flatMap((value) => {
        const parsed = preimageSchema.safeParse(value);
        return parsed.success && parsed.data.commandId === update.commandId ? [parsed.data] : [];
      })
      .at(-1);
    if (preimage && preimage.actorId !== actorId) {
      throw new Error("repository_production_role_update_owner_changed");
    }
    if (!preimage) {
      const members = await deps.readMembers(context);
      await context.assertCurrent();
      preimage = {
        kind: "repository-production-creator-role-preimage",
        commandId: update.commandId,
        actorId,
        active: members.some((member) => member.id === actorId),
      };
      await context.checkpoint(preimage);
    }
    if (!preimage.active) {
      return "skipped";
    }
    await deps.execute(
      context,
      update.roles.length === 0
        ? { action: "remove", memberId: actorId, clientRequestId: update.commandId }
        : {
            action: "change-role",
            memberId: actorId,
            roles: update.roles,
            clientRequestId: update.commandId,
          },
    );
    await context.assertCurrent();
    return "applied";
  };
