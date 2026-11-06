/* oxlint-disable eslint/require-await -- In-memory adapters preserve asynchronous production ports. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "../provisioning/repository-production-contract";
import type { RepositoryProductionScope } from "../provisioning/repository-production-contract";
import { createRepositoryProductionManagement } from "./native-management";
import type { RepositoryProductionManagementDependencies } from "./native-management";
import type { AppAccessOperationRow } from "./management";
import type { AppAccessOwner } from "./operator-client";
import type { AppAccessCommand } from "./contracts";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "test-app",
  repositoryId: "repo",
  repositoryFullName: "team/apps",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.test",
  environment: "production",
};
const owner: AppAccessOwner = {
  appId: scope.appId,
  sessionId: "session",
  ownerContext: {
    kind: "direct",
    authority: scope.authority,
    principal: { ...scope.authority, scopes: ["autograph:session"] },
    sessionId: "session",
    adapterSessionId: "adapter",
    adapterGeneration: 1,
  },
};
const invitationSchema = z.object({
  id: z.uuid(),
  appId: z.string(),
  organizationId: z.string(),
  email: z.email(),
  roles: z.array(z.string()),
  scopeDigest: z.string(),
  expiresAt: z.string(),
  status: z.enum(["pending", "verified", "accepted", "cancelled"]),
  verifiedActorId: z.string().nullable(),
  deliveryStatus: z.enum(["ready", "sending", "sent", "unknown"]),
  deliveryAttemptId: z.string().nullable(),
});
type Invitation = z.infer<typeof invitationSchema>;
const harness = (roleless = false) => {
  const rows = new Map<string, AppAccessOperationRow>();
  const invites = new Map<string, Invitation>();
  const people = new Map<string, { id: string; name: string; email: string; roles: string[] }>();
  const sends: string[] = [];
  const accessWrites: { actorId: string; roles: string[]; active: boolean }[] = [];
  let loseAfterRevoke = false;
  let loseAfterSend = false;
  let deliveryState: "sent" | "unknown" | "sending" = "sent";
  let renewCount = 0;
  const setup = {
    operationRef: repositoryProductionOperationRef(scope),
    revision: 1,
    record: {
      ...initialRepositoryProductionRecord(scope, {
        sessionId: "session",
        sourceSha: "a".repeat(40),
        creatorRoles: roleless ? [] : ["reader", "editor"],
        storage: { kind: "none" },
      }),
      lease: { leaseId: randomUUID(), fenceGeneration: 1 },
    },
  };
  const invitation = (id: string = randomUUID()): Invitation => ({
    id,
    appId: scope.appId,
    organizationId: scope.organizationId,
    email: "guest@example.test",
    roles: roleless ? [] : ["reader"],
    scopeDigest: "b".repeat(64),
    expiresAt: "2099-01-01T00:00:00Z",
    status: "pending",
    verifiedActorId: null,
    deliveryStatus: "sent",
    deliveryAttemptId: randomUUID(),
  });
  const writeAccess = (change: { actorId: string; roles: string[]; active: boolean }) => {
    accessWrites.push(change);
    const existing = people.get(change.actorId);
    if (change.active) {
      people.set(change.actorId, {
        id: change.actorId,
        name: "Guest",
        email: "guest@example.test",
        roles: [...new Set([...(existing?.roles ?? []), ...change.roles])],
      });
    } else if (existing !== undefined) {
      existing.roles = existing.roles.filter((role) => !change.roles.includes(role));
      if (existing.roles.length === 0) {
        people.delete(change.actorId);
      }
      if (loseAfterRevoke) {
        loseAfterRevoke = false;
        throw new Error("lost revoke response");
      }
    }
  };
  const deps: RepositoryProductionManagementDependencies = {
    builderOrigin: "https://builder.test",
    realm: () => ({}),
    appUrl: async () => "https://apps.test/test-app",
    roles: async () => (roleless ? [] : ["reader", "editor"]),
    readSetup: async () => setup,
    resolve: async () => ({
      scope,
      appName: "Test app",
      organizationName: "Team",
      creator: { status: "ready" },
      canManage: true,
      roles: (roleless ? [] : ["reader", "editor"]).map((id) => ({ id, label: id })),
    }),
    assertAuthorized: async () => {},
    withLease: async (_scope, run) => await run(async () => {}),
    retrySetup: async () => {},
    renewSignIn: async () => {},
    journal: {
      reserve: async (record) => {
        const id = record.command.clientRequestId;
        const current = rows.get(id) ?? structuredClone({ record, revision: 1 });
        rows.set(id, current);
        return structuredClone(current);
      },
      pending: async () =>
        [...rows.values()]
          .filter(
            (row) => row.record.state === "pending" || row.record.enrollment?.state === "pending",
          )
          .map((row) => structuredClone(row)),
      update: async (row, record) => {
        const id = record.command.clientRequestId;
        if (rows.get(id)?.revision !== row.revision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS failure is explicitly undefined in the store contract.
          return undefined;
        }
        const next = structuredClone({ record, revision: row.revision + 1 });
        rows.set(id, next);
        return next;
      },
      findInvitation: async (id) => {
        const row = rows.get(id);
        return row === undefined ? undefined : structuredClone(row);
      },
    },
    workers: () => ({
      invokeAuthManagement: async (context, input) => {
        const { request } = z
          .object({
            request: z.object({
              action: z.string(),
              invitationId: z.string().optional(),
              invitation: z
                .object({
                  id: z.string(),
                  email: z.string(),
                  roles: z.array(z.string()),
                  expiresAt: z.string(),
                })
                .optional(),
              expiresAt: z.string().optional(),
              actorId: z.string().optional(),
              roles: z.array(z.string()).optional(),
              active: z.boolean().optional(),
            }),
          })
          .parse(input);
        let result: z.infer<ReturnType<typeof z.json>> = null;
        const found =
          request.invitationId === undefined ? undefined : invites.get(request.invitationId);
        if (request.action === "read") {
          result = found ?? null;
        }
        if (request.action === "list") {
          result = [...invites.values()];
        }
        if (request.action === "list-members") {
          result = [...people.values()];
        }
        if (request.action === "create") {
          const value = request.invitation;
          if (value === undefined) {
            throw new Error("missing invitation");
          }
          invites.set(value.id, {
            ...invitation(value.id),
            ...value,
            deliveryStatus: "ready",
            deliveryAttemptId: null,
          });
        }
        if (request.action === "renew" && found !== undefined) {
          renewCount += 1;
          found.expiresAt = z.string().parse(request.expiresAt);
          found.deliveryStatus = "ready";
          found.deliveryAttemptId = null;
        }
        if (request.action === "send" && found !== undefined && found.deliveryStatus === "ready") {
          sends.push(context.row.operationRef);
          found.deliveryAttemptId = context.row.operationRef;
          found.deliveryStatus = deliveryState;
          if (loseAfterSend) {
            loseAfterSend = false;
            throw new Error("lost send response");
          }
        }
        if (request.action === "set-access") {
          const change = z
            .object({ actorId: z.string(), roles: z.array(z.string()), active: z.boolean() })
            .parse(request);
          writeAccess(change);
        }
        return {
          version: 1 as const,
          operation_id: context.row.operationRef,
          context_digest: "a".repeat(64),
          fence_generation: 1,
          status: "applied" as const,
          readback_sha256: "b".repeat(64),
          result,
        };
      },
      mutateAppAccess: async () => {
        throw new Error("frontend must not use generated storage");
      },
      inspectAppAccess: async () => {
        throw new Error("frontend must not use generated storage");
      },
    }),
  };
  const service = createRepositoryProductionManagement(deps);
  return {
    service,
    rows,
    invites,
    people,
    sends,
    accessWrites,
    invitation,
    renewCount: () => renewCount,
    loseRevoke: () => {
      loseAfterRevoke = true;
    },
    loseSend: (state: "sent" | "unknown" | "sending") => {
      loseAfterSend = true;
      deliveryState = state;
    },
    seedDispatched: (command: AppAccessCommand) =>
      rows.set(command.clientRequestId, {
        revision: 1,
        record: {
          kind: "app-access-operation-v1",
          command,
          scope,
          ownerContext: owner.ownerContext,
          state: "pending",
          dispatched: true,
          createdAt: new Date().toISOString(),
          workerCheckpoints: [],
        },
      }),
  };
};

describe("native app access recovery", () => {
  it("does not mistake an earlier send for a newly dispatched resend", async () => {
    const h = harness();
    const invite = h.invitation();
    h.invites.set(invite.id, invite);
    const command = {
      action: "resend" as const,
      invitationId: invite.id,
      clientRequestId: randomUUID(),
    };
    h.seedDispatched(command);
    await h.service.execute(owner, command);
    expect(h.sends).toHaveLength(1);
    expect(h.renewCount()).toBe(1);
    await h.service.execute(owner, command);
    expect(h.sends).toHaveLength(1);
  });

  it.each(["sent", "unknown", "sending"] as const)(
    "reconciles a lost send reply without duplicate delivery (status=%s)",
    async (state) => {
      const h = harness();
      const invite = h.invitation();
      h.invites.set(invite.id, invite);
      h.loseSend(state);
      const command = {
        action: "resend" as const,
        invitationId: invite.id,
        clientRequestId: randomUUID(),
      };
      await expect(h.service.execute(owner, command)).rejects.toMatchObject({
        code: "app_access_unknown",
      });
      const result = await h.service.execute(owner, command);
      expect(h.sends).toHaveLength(1);
      expect(h.renewCount()).toBe(1);
      expect(result.invitations[0]?.deliveryStatus).toBe(state === "sent" ? "sent" : "unknown");
    },
  );

  it("reuses the original member preimage after a partial role change removed the visible member", async () => {
    const h = harness();
    h.people.set("guest", {
      id: "guest",
      name: "Guest",
      email: "guest@example.test",
      roles: ["reader"],
    });
    h.loseRevoke();
    const command = {
      action: "change-role" as const,
      memberId: "guest",
      roles: ["editor"],
      clientRequestId: randomUUID(),
    };
    await expect(h.service.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    expect(h.people.has("guest")).toBe(false);
    expect(h.rows.get(command.clientRequestId)?.record.workerCheckpoints).toContainEqual({
      kind: "access-member-preimage",
      id: "guest",
      roles: ["reader"],
    });
    await h.service.execute(owner, command);
    expect(h.people.get("guest")?.roles).toEqual(["editor"]);
    expect(h.accessWrites.filter((write) => write.active)).toHaveLength(1);
  });

  it("removes role-less frontend app membership without using a generated database", async () => {
    const h = harness(true);
    h.people.set("guest", { id: "guest", name: "Guest", email: "guest@example.test", roles: [] });
    await h.service.execute(owner, {
      action: "remove",
      memberId: "guest",
      clientRequestId: randomUUID(),
    });
    expect(h.people.has("guest")).toBe(false);
    expect(h.accessWrites).toEqual([{ actorId: "guest", roles: [], active: false }]);
  });

  it("hides and protects the creator enrollment from ordinary People actions", async () => {
    const h = harness();
    const creator = h.invitation(repositoryProductionOperationRef(scope));
    h.invites.set(creator.id, creator);
    const snapshot = await h.service.read(owner);
    expect(snapshot.invitations).toEqual([]);
    await expect(
      h.service.execute(owner, {
        action: "cancel",
        invitationId: creator.id,
        clientRequestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "app_access_denied" });
    expect(h.invites.get(creator.id)?.status).toBe("pending");
    expect(h.sends).toEqual([]);
  });
});
