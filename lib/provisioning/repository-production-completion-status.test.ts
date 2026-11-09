/* oxlint-disable eslint/require-await -- Controlled read-only ports retain asynchronous production contracts. */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AppAccessOperationRow } from "../app-access/management";
import type { AppAccessCommand } from "../app-access/contracts";
import {
  createRepositoryProductionCompletionStatus,
  completeRepositoryProductionFromStatus,
} from "./repository-production-completion-status";
import type {
  CompletedProductionInvitation,
  CompletionStatusPorts,
} from "./repository-production-completion-status";
import { observeRepositoryProductionCompletion } from "./repository-production-dispatcher";

const invitationId = "66666666-6666-4666-a666-666666666666";
const otherId = "77777777-7777-4777-a777-777777777777";
const fixture = (kind: CompletedProductionInvitation["kind"] = "invitee") => {
  const authority = {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
  };
  const owner = {
    appId: "requests",
    sessionId: "session",
    ownerContext: {
      kind: "direct" as const,
      authority,
      principal: { ...authority, scopes: ["autograph:send"] },
      sessionId: "session",
      adapterSessionId: "physical-session",
      adapterGeneration: 2,
    },
  };
  const scope = {
    authority,
    appId: owner.appId,
    repositoryId: "repo",
    repositoryFullName: "team/apps",
    organizationId: "organization",
    projectId: "project",
    publicOrigin: "https://apps.test",
    environment: "production" as const,
  };
  const completed: CompletedProductionInvitation = {
    kind,
    invitationId,
    actorId: "invited-actor",
    owner,
    scope,
  };
  const row: AppAccessOperationRow = {
    revision: 3,
    record: {
      kind: "app-access-operation-v1",
      scope: structuredClone(scope),
      ownerContext: structuredClone(owner.ownerContext),
      command: {
        action: "invite",
        clientRequestId: invitationId,
        email: "guest@example.test",
        roles: ["reader"],
      },
      state: "applied",
      dispatched: true,
      createdAt: "2026-11-01T00:00:00.000Z",
      workerCheckpoints: [],
      enrollment: { actorId: completed.actorId, state: "applied" },
    },
  };
  let available = true;
  const ports: CompletionStatusPorts = {
    readInvitee: vi.fn(async () =>
      kind === "invitee" && available ? structuredClone(row) : undefined,
    ),
    readCreator: vi.fn(async () =>
      kind === "creator" && available ? structuredClone(completed) : undefined,
    ),
    assertAuthorized: vi.fn(async () => {}),
    readPending: vi.fn(async () => []),
  };
  return {
    completed,
    row,
    ports,
    probe: createRepositoryProductionCompletionStatus(ports),
    disappear: () => {
      available = false;
    },
  };
};
const pending = (
  f: ReturnType<typeof fixture>,
  command: AppAccessCommand,
): AppAccessOperationRow => {
  const row: AppAccessOperationRow = {
    revision: 1,
    record: { ...structuredClone(f.row.record), command, state: "pending" },
  };
  delete row.record.enrollment;
  return row;
};
const mutationCommand = (
  action: "remove" | "change-role" | "cancel",
  memberId: string,
  targetInvitationId = invitationId,
): AppAccessCommand => {
  switch (action) {
    case "remove": {
      return { action, clientRequestId: otherId, memberId };
    }
    case "change-role": {
      return { action, clientRequestId: otherId, memberId, roles: ["editor"] };
    }
    case "cancel": {
      return { action, clientRequestId: otherId, invitationId: targetInvitationId };
    }
    default: {
      throw new Error("Unexpected controlled mutation");
    }
  }
};

