/* oxlint-disable eslint/no-await-in-loop -- Each member uses the same held app lease and its existing durable People operation. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppAccessCommand } from "../app-access/contracts";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";

const snapshotSchema = z.object({
  kind: z.literal("repository-production-access-upgrade-members"),
  commandId: z.uuid(),
  members: z.array(
    z.object({ actorId: z.string(), roles: z.array(z.string()), requestId: z.uuid() }),
  ),
});

/** Carry existing compatible access into newly added storage; never enroll an absent actor. */
export const createRepositoryProductionAccessUpgrader =
  (deps: {
    readMembers: (
      context: RepositoryProductionEffectContext,
    ) => Promise<readonly { id: string; roles: string[] }[]>;
    execute: (
      context: RepositoryProductionEffectContext,
      command: AppAccessCommand,
    ) => Promise<void>;
  }) =>
  async (context: RepositoryProductionEffectContext): Promise<void> => {
    const { record } = context.row;
    const upgrade = record.appAccessUpgrade;
    if (upgrade?.state !== "pending" || record.intent.storage.kind !== "postgres") {
      throw new Error("repository_production_access_upgrade_unavailable");
    }
    await context.assertCurrent();
    let snapshot = record.workerCheckpoints
      .flatMap((value) => {
        const parsed = snapshotSchema.safeParse(value);
        return parsed.success && parsed.data.commandId === upgrade.commandId ? [parsed.data] : [];
      })
      .at(-1);
    if (snapshot === undefined) {
      const members = await deps.readMembers(context);
      await context.assertCurrent();
      const allowed = new Set(record.intent.creatorRoles);
      snapshot = {
        kind: "repository-production-access-upgrade-members",
        commandId: upgrade.commandId,
        members: members.flatMap((member) => {
          if (
            member.id === record.creatorActorId &&
            record.creatorRoleUpdate?.state === "pending"
          ) {
            return [];
          }
          const compatible =
            member.roles.length === 0
              ? allowed.size === 0
              : member.roles.every((role) => allowed.has(role));
          return compatible
            ? [
                {
                  actorId: member.id,
                  roles: [...member.roles],
                  requestId: randomUUID(),
                },
              ]
            : [];
        }),
      };
      await context.checkpoint(snapshot);
    }
    for (const member of snapshot.members) {
      await context.assertCurrent();
      await deps.execute(context, {
        action: "change-role",
        memberId: member.actorId,
        roles: member.roles,
        clientRequestId: member.requestId,
      });
    }
    await context.assertCurrent();
  };
