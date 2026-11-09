/* oxlint-disable eslint/require-await -- In-memory adapters preserve asynchronous production ports. */
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
import { createRepositoryProductionManagementResolver } from "../provisioning/repository-production-management-subject";
import { resolveRepositoryProductionDestination } from "../provisioning/repository-production-destination";
import { repositoryProductionApprovalDigest } from "../provisioning/repository-production-approval";
import type { AppDescription } from "../repository/app-description";
import { AppAccessError } from "./errors";

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
  const creatorChoices: string[] = [];
  const accessWrites: { actorId: string; roles: string[]; active: boolean }[] = [];
  let ownerFailure: Error | undefined;
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
    assertAuthorized: async () => {
      if (ownerFailure) {
        throw ownerFailure;
      }
    },
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
    chooseCreatorAccount: async (_scope, email) => {
      creatorChoices.push(email);
      return "applied";
    },
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
    deps,
    revokeOwner: (error: Error) => {
      ownerFailure = error;
    },
    setup,
    creatorChoices,
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
  it("requires current owner authority before dispatching a pending-signup cancellation", async () => {
    const h = harness(false, true);
    let dispatched = false;
    h.deps.cancelPendingSignup = async () => {
      dispatched = true;
      return "applied";
    };
    const failure = new Error("owner access revoked");
    h.revokeOwner(failure);
    await expect(
      h.service.execute(owner, {
        action: "remove",
        clientRequestId: randomUUID(),
        memberId: "partial",
      }),
    ).rejects.toBe(failure);
    expect(dispatched).toBe(false);
    expect(h.rows.size).toBe(0);
    expect(h.accessWrites).toEqual([]);
  });

  it("cancels an exact pending signup even when no Auth membership is visible", async () => {
    const h = harness(false, true);
    const command = {
      action: "remove" as const,
      clientRequestId: randomUUID(),
      memberId: "partial",
    };
    let closed = false;
    h.deps.cancelPendingSignup = async (input) => {
      expect(input.scope).toEqual(scope);
      expect(input.actorId).toBe(command.memberId);
      expect(input.effect.operationRef).toBe(command.clientRequestId);
      expect(input.mode).toBe("execute");
      await input.effect.assertCurrent();
      await input.effect.checkpoint({ kind: "signup-cancellation", actorId: input.actorId });
      closed = true;
      return "applied";
    };
    await h.service.execute(owner, command);
    expect(closed).toBe(true);
    expect(h.rows.get(command.clientRequestId)?.record.state).toBe("applied");
    expect(h.rows.get(command.clientRequestId)?.record.workerCheckpoints).toContainEqual({
      kind: "signup-cancellation",
      actorId: "partial",
    });
    expect(h.accessWrites).toEqual([]);
  });

  it("reconciles an uncertain signup cancellation without dispatching its revoke twice", async () => {
    const h = harness(false, true);
    const command = {
      action: "remove" as const,
      clientRequestId: randomUUID(),
      memberId: "partial",
    };
    let revocations = 0;
    h.deps.cancelPendingSignup = async ({ effect, mode }) => {
      await effect.assertCurrent();
      if (mode === "reconcile") {
        expect(effect.readCheckpoints()).toContainEqual({ kind: "signup-cancellation" });
        return revocations === 1 ? "applied" : "unknown";
      }
      await effect.checkpoint({ kind: "signup-cancellation" });
      revocations += 1;
      throw new Error("lost revoke reply");
    };
    await expect(h.service.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    expect(h.rows.get(command.clientRequestId)?.record.state).toBe("pending");
    await h.service.execute(owner, command);
    expect(revocations).toBe(1);
    expect(h.rows.get(command.clientRequestId)?.record.state).toBe("applied");
  });

  it.each(["unknown", "absent"] as const)(
    "retains a pending removal when signup cancellation returns %s",
    async (result) => {
      const h = harness();
      h.people.set("guest", {
        email: "guest@example.test",
        id: "guest",
        name: "Guest",
        roles: ["reader"],
      });
      h.deps.cancelPendingSignup = async () => result;
      const command = {
        action: "remove" as const,
        clientRequestId: randomUUID(),
        memberId: "guest",
      };
      await expect(h.service.execute(owner, command)).rejects.toMatchObject({
        code: "app_access_unknown",
      });
      expect(h.people.has("guest")).toBe(true);
      expect(h.accessWrites).toEqual([]);
      expect(h.rows.get(command.clientRequestId)?.record.state).toBe("pending");
    },
  );

  it("preserves ordinary removal when no signup matches and never cancels for a role change", async () => {
    const h = harness();
    const observedActors: string[] = [];
    h.deps.cancelPendingSignup = async ({ actorId }) => {
      observedActors.push(actorId);
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Undefined selects the existing ordinary People path.
      return undefined;
    };
    h.people.set("guest", {
      email: "guest@example.test",
      id: "guest",
      name: "Guest",
      roles: ["reader"],
    });
    await h.service.execute(owner, {
      action: "change-role",
      clientRequestId: randomUUID(),
      memberId: "guest",
      roles: ["editor"],
    });
    expect(observedActors).toEqual([]);
    await h.service.execute(owner, {
      action: "remove",
      clientRequestId: randomUUID(),
      memberId: "guest",
    });
    expect(observedActors).toEqual(["guest"]);
    expect(h.people.has("guest")).toBe(false);
  });

  it.each([true, false])(
    "keeps saved frontend People usable with current published routing=%s",
    async (published) => {
      const h = harness(true);
      h.setup.record.ownerContext = owner.ownerContext;
      h.setup.record.approval = {
        approvalId: "approval",
        approvedByCallId: "call",
        planDigest: repositoryProductionApprovalDigest(scope, h.setup.record.intent),
      };
      const profile = {
        workspaceId: scope.authority.workspaceId,
        repositoryId: scope.repositoryId,
        repositoryFullName: scope.repositoryFullName,
        projectId: scope.projectId,
        organization: { id: scope.organizationId, name: "Team" },
        publicOrigin: scope.publicOrigin,
      };
      const description: AppDescription = {
        version: 1,
        app: {
          id: scope.appId,
          routes: ["/test-app"],
          browserEntryPath: "/app-entry",
          workspacePath: "apps/test-app",
        },
        backend: { kind: "static" },
        validation: { browser: null, check: { task: "check" }, test: null },
      };
      let ownerActive = true;
      const readSession = async () => {
        if (!ownerActive) {
          throw new Error("owner revoked");
        }
      };
      const resolve = createRepositoryProductionManagementResolver({
        repositories: [profile],
        store: { read: async () => h.setup },
        readSession,
        readCapture: async () => {
          throw new Error("frontend must not read app database artifacts");
        },
        resolveCurrent: async () => {
          if (!published) {
            resolveRepositoryProductionDestination({
              appId: scope.appId,
              appSpecDigest: "a".repeat(64),
              workspaceId: scope.authority.workspaceId,
              repositories: [profile],
            });
          }
          return {
            assertCurrentOwner: readSession,
            description,
            publishedDescription: true,
            intent: h.setup.record.intent,
            owner,
            profile,
            scope,
          };
        },
      });
      const appUrl = async () => {
        const found = await resolve(owner);
        if (!found.description) {
          throw new AppAccessError("app_access_unavailable");
        }
        return new URL(
          found.description.app.browserEntryPath ?? found.description.app.routes[0],
          found.scope.publicOrigin,
        ).toString();
      };
      const service = createRepositoryProductionManagement({
        ...h.deps,
        appUrl,
        resolve: async () => {
          const found = await resolve(owner);
          const base = await h.deps.resolve(owner);
          return {
            ...base,
            scope: found.scope,
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
            ...(found.description ? { appUrl: await appUrl() } : {}),
          };
        },
        assertAuthorized: async () => {
          const found = await resolve(owner);
          await found.assertCurrentOwner();
        },
        withLease: async (_scope, run) => await run(readSession),
      });
      const before = structuredClone(h.setup);
      const snapshot = await service.read(owner);
      expect(snapshot.appUrl).toBe(published ? "https://apps.test/app-entry" : undefined);
      const command = {
        action: "invite" as const,
        email: "guest@example.test",
        roles: [],
        clientRequestId: randomUUID(),
      };
      if (published) {
        const invited = await service.execute(owner, command);
        expect(invited.invitations[0]?.email).toBe(command.email);
      } else {
        await expect(service.execute(owner, command)).rejects.toMatchObject({
          code: "app_access_unknown",
        });
      }
      expect(h.invites.size).toBe(published ? 1 : 0);
      expect(h.sends.length).toBe(published ? 1 : 0);
      expect(h.setup).toEqual(before);
      expect(h.accessWrites).toEqual([]);
      ownerActive = false;
      await expect(service.read(owner)).rejects.toThrow("owner revoked");
    },
  );
  it("journals a creator delivery choice once without granting app permissions", async () => {
    const h = harness();
    const command = {
      action: "choose-creator-account" as const,
      email: "APP@EXAMPLE.TEST",
      clientRequestId: randomUUID(),
    };
    await h.service.execute(owner, command);
    await h.service.execute(owner, command);
    expect(h.creatorChoices).toEqual(["app@example.test"]);
    expect(h.accessWrites).toEqual([]);
  });

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

describe("protected People reads", () => {
  it("starts members and invitations together under the same held lease", async () => {
    const f = harness();
    const originalWorkers = f.deps.workers;
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    const started = new Set<string>();
    let held = false;
    f.deps.withLease = async (_scope, run) => {
      held = true;
      try {
        return await run(async () => {
          expect(held).toBe(true);
        });
      } finally {
        held = false;
      }
    };
    f.deps.workers = (target) => {
      const workers = originalWorkers(target);
      return {
        ...workers,
        invokeAuthManagement: async (context, input, readOnly) => {
          expect(readOnly).toBe(true);
          expect(held).toBe(true);
          const {
            request: { action },
          } = z.object({ request: z.object({ action: z.string() }) }).parse(input);
          started.add(action);
          await gate.promise;
          return await workers.invokeAuthManagement(context, input, readOnly);
        },
      };
    };
    const reading = f.service.read(owner);
    try {
      await vi.waitFor(
        () => {
          expect(started).toEqual(new Set(["list-members", "list"]));
        },
        { timeout: 100 },
      );
      expect(held).toBe(true);
    } finally {
      gate.resolve();
    }
    await expect(reading).resolves.toMatchObject({ members: [], invitations: [] });
    expect(held).toBe(false);
  });

  it("keeps the lease until both reads settle and preserves the first rejection", async () => {
    const f = harness();
    const originalWorkers = f.deps.workers;
    const people: PromiseWithResolvers<void> = Promise.withResolvers();
    const invitations: PromiseWithResolvers<void> = Promise.withResolvers();
    const started = new Set<string>();
    const failure = new Error("members unavailable");
    let peopleFinished = false;
    let held = false;
    f.deps.withLease = async (_scope, run) => {
      held = true;
      try {
        return await run(async () => {
          expect(held).toBe(true);
        });
      } finally {
        held = false;
      }
    };
    f.deps.workers = (target) => {
      const workers = originalWorkers(target);
      return {
        ...workers,
        invokeAuthManagement: async (_context, input, readOnly) => {
          expect(readOnly).toBe(true);
          const {
            request: { action },
          } = z.object({ request: z.object({ action: z.string() }) }).parse(input);
          started.add(action);
          if (action === "list-members") {
            try {
              await people.promise;
            } finally {
              peopleFinished = true;
            }
          } else {
            await invitations.promise;
            throw new Error("invitations unavailable");
          }
          return await workers.invokeAuthManagement(_context, input, readOnly);
        },
      };
    };
    const result = (async () => {
      try {
        await f.service.read(owner);
        return null;
      } catch (error) {
        return error;
      }
    })();
    try {
      await vi.waitFor(
        () => {
          expect(started.size).toBe(2);
        },
        { timeout: 100 },
      );
      people.reject(failure);
      await vi.waitFor(() => {
        expect(peopleFinished).toBe(true);
      });
      expect(held).toBe(true);
    } finally {
      people.reject(failure);
      invitations.resolve();
    }
    await expect(result).resolves.toBe(failure);
    expect(held).toBe(false);
  });
});

it("preserves an invitation-list rejection after the members read succeeds", async () => {
  const f = harness();
  const originalWorkers = f.deps.workers;
  const failure = new Error("invitations unavailable");
  f.deps.workers = (target) => {
    const workers = originalWorkers(target);
    return {
      ...workers,
      invokeAuthManagement: async (context, input, readOnly) => {
        const {
          request: { action },
        } = z.object({ request: z.object({ action: z.string() }) }).parse(input);
        if (action === "list") {
          throw failure;
        }
        return await workers.invokeAuthManagement(context, input, readOnly);
      },
    };
  };
  await expect(f.service.read(owner)).rejects.toBe(failure);
});

describe("accepted invitation enrollment recovery reproduction", () => {
  it.each([
    "active-old",
    "database-missing-auth-active",
    "database-revoked-auth-active",
    "missing-everywhere",
  ] as const)(
    "reconciles only valid accepted access under a newer control lease: %s",
    async (binding) => {
      const f = harness(false, true);
      const id = randomUUID();
      const actorId = "verified-invitee";
      const originalWorkers = f.deps.workers;
      const actions: string[] = [];
      const historicalFence = 426;
      const currentFence = 429;
      f.setup.record.lease.fenceGeneration = currentFence;
      f.invites.set(id, { ...f.invitation(id), status: "accepted", verifiedActorId: actorId });
      if (binding !== "missing-everywhere") {
        f.people.set(actorId, {
          id: actorId,
          name: "Invitee",
          email: "guest@example.test",
          roles: ["reader"],
        });
      }
      const digest = createHash("sha256").update(`${id}:complete`).digest("hex");
      const completeId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      f.rows.set(id, {
        revision: 9,
        record: {
          kind: "app-access-operation-v1",
          scope,
          ownerContext: owner.ownerContext,
          command: {
            action: "invite",
            clientRequestId: id,
            email: "guest@example.test",
            roles: ["reader"],
          },
          state: "applied",
          dispatched: true,
          createdAt: new Date().toISOString(),
          enrollment: { actorId, state: "pending" },
          workerCheckpoints: [
            {
              operationId: completeId,
              effectId: "auth-app-invitation",
              fenceGeneration: historicalFence,
              contextDigest: "a".repeat(64),
              resourceId: "auth",
              tenantId: null,
              sequence: 1,
              receipt: { state: "applied", readbackSha256: "b".repeat(64) },
            },
          ],
        },
      });
      f.deps.workers = (target) => {
        const workers = originalWorkers(target);
        return {
          ...workers,
          inspectAcceptedAppAccess: async (context, access) => {
            expect(context.row.record.lease?.fenceGeneration).toBe(currentFence);
            expect(access).toEqual({ actorId, roles: ["reader"] });
            return binding === "active-old" ? "applied" : "absent";
          },
          inspectAppAccess: async (context, access) => {
            expect(context.row.record.lease?.fenceGeneration).toBe(currentFence);
            expect(access).toEqual({ actorId, active: true, roles: ["reader"] });
            // Frozen Arrusted5f7 inspectAccess: an old active grant is retryable;
            // missing/revoked grants also cannot qualify as applied. The real
            // worker adapter normalization is exercised in its companion test.
            return { state: "not-applied" };
          },
          invokeAuthManagement: async (context, input, readOnly) => {
            const {
              request: { action },
            } = z.object({ request: z.object({ action: z.string() }) }).parse(input);
            actions.push(action);
            expect(context.row.record.lease?.fenceGeneration).toBe(currentFence);
            // Exact frozen5f7 Auth startup guard; an accepted invitation is no
            // longer eligible for prepare-member, even after a completed grant.
            if (action === "prepare-member" && f.invites.get(id)?.status !== "verified") {
              throw new Error("app_invitation_identity_required");
            }
            return await workers.invokeAuthManagement(context, input, readOnly);
          },
        };
      };
      if (binding === "active-old") {
        // Desired recovery: acknowledge already accepted valid access, without
        // treating the historical grant generation as the current control lease.
        await expect(f.service.completeInvitation(id)).resolves.toBeUndefined();
        expect(f.rows.get(id)?.record.enrollment).toEqual({ actorId, state: "applied" });
        expect(actions).not.toContain("prepare-member");
      } else {
        await expect(f.service.completeInvitation(id)).rejects.toMatchObject({
          code: "app_access_denied",
        });
        expect(f.rows.get(id)?.record.enrollment).toEqual({ actorId, state: "pending" });
      }
      expect(f.invites.get(id)?.status).toBe("accepted");
      expect(actions).not.toContain("prepare-member");
      expect(actions).not.toContain("complete");
      expect(f.accessWrites).toHaveLength(0);
    },
  );

  it("can settle the same accepted pending enrollment when access readback is applied", async () => {
    const f = harness(false, true);
    const id = randomUUID();
    const actorId = "verified-invitee";
    f.invites.set(id, { ...f.invitation(id), status: "accepted", verifiedActorId: actorId });
    f.people.set(actorId, {
      id: actorId,
      name: "Invitee",
      email: "guest@example.test",
      roles: ["reader"],
    });
    f.rows.set(id, {
      revision: 9,
      record: {
        kind: "app-access-operation-v1",
        scope,
        ownerContext: owner.ownerContext,
        command: {
          action: "invite",
          clientRequestId: id,
          email: "guest@example.test",
          roles: ["reader"],
        },
        state: "applied",
        dispatched: true,
        createdAt: new Date().toISOString(),
        enrollment: { actorId, state: "pending" },
        workerCheckpoints: [],
      },
    });
    await f.service.completeInvitation(id);
    expect(f.rows.get(id)?.record.enrollment).toEqual({ actorId, state: "applied" });
    expect(f.accessWrites).toHaveLength(0);
  });
});

it.each(["actor", "role", "tenant", "app", "email"] as const)(
  "refuses accepted invitation %s changes before journal acknowledgement",
  async (field) => {
    const f = harness(false, true);
    const id = randomUUID();
    const actorId = "invitee";
    const invitation = {
      ...f.invitation(id),
      status: "accepted" as const,
      verifiedActorId: actorId,
    };
    if (field === "actor") {
      invitation.verifiedActorId = "other";
    }
    if (field === "role") {
      invitation.roles = ["editor"];
    }
    if (field === "tenant") {
      invitation.organizationId = "other";
    }
    if (field === "app") {
      invitation.appId = "other";
    }
    if (field === "email") {
      invitation.email = "other@example.test";
    }
    f.invites.set(id, invitation);
    f.rows.set(id, {
      revision: 1,
      record: {
        kind: "app-access-operation-v1",
        scope,
        ownerContext: owner.ownerContext,
        command: {
          action: "invite",
          clientRequestId: id,
          email: "guest@example.test",
          roles: ["reader"],
        },
        state: "applied",
        dispatched: true,
        createdAt: new Date().toISOString(),
        enrollment: { actorId, state: "pending" },
        workerCheckpoints: [],
      },
    });
    await expect(f.service.completeInvitation(id)).rejects.toMatchObject({
      code: "app_access_denied",
    });
    expect(f.rows.get(id)?.record.enrollment?.state).toBe("pending");
    expect(f.accessWrites).toHaveLength(0);
  },
);

it("rechecks current owner before acknowledging accepted enrollment", async () => {
  const f = harness(false, true);
  const id = randomUUID();
  const actorId = "invitee";
  const originalWorkers = f.deps.workers;
  const failure = new Error("current owner changed");
  f.invites.set(id, { ...f.invitation(id), status: "accepted", verifiedActorId: actorId });
  f.rows.set(id, {
    revision: 1,
    record: {
      kind: "app-access-operation-v1",
      scope,
      ownerContext: owner.ownerContext,
      command: {
        action: "invite",
        clientRequestId: id,
        email: "guest@example.test",
        roles: ["reader"],
      },
      state: "applied",
      dispatched: true,
      createdAt: new Date().toISOString(),
      enrollment: { actorId, state: "pending" },
      workerCheckpoints: [],
    },
  });
  f.deps.workers = (target) => ({
    ...originalWorkers(target),
    inspectAcceptedAppAccess: async () => {
      f.revokeOwner(failure);
      return "applied";
    },
  });
  await expect(f.service.completeInvitation(id)).rejects.toBe(failure);
  expect(f.rows.get(id)?.record.enrollment?.state).toBe("pending");
  expect(f.accessWrites).toHaveLength(0);
});