describe("durable invitation completion status", () => {
  it.each(["creator", "invitee"] as const)(
    "returns the owned completed %s without mutation continuation",
    async (kind) => {
      const f = fixture(kind);
      const before = structuredClone({ completed: f.completed, row: f.row });
      const continuePending = vi.fn(async () => "pending" as const);
      await expect(
        completeRepositoryProductionFromStatus(
          async () => await f.probe(invitationId),
          continuePending,
        ),
      ).resolves.toBe("ready");
      expect(f.ports.assertAuthorized).toHaveBeenCalledWith(f.completed);
      expect(continuePending).not.toHaveBeenCalled();
      expect({ completed: f.completed, row: f.row }).toEqual(before);
    },
  );

  it("returns ready across successive callbacks even when fresh metadata exceeds the mutation response budget", async () => {
    const f = fixture();
    f.ports.assertAuthorized = vi.fn(async () => {
      await delay(15);
    });
    const captureOrGrant = vi.fn(async () => "ready" as const);
    const waitUntil = vi.fn<(task: Promise<void>) => void>();
    const dispose = vi.fn(async () => {});
    const continuePending = vi.fn(
      async () =>
        await observeRepositoryProductionCompletion(captureOrGrant(), waitUntil, dispose, 1),
    );
    for (let callback = 0; callback < 3; callback += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each callback begins after the preceding response, matching automatic browser refreshes.
      await expect(
        completeRepositoryProductionFromStatus(
          async () => await f.probe(invitationId),
          continuePending,
        ),
      ).resolves.toBe("ready");
    }
    expect(continuePending).not.toHaveBeenCalled();
    expect(captureOrGrant).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("continues the normal observed mutation path when no completed journal is known", async () => {
    const f = fixture();
    f.disappear();
    const background: Promise<void>[] = [];
    const dispose = vi.fn(async () => {});
    const continuePending = vi.fn(
      async () =>
        await observeRepositoryProductionCompletion(
          Promise.resolve("pending" as const),
          (task) => {
            background.push(task);
          },
          dispose,
          1,
        ),
    );
    await expect(
      completeRepositoryProductionFromStatus(
        async () => await f.probe(invitationId),
        continuePending,
      ),
    ).resolves.toBe("pending");
    await Promise.all(background);
    expect(continuePending).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.ports.assertAuthorized).not.toHaveBeenCalled();
  });

  it.each([
    "not-dispatched",
    "pending-command",
    "rejected-command",
    "pending-enrollment",
    "missing-enrollment",
  ] as const)("does not claim completion from %s", async (state) => {
    const f = fixture();
    if (state === "not-dispatched") {
      f.row.record.dispatched = false;
    }
    if (state === "pending-command") {
      f.row.record.state = "pending";
    }
    if (state === "rejected-command") {
      f.row.record.state = "rejected";
    }
    if (state === "pending-enrollment") {
      f.row.record.enrollment = { actorId: f.completed.actorId, state: "pending" };
    }
    if (state === "missing-enrollment") {
      delete f.row.record.enrollment;
    }
    await expect(f.probe(invitationId)).resolves.toBeUndefined();
  });

  it.each(["owner revoked", "repository_production_approval_required", "scope denied"])(
    "preserves %s instead of completion or mutation",
    async (message) => {
      const f = fixture();
      const failure = new Error(message);
      f.ports.assertAuthorized = vi.fn(async () => {
        throw failure;
      });
      const continuePending = vi.fn(async () => "pending" as const);
      await expect(
        completeRepositoryProductionFromStatus(
          async () => await f.probe(invitationId),
          continuePending,
        ),
      ).rejects.toBe(failure);
      expect(continuePending).not.toHaveBeenCalled();
    },
  );

  it.each(["creator", "invitee"] as const)(
    "rechecks the exact %s subject after metadata awaits",
    async (kind) => {
      const f = fixture(kind);
      f.ports.readPending = vi.fn(async () => {
        f.completed.actorId = "different-actor";
        f.row.record.enrollment = { actorId: "different-actor", state: "applied" };
        return [];
      });
      await expect(f.probe(invitationId)).resolves.toBeUndefined();
    },
  );

  it.each(["actor", "owner", "scope", "invitation", "absent"] as const)(
    "does not reuse a completed subject whose %s changes during authorization",
    async (change) => {
      const f = fixture();
      f.ports.assertAuthorized = vi.fn(async () => {
        if (change === "actor") {
          f.row.record.enrollment = { actorId: "different-actor", state: "applied" };
        }
        if (change === "owner") {
          f.row.record.ownerContext.adapterGeneration += 1;
        }
        if (change === "scope") {
          f.row.record.scope.organizationId = "other-organization";
        }
        if (change === "invitation") {
          f.row.record.command.clientRequestId = otherId;
        }
        if (change === "absent") {
          f.disappear();
        }
      });
      await expect(f.probe(invitationId)).resolves.toBeUndefined();
    },
  );

  it.each(["remove", "change-role", "cancel"] as const)(
    "keeps a pending %s of this invitation or actor nonready without restarting completion",
    async (action) => {
      const f = fixture();
      const command = mutationCommand(action, f.completed.actorId);
      f.ports.readPending = vi.fn(async () => [pending(f, command)]);
      const continuePending = vi.fn(async () => "ready" as const);
      await expect(
        completeRepositoryProductionFromStatus(
          async () => await f.probe(invitationId),
          continuePending,
        ),
      ).resolves.toBe("pending");
      expect(continuePending).not.toHaveBeenCalled();
    },
  );

  it.each(["remove", "change-role", "cancel", "invite", "foreign-scope"] as const)(
    "does not block completed access on unrelated %s work",
    async (action) => {
      const f = fixture();
      let command: AppAccessCommand;
      if (action === "invite") {
        command = {
          action,
          clientRequestId: otherId,
          email: "other@example.test",
          roles: ["reader"],
        };
      } else if (action === "foreign-scope") {
        command = mutationCommand("remove", f.completed.actorId);
      } else {
        command = mutationCommand(action, "another-actor", otherId);
      }
      const unrelated = pending(f, command);
      if (action === "foreign-scope") {
        unrelated.record.scope.appId = "another-app";
      }
      f.ports.readPending = vi.fn(async () => [unrelated]);
      await expect(f.probe(invitationId)).resolves.toBe("ready");
    },
  );
});
