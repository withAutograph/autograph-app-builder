/* oxlint-disable eslint/require-await -- Async fixture ports retain provider rejection behavior. */
import { describe, expect, it } from "vitest";
import {
  createRepositoryProductionRoleUpdater,
  assertNoConflictingCreatorRoleUpdate,
} from "./repository-production-role-update";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";
import type { AppAccessCommand } from "../app-access/contracts";

const fixture = () => {
  const scope = {
    authority: {
      issuer: "https://builder.test/api/auth",
      audience: "https://builder.test/mcp",
      ownerUserId: "owner",
      workspaceId: "workspace",
    },
    appId: "requests",
    repositoryId: "repo",
    repositoryFullName: "example/repo",
    projectId: "project",
    organizationId: "org",
    publicOrigin: "https://apps.test",
    environment: "production" as const,
  };
  const record = initialRepositoryProductionRecord(scope, {
    sessionId: "session",
    sourceSha: "a".repeat(40),
    creatorRoles: ["approver"],
    storage: { kind: "none" },
  });
  record.creatorActorId = "creator";
  record.creatorRoleUpdate = {
    commandId: "11111111-1111-4111-a111-111111111111",
    roles: ["approver"],
    state: "pending",
  };
  const context: RepositoryProductionEffectContext = {
    row: { operationRef: repositoryProductionOperationRef(scope), revision: 1, record },
    effect: "creator-access",
    assertCurrent: async () => {},
    checkpoint: async (value) => {
      record.workerCheckpoints.push(value);
    },
  };
  return context;
};
describe("approved creator role revisions", () => {
  it("uses an existing active creator and the exact reviewed new roles", async () => {
    const context = fixture();
    const commands: AppAccessCommand[] = [];
    const update = createRepositoryProductionRoleUpdater({
      readMembers: async () => [{ id: "creator" }],
      execute: async (_context, command) => {
        commands.push(command);
      },
    });
    expect(await update(context)).toBe("applied");
    expect(commands).toEqual([
      {
        action: "change-role",
        clientRequestId: "11111111-1111-4111-a111-111111111111",
        memberId: "creator",
        roles: ["approver"],
      },
    ]);
  });
  it("keeps explicit app admission when an approved revision removes all business roles", async () => {
    const context = fixture();
    const revision = context.row.record.creatorRoleUpdate;
    if (!revision) {
      throw new Error("Fixture role revision missing");
    }
    revision.roles = [];
    const commands: AppAccessCommand[] = [];
    const update = createRepositoryProductionRoleUpdater({
      readMembers: async () => [{ id: "creator" }],
      execute: async (_context, command) => {
        commands.push(command);
      },
    });
    expect(await update(context)).toBe("applied");
    expect(commands).toEqual([
      {
        action: "change-role",
        clientRequestId: "11111111-1111-4111-a111-111111111111",
        memberId: "creator",
        roles: [],
      },
    ]);
  });
  it("never restores a creator whose access was deliberately removed", async () => {
    const context = fixture();
    const commands: AppAccessCommand[] = [];
    const update = createRepositoryProductionRoleUpdater({
      readMembers: async () => [],
      execute: async (_context, command) => {
        commands.push(command);
      },
    });
    expect(await update(context)).toBe("skipped");
    expect(commands).toEqual([]);
  });
  it("reuses the saved active preimage and journal command after interruption while denying a conflicting new removal", async () => {
    const context = fixture();
    const commands: AppAccessCommand[] = [];
    let active = true;
    let interrupted = false;
    const update = createRepositoryProductionRoleUpdater({
      readMembers: async () => (active ? [{ id: "creator" }] : []),
      execute: async (_context, command) => {
        commands.push(command);
        if (!interrupted) {
          interrupted = true;
          active = false;
          throw new Error("lost after role revocation");
        }
        active = true;
      },
    });
    await expect(update(context)).rejects.toThrow("lost after role revocation");
    expect(() => {
      assertNoConflictingCreatorRoleUpdate({
        row: context.row,
        commandId: "new-remove",
        pendingCommandIds: ["11111111-1111-4111-a111-111111111111"],
      });
    }).toThrow();
    expect(() => {
      assertNoConflictingCreatorRoleUpdate({
        row: context.row,
        commandId: "11111111-1111-4111-a111-111111111111",
        pendingCommandIds: ["11111111-1111-4111-a111-111111111111"],
      });
    }).not.toThrow();
    expect(await update(context)).toBe("applied");
    expect(active).toBe(true);
    expect(commands[1]).toEqual(commands[0]);
  });
  it("allows a previously journaled access operation to reconcile before changing the schema", () => {
    const context = fixture();
    expect(() => {
      assertNoConflictingCreatorRoleUpdate({
        row: context.row,
        commandId: "saved-remove",
        pendingCommandIds: ["saved-remove"],
      });
    }).not.toThrow();
  });
});
