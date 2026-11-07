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
  appId: "test-app",
  authority: {
    audience: "https://builder.test/mcp",
    issuer: "https://builder.test/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  environment: "production",
  organizationId: "org",
  projectId: "project",
  publicOrigin: "https://apps.test",
  repositoryFullName: "team/apps",
  repositoryId: "repo",
};
const owner: AppAccessOwner = {
  appId: scope.appId,
  ownerContext: {
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority: scope.authority,
    kind: "direct",
    principal: { ...scope.authority, scopes: ["autograph:session"] },
    sessionId: "session",
  },
  sessionId: "session",
};
const invitationSchema = z.object({
  appId: z.string(),
  deliveryAttemptId: z.string().nullable(),
  deliveryStatus: z.enum(["ready", "sending", "sent", "unknown"]),
  email: z.email(),
  expiresAt: z.string(),
  id: z.uuid(),
  organizationId: z.string(),
  roles: z.array(z.string()),
  scopeDigest: z.string(),
  status: z.enum(["pending", "verified", "accepted", "cancelled"]),
  verifiedActorId: z.string().nullable(),
});
type Invitation = z.infer<typeof invitationSchema>;
const harness = (roleless = false, generated = false) => {
  const rows = new Map<string, AppAccessOperationRow>();
  const invites = new Map<string, Invitation>();
  const people = new Map<string, { id: string; name: string; email: string; roles: string[] }>();
  const sends: string[] = [];
  const cancellations: string[] = [];
  const accessWrites: { actorId: string; roles: string[]; active: boolean }[] = [];
  let loseAfterRevoke = false;
  let loseAfterSend = false;
  let loseAfterCancel = false;
  let deliveryState: "sent" | "unknown" | "sending" = "sent";
  let renewCount = 0;
  let admissionActive = false;
  let loseAfterGrant = false;
  const admissionInspections: boolean[] = [];
  const setup = {
    operationRef: repositoryProductionOperationRef(scope),
    record: {
      ...initialRepositoryProductionRecord(scope, {
        creatorRoles: roleless ? [] : ["reader", "editor"],
        sessionId: "session",
        sourceSha: "a".repeat(40),
        storage: generated
          ? {
              artifactRef: "artifact",
              databaseEnvironment: "APP_DATABASE_URL",
              kind: "postgres",
              manifestSha256: "b".repeat(64),
              releaseId: "release",
            }
          : { kind: "none" },
      }),
      lease: { fenceGeneration: 1, leaseId: randomUUID() },
    },
    revision: 1,
  };
  const invitation = (id: string = randomUUID()): Invitation => ({
    appId: scope.appId,
    deliveryAttemptId: randomUUID(),
    deliveryStatus: "sent",
    email: "guest@example.test",
    expiresAt: "2099-01-01T00:00:00Z",
    id,
    organizationId: scope.organizationId,
    roles: roleless ? [] : ["reader"],
    scopeDigest: "b".repeat(64),
    status: "pending",
    verifiedActorId: null,
  });
  const writeAccess = (change: { actorId: string; roles: string[]; active: boolean }) => {
    accessWrites.push(change);
    const existing = people.get(change.actorId);
    if (change.active) {
      people.set(change.actorId, {
        email: "guest@example.test",
        id: change.actorId,
        name: "Guest",
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
    appUrl: async () => "https://apps.test/test-app",
    assertAuthorized: async () => {},
    builderOrigin: "https://builder.test",
    journal: {
      findInvitation: async (id) => {
        const row = rows.get(id);
        return row === undefined ? undefined : structuredClone(row);
      },
      pending: async () =>
        [...rows.values()]
          .filter(
            (row) => row.record.state === "pending" || row.record.enrollment?.state === "pending",
          )
          .map((row) => structuredClone(row)),
      reserve: async (record) => {
        const id = record.command.clientRequestId;
        const current = rows.get(id) ?? structuredClone({ record, revision: 1 });
        rows.set(id, current);
        return structuredClone(current);
      },
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
    },
    readSetup: async () => setup,
    realm: () => ({}),
    renewSignIn: async () => {},
    resolve: async () => ({
      appName: "Test app",
      canManage: true,
      creator: { status: "ready" },
      organizationName: "Team",
      roles: (roleless ? [] : ["reader", "editor"]).map((id) => ({ id, label: id })),
      scope,
    }),
    retrySetup: async () => {},
    roles: async () => (roleless ? [] : ["reader", "editor"]),
    withLease: async (_scope, run) => await run(async () => {}),
    workers: () => ({
      inspectAppAccess: async (_context, access) => {
        if (!generated) {
          throw new Error("frontend must not use generated storage");
        }
        const roles = new Set(people.get(access.actorId)?.roles);
        let matches: boolean;
        if (access.roles.length === 0) {
          admissionInspections.push(access.active);
          matches = admissionActive === access.active;
        } else {
          matches = access.active
            ? access.roles.every((role) => roles.has(role))
            : access.roles.every((role) => !roles.has(role));
        }
        return matches ? { receipt: {}, state: "applied" } : { state: "not-applied" };
      },
      invokeAuthManagement: async (context, input) => {
        const { request } = z
          .object({
            request: z.object({
              action: z.string(),
              active: z.boolean().optional(),
              actorId: z.string().optional(),
              expiresAt: z.string().optional(),
              invitation: z
                .object({
                  email: z.string(),
                  expiresAt: z.string(),
                  id: z.string(),
                  roles: z.array(z.string()),
                })
                .optional(),
              invitationId: z.string().optional(),
              roles: z.array(z.string()).optional(),
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
            deliveryAttemptId: null,
            deliveryStatus: "ready",
          });
        }
        if (request.action === "renew" && found !== undefined) {
          renewCount += 1;
          found.expiresAt = z.string().parse(request.expiresAt);
          found.deliveryStatus = "ready";
          found.deliveryAttemptId = null;
        }
        if (request.action === "cancel" && found !== undefined) {
          cancellations.push(found.id);
          found.status = "cancelled";
          if (loseAfterCancel) {
            loseAfterCancel = false;
            throw new Error("lost cancellation response");
          }
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
            .object({ active: z.boolean(), actorId: z.string(), roles: z.array(z.string()) })
            .parse(request);
          writeAccess(change);
        }
        return {
          context_digest: "a".repeat(64),
          fence_generation: 1,
          operation_id: context.row.operationRef,
          readback_sha256: "b".repeat(64),
          result,
          status: "applied" as const,
          version: 1 as const,
        };
      },
      mutateAppAccess: async (_context, access) => {
        if (!generated) {
          throw new Error("frontend must not use generated storage");
        }
        if (access.roles.length === 0) {
          admissionActive = access.active;
        }
        writeAccess(access);
        if (loseAfterGrant && access.active) {
          loseAfterGrant = false;
          throw new Error("lost grant response");
        }
      },
    }),
  };
  const service = createRepositoryProductionManagement(deps);
  return {
    accessWrites,
    admissionActive: () => admissionActive,
    admissionInspections,
    cancellations,
    invitation,
    invites,
    loseCancel: () => {
      loseAfterCancel = true;
    },
    loseGrant: () => {
      loseAfterGrant = true;
    },
    loseRevoke: () => {
      loseAfterRevoke = true;
    },
    loseSend: (state: "sent" | "unknown" | "sending") => {
      loseAfterSend = true;
      deliveryState = state;
    },
    people,
    renewCount: () => renewCount,
    rows,
    seedDispatched: (command: AppAccessCommand) =>
      rows.set(command.clientRequestId, {
        record: {
          command,
          createdAt: new Date().toISOString(),
          dispatched: true,
          kind: "app-access-operation-v1",
          ownerContext: owner.ownerContext,
          scope,
          state: "pending",
          workerCheckpoints: [],
        },
        revision: 1,
      }),
    sends,
    service,
    setAdmission: () => {
      admissionActive = true;
    },
  };
};

describe("native app access recovery", () => {
  it("does not mistake an earlier send for a newly dispatched resend", async () => {
    const h = harness();
    const invite = h.invitation();
    h.invites.set(invite.id, invite);
    const command = {
      action: "resend" as const,
      clientRequestId: randomUUID(),
      invitationId: invite.id,
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
        clientRequestId: randomUUID(),
        invitationId: invite.id,
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
      email: "guest@example.test",
      id: "guest",
      name: "Guest",
      roles: ["reader"],
    });
    h.loseRevoke();
    const command = {
      action: "change-role" as const,
      clientRequestId: randomUUID(),
      memberId: "guest",
      roles: ["editor"],
    };
    await expect(h.service.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    expect(h.people.has("guest")).toBe(false);
    expect(h.rows.get(command.clientRequestId)?.record.workerCheckpoints).toContainEqual({
      email: "guest@example.test",
      id: "guest",
      kind: "access-member-preimage",
      roles: ["reader"],
    });
    await h.service.execute(owner, command);
    expect(h.people.get("guest")?.roles).toEqual(["editor"]);
    expect(h.accessWrites.filter((write) => write.active)).toHaveLength(1);
  });

  it("removes role-less frontend app membership without using a generated database", async () => {
    const h = harness(true);
    h.people.set("guest", { email: "guest@example.test", id: "guest", name: "Guest", roles: [] });
    await h.service.execute(owner, {
      action: "remove",
      clientRequestId: randomUUID(),
      memberId: "guest",
    });
    expect(h.people.has("guest")).toBe(false);
    expect(h.accessWrites).toEqual([{ active: false, actorId: "guest", roles: [] }]);
  });

  it("closes generated app admission before adding named roles and reconciles its closure after a lost grant reply", async () => {
    const h = harness(false, true);
    h.people.set("guest", { email: "guest@example.test", id: "guest", name: "Guest", roles: [] });
    h.setAdmission();
    h.loseGrant();
    const command = {
      action: "change-role" as const,
      clientRequestId: randomUUID(),
      memberId: "guest",
      roles: ["reader"],
    };
    await expect(h.service.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    expect(h.admissionActive()).toBe(false);
    expect(h.people.get("guest")?.roles).toEqual(["reader"]);
    await h.service.execute(owner, command);
    expect(h.accessWrites).toEqual([
      { active: false, actorId: "guest", roles: [] },
      { active: true, actorId: "guest", roles: ["reader"] },
    ]);
    expect(h.admissionInspections).toContain(false);
  });

  it("does not revoke and regrant unchanged role-less generated app admission", async () => {
    const h = harness(true, true);
    h.people.set("guest", { email: "guest@example.test", id: "guest", name: "Guest", roles: [] });
    h.setAdmission();
    await h.service.execute(owner, {
      action: "change-role",
      clientRequestId: randomUUID(),
      memberId: "guest",
      roles: [],
    });
    expect(h.admissionActive()).toBe(true);
    expect(h.accessWrites).toEqual([{ active: true, actorId: "guest", roles: [] }]);
  });

  it("cancels outstanding same-app invitations before removing a member, and permits a new later invitation", async () => {
    const h = harness();
    h.people.set("guest", {
      email: "guest@example.test",
      id: "guest",
      name: "Guest",
      roles: ["reader"],
    });
    const oldInvite = {
      action: "invite" as const,
      clientRequestId: randomUUID(),
      email: "guest@example.test",
      roles: ["reader"],
    };
    await h.service.execute(owner, oldInvite);
    const verified = h.invites.get(oldInvite.clientRequestId);
    if (!verified) {
      throw new Error("missing invitation");
    }
    verified.status = "verified";
    verified.verifiedActorId = "guest";
    const duplicate = h.invitation();
    h.invites.set(duplicate.id, duplicate);
    const unrelated = { ...h.invitation(), email: "someone-else@example.test" };
    h.invites.set(unrelated.id, unrelated);
    await h.service.execute(owner, {
      action: "remove",
      clientRequestId: randomUUID(),
      memberId: "guest",
    });
    expect(h.people.has("guest")).toBe(false);
    expect(verified.status).toBe("cancelled");
    expect(duplicate.status).toBe("cancelled");
    expect(unrelated.status).toBe("pending");
    await expect(h.service.completeInvitation(oldInvite.clientRequestId)).rejects.toMatchObject({
      code: "app_access_denied",
    });
    const newInvite = { ...oldInvite, clientRequestId: randomUUID() };
    await h.service.execute(owner, newInvite);
    expect(h.invites.get(newInvite.clientRequestId)?.status).toBe("pending");
  });

  it("reuses the captured cancellation list after a lost response and never leaves an old invitation active", async () => {
    const h = harness();
    h.people.set("guest", {
      email: "guest@example.test",
      id: "guest",
      name: "Guest",
      roles: ["reader"],
    });
    const first = h.invitation();
    const second = h.invitation();
    h.invites.set(first.id, first);
    h.invites.set(second.id, second);
    h.loseCancel();
    const command = { action: "remove" as const, clientRequestId: randomUUID(), memberId: "guest" };
    await expect(h.service.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    expect(h.people.has("guest")).toBe(true);
    expect(h.rows.get(command.clientRequestId)?.record.workerCheckpoints).toContainEqual({
      invitations: [
        { id: first.id, scopeDigest: first.scopeDigest },
        { id: second.id, scopeDigest: second.scopeDigest },
      ],
      kind: "access-member-invitation-cancellations",
      memberId: "guest",
    });
    await h.service.execute(owner, command);
    expect(first.status).toBe("cancelled");
    expect(second.status).toBe("cancelled");
    expect(h.cancellations).toEqual([first.id, second.id]);
    expect(h.people.has("guest")).toBe(false);
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
        clientRequestId: randomUUID(),
        invitationId: creator.id,
      }),
    ).rejects.toMatchObject({ code: "app_access_denied" });
    expect(h.invites.get(creator.id)?.status).toBe("pending");
    expect(h.sends).toEqual([]);
  });
});
