/* oxlint-disable eslint/require-await -- In-memory ports implement asynchronous production contracts. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAppAccessManagementService } from "../app-access/management";
import type { AppAccessOperationRow } from "../app-access/management";
import { createRepositoryProductionSetup } from "./repository-production-setup";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import { createRepositoryProductionCreator } from "./repository-production-creator";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
  RepositoryProductionRecord,
} from "./repository-production-contract";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    ownerUserId: "owner-1",
    workspaceId: "workspace-1",
  },
  appId: "equipment-log",
  repositoryId: "repo-1",
  repositoryFullName: "team/apps",
  projectId: "project-1",
  organizationId: "org-1",
  publicOrigin: "https://apps.example",
  environment: "production",
};
type StoredInvitation = Record<string, z.infer<ReturnType<typeof z.json>>>;
const harness = (
  options: {
    scope?: RepositoryProductionScope;
    ownerEmail?: string;
    creatorEmail?: string;
    persistent?: boolean;
    realmDigest?: string;
    candidates?: { row: RepositoryProductionRow; invitation: StoredInvitation | null }[];
  } = {},
) => {
  const targetScope = options.scope ?? scope;
  let row: RepositoryProductionRow = {
    operationRef: repositoryProductionOperationRef(targetScope),
    revision: 0,
    record: initialRepositoryProductionRecord(targetScope, {
      creatorRoles: ["editor"],
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
      ...(options.creatorEmail === undefined ? {} : { creatorEmail: options.creatorEmail }),
      sessionId: "original-session",
      sourceSha: "a".repeat(40),
      storage: options.persistent
        ? {
            kind: "postgres",
            artifactRef: "artifact",
            releaseId: "release",
            manifestSha256: "c".repeat(64),
            databaseEnvironment: "APP_DATABASE_URL",
          }
        : { kind: "none" },
    }),
  };
  let invitation: Record<string, z.infer<ReturnType<typeof z.json>>> | null = null;
  const requests: { action: string; operationRef: string; frameCount: number }[] = [];
  const resumes: string[] = [];
  let failAfterCreate = false;
  let failBeforeCreate = false;
  let failAfterLink = false;
  let authorized = true;
  let unknownRead = false;
  let completionBusy = false;
  let completionHeld = false;
  let invitationReads = 0;
  let completionFenceChecks = 0;
  let clock = new Date("2026-11-06T10:00:00.000Z");
  const assertAuthorized = async () => {
    if (!authorized) {
      throw new Error("denied");
    }
  };
  const context = (): RepositoryProductionEffectContext => {
    let { revision } = row;
    return {
      row,
      effect: "creator-access",
      assertCurrent: assertAuthorized,
      checkpoint: async (value) => {
        if (revision !== row.revision) {
          throw new Error("concurrent journal update");
        }
        row = {
          ...row,
          revision: row.revision + 1,
          record: { ...row.record, workerCheckpoints: [...row.record.workerCheckpoints, value] },
        };
        ({ revision } = row);
      },
    };
  };
  const bridge = createRepositoryProductionCreator({
    withCompletionLease: async <T>(
      _row: RepositoryProductionRow,
      run: (assertCurrent: () => Promise<void>) => Promise<T>,
    ) => {
      if (completionBusy) {
        throw new Error("completion busy");
      }
      completionHeld = true;
      try {
        return await run(async () => {
          if (!completionHeld) {
            throw new Error("completion lease lost");
          }
          completionFenceChecks += 1;
          await assertAuthorized();
        });
      } finally {
        completionHeld = false;
      }
    },
    assertAuthorized,
    builderOrigin: "https://builder.example",
    findInvitation: async (id) => (id === row.operationRef ? row : undefined),
    invokeAuth: async (current, request) => {
      const parsed = z
        .object({
          action: z.string(),
          invitation: z.record(z.string(), z.json()).optional(),
          expiresAt: z.string().optional(),
          sourceInvitationId: z.uuid().optional(),
          actorId: z.string().optional(),
        })
        .parse(request);
      requests.push({
        action: parsed.action,
        operationRef: current.row.operationRef,
        frameCount: row.record.workerCheckpoints.length,
      });
      if (parsed.action === "create") {
        if (failBeforeCreate) {
          failBeforeCreate = false;
          throw new Error("uncertain create response");
        }
        if (invitation !== null) {
          throw new Error("duplicate create");
        }
        invitation = {
          ...parsed.invitation,
          workspaceId: targetScope.authority.workspaceId,
          appId: targetScope.appId,
          organizationId: targetScope.organizationId,
          operationRef: current.row.operationRef,
          scopeDigest: "b".repeat(64),
          status: "pending",
          verifiedActorId: null,
          verifiedSessionId: null,
          deliveryStatus: "ready",
        };
        if (failAfterCreate) {
          failAfterCreate = false;
          throw new Error("response lost");
        }
      } else if (parsed.action === "send" && invitation !== null) {
        invitation.deliveryStatus = "sent";
      } else if (parsed.action === "renew" && invitation !== null) {
        invitation.expiresAt = z.string().parse(parsed.expiresAt);
        invitation.deliveryStatus = "ready";
      } else if (parsed.action === "link-creator" && invitation !== null) {
        invitation.status = "verified";
        invitation.verifiedActorId = z.string().parse(parsed.actorId);
        invitation.verifiedSessionId = null;
        invitation.linkedFromInvitationId = z.string().parse(parsed.sourceInvitationId);
        if (failAfterLink) {
          failAfterLink = false;
          throw new Error("link response lost");
        }
      }
      return invitation;
    },
    async *linkedCreatorCandidates() {
      for (const candidate of options.candidates ?? []) {
        yield candidate.row;
      }
    },
    now: () => clock,
    readCurrent: async () => row,
    readInvitation: async (saved) => {
      invitationReads += 1;
      if (unknownRead) {
        throw new Error("unavailable Auth read");
      }
      return saved.operationRef === row.operationRef
        ? invitation
        : (options.candidates?.find(
            (candidate) => candidate.row.operationRef === saved.operationRef,
          )?.invitation ?? null);
    },
    readOwner: async () => ({ email: options.ownerEmail ?? "Creator@Example.com" }),
    realmDigest: () => options.realmDigest ?? "e".repeat(64),
    resume: async (_row, sessionId, assertCurrent) => {
      await assertCurrent();
      resumes.push(sessionId);
      return { state: "ready" };
    },
  });
  return {
    bridge,
    context,
    requests,
    resumes,
    invitationReads: () => invitationReads,
    completionFenceChecks: () => completionFenceChecks,
    setCompletionBusy: () => {
      completionBusy = true;
    },
    row: () => row,
    compareAndSet: async (before: RepositoryProductionRow, record: RepositoryProductionRecord) => {
      if (before.revision !== row.revision) {
        return;
      }
      row = { ...row, revision: row.revision + 1, record: structuredClone(record) };
      // oxlint-disable-next-line typescript/consistent-return -- Preserve optional creator journal fixture results.
      return structuredClone(row);
    },
    approveAllocated: () => {
      row = {
        ...row,
        record: {
          ...row.record,
          privateState: { sealed: "retained" },
          approval: {
            approvalId: "setup-approval-A",
            approvedByCallId: "setup-call",
            planDigest: repositoryProductionApprovalDigest(targetScope, row.record.intent),
          },
          effects: {
            ...row.record.effects,
            "allocate-storage": { state: "applied" },
            "install-schema": {
              state: "pending",
              attemptId: "11111111-1111-4111-a111-111111111111",
            },
          },
        },
      };
    },
    invitation: () => invitation,
    absentLegacy: () => {
      invitation = null;
      row = {
        ...row,
        record: {
          ...row.record,
          workerCheckpoints: row.record.workerCheckpoints.filter(
            (value) =>
              z
                .object({ kind: z.literal("repository-production-creator-link-v1") })
                .safeParse(value).success,
          ),
        },
      };
    },
    unknownRead: () => {
      unknownRead = true;
    },
    bindActor: () => {
      row = { ...row, record: { ...row.record, creatorActorId: "already-bound" } };
    },
    patchInvitation: (value: Record<string, z.infer<ReturnType<typeof z.json>>>) => {
      invitation = { ...invitation, ...value };
    },
    interruptCreate: () => {
      failBeforeCreate = true;
    },
    loseCreateResponse: () => {
      failAfterCreate = true;
    },
    loseLinkResponse: () => {
      failAfterLink = true;
    },
    completeCreator: () => {
      row = {
        ...row,
        record: {
          ...row.record,
          effects: { ...row.record.effects, "creator-access": { state: "applied" } },
        },
      };
    },
    deny: () => {
      authorized = false;
    },
    advance: () => {
      clock = new Date(clock.getTime() + 8 * 24 * 60 * 60 * 1000);
    },
    revise: () => {
      row = {
        ...row,
        record: {
          ...row.record,
          intent: {
            ...row.record.intent,
            sessionId: "revision-session",
            sourceSha: "c".repeat(40),
            creatorRoles: ["reader"],
          },
        },
      };
    },
    corruptScope: () => {
      row = { ...row, record: { ...row.record, scope: { ...scope, organizationId: "other-org" } } };
    },
  };
};

describe("Production creator continuation", () => {
  const linkedOwner = async () => {
    const original = harness();
    await original.bridge.prepare(original.context());
    original.patchInvitation({
      status: "accepted",
      verifiedActorId: "actor-1",
      verifiedSessionId: "expired-original-session",
    });
    original.completeCreator();
    return { row: original.row(), invitation: original.invitation() };
  };

  it("recovers an uncreated legacy invitation for the selected account in the same operation", async () => {
    const h = harness({ ownerEmail: "builder@example.com", persistent: true });
    await h.bridge.prepare(h.context());
    h.absentLegacy();
    const operation = h.row().operationRef;
    const resource = structuredClone(h.row().record.resource);
    const requestId = randomUUID();
    await h.bridge.chooseRecipient(h.context(), "app@example.com", requestId);
    await h.bridge.chooseRecipient(h.context(), "app@example.com", requestId);
    expect(await h.bridge.describe(h.row())).toMatchObject({
      status: "failed",
      retryable: true,
      email: "app@example.com",
      canChooseAccount: true,
    });
    expect(await h.bridge.describe(h.row())).not.toHaveProperty("signInUrl");
    await h.bridge.prepare(h.context());
    expect(h.row().operationRef).toBe(operation);
    expect(h.row().record.resource).toEqual(resource);
    expect(h.invitation()).toMatchObject({
      email: "app@example.com",
      verifiedActorId: null,
      status: "pending",
    });
    expect(await h.bridge.readCreator(h.row())).toHaveProperty("signInUrl");
  });

  it("runs a real People choice through pending setup and a lost create reply without restoring the older plan account", async () => {
    const h = harness({ creatorEmail: "plan-A@example.com", persistent: true });
    h.approveAllocated();
    const original = structuredClone(h.row());
    const setup = createRepositoryProductionSetup({
      store: {
        read: async () => structuredClone(h.row()),
        reserve: async () => {
          throw new Error("must retain setup");
        },
        compareAndSet: h.compareAndSet,
      },
      assertAuthorized: async (target, requested) => {
        expect(repositoryProductionApprovalDigest(target, requested)).toBe(
          h.row().record.approval?.planDigest,
        );
      },
      withLease: async (_scope, run) => await run(async () => {}),
      reservePrivateState: async () => {
        throw new Error("must retain credentials");
      },
      prepareCreatorIdentity: (context) => h.bridge.prepare(context),
      readCreatorIdentity: async (row) => {
        const proof = await h.bridge.readCreator(row);
        return "state" in proof ? proof : { state: "verified", actorId: proof.actorId };
      },
      apply: async () => {
        throw new Error("must wait for the real Auth session");
      },
      reconcile: async ({ effect }) => {
        if (effect !== "allocate-storage") {
          throw new Error("must not query uninstalled schema");
        }
        return { state: "applied", receipt: { retained: true } };
      },
    });
    const rows = new Map<string, AppAccessOperationRow>();
    const owner = {
      appId: scope.appId,
      sessionId: "original-session",
      ownerContext: {
        kind: "direct" as const,
        authority: scope.authority,
        principal: { ...scope.authority, scopes: ["autograph:session"] },
        sessionId: "original-session",
        adapterSessionId: "adapter",
        adapterGeneration: 1,
      },
    };
    const service = createAppAccessManagementService({
      resolve: async () => ({
        scope,
        appName: "Equipment log",
        organizationName: "Dev",
        roles: [{ id: "editor", label: "Editor" }],
        canManage: true,
        creator: await h.bridge.describe(h.row()),
      }),
      assertAuthorized: async () => {},
      readPeople: async () => ({ members: [], invitations: [] }),
      withLease: async (_scope, run) => await run(async () => {}),
      journal: {
        pending: async () => [...rows.values()].filter((entry) => entry.record.state === "pending"),
        reserve: async (record) => {
          const id = record.command.clientRequestId;
          const saved = rows.get(id) ?? { record, revision: 1 };
          rows.set(id, saved);
          return saved;
        },
        update: async (before, record) => {
          const id = record.command.clientRequestId;
          if (rows.get(id)?.revision !== before.revision) {
            return;
          }
          const saved = { record, revision: before.revision + 1 };
          rows.set(id, saved);
          // oxlint-disable-next-line typescript/consistent-return -- Preserve optional creator journal fixture results.
          return saved;
        },
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Model an invitation lookup with no result.
        findInvitation: async () => undefined,
      },
      execute: async (_scope, command, effect) => {
        if (command.action !== "choose-creator-account") {
          throw new Error("unexpected action");
        }
        await h.bridge.chooseRecipient(
          { ...h.context(), assertCurrent: effect.assertCurrent },
          command.email,
          effect.operationRef,
        );
        await setup.prepare(scope, h.row().record.intent);
        return "applied";
      },
      reconcile: async () => "absent",
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Model a verified invitation lookup with no result.
      readVerifiedInvitation: async () => undefined,
      enrollInvitee: async () => {
        throw new Error("must not grant");
      },
      reconcileInvitee: async () => "unknown",
      acceptInvitation: async () => {
        throw new Error("must not grant");
      },
    });
    const command = {
      action: "choose-creator-account" as const,
      email: "chosen-B@example.com",
      clientRequestId: randomUUID(),
    };
    h.loseCreateResponse();
    await expect(service.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    await expect(service.execute(owner, command)).resolves.toMatchObject({
      creator: { email: "chosen-b@example.com", status: "sign_in_required" },
    });
    expect(h.invitation()).toMatchObject({ email: "chosen-b@example.com", verifiedActorId: null });
    expect(h.row().record.intent).toEqual(original.record.intent);
    expect(h.row().record.approval).toEqual(original.record.approval);
    expect(h.row().operationRef).toBe(original.operationRef);
    expect(h.row().record.resource).toEqual(original.record.resource);
    expect(h.row().record.privateState).toEqual(original.record.privateState);
    expect(h.requests.filter((request) => request.action === "create")).toHaveLength(1);
    expect(h.requests.filter((request) => request.action === "send")).toHaveLength(1);
    expect(h.row().record.effects["creator-access"].state).toBe("idle");
  });

  it("does not let an older setup recipient silently undo an explicit People choice", async () => {
    const h = harness({ creatorEmail: "original-plan@example.com" });
    await h.bridge.chooseRecipient(h.context(), "chosen@example.com", randomUUID());
    await h.bridge.prepare(h.context());
    expect(h.invitation()?.email).toBe("chosen@example.com");
  });

  it("does not change the selected account after an uncertain create dispatch", async () => {
    const h = harness();
    h.interruptCreate();
    await expect(h.bridge.prepare(h.context())).rejects.toThrow();
    expect(h.invitation()).toBeNull();
    await expect(
      h.bridge.chooseRecipient(h.context(), "other@example.com", randomUUID()),
    ).rejects.toThrow();
    expect(await h.bridge.describe(h.row())).toMatchObject({
      status: "failed",
      retryable: true,
      canChooseAccount: false,
    });
    await h.bridge.prepare(h.context());
    expect(h.invitation()?.email).toBe("creator@example.com");
  });

  it("allows one concurrent recipient choice and preserves its stable operation", async () => {
    const h = harness();
    const operation = h.row().operationRef;
    const first = h.context();
    const second = h.context();
    const outcomes = await Promise.allSettled([
      h.bridge.chooseRecipient(first, "first@example.com", randomUUID()),
      h.bridge.chooseRecipient(second, "second@example.com", randomUUID()),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(h.row().operationRef).toBe(operation);
    expect(h.requests).toEqual([]);
    await h.bridge.prepare(h.context());
    expect(["first@example.com", "second@example.com"]).toContain(h.invitation()?.email);
  });

  it("keeps an initially selected account through verified access and an ordinary revision", async () => {
    const h = harness({ creatorEmail: "app@example.com" });
    await h.bridge.prepare(h.context());
    expect(h.invitation()?.email).toBe("app@example.com");
    h.patchInvitation({
      status: "accepted",
      verifiedActorId: "real-auth-actor",
      verifiedSessionId: "auth-session",
    });
    h.completeCreator();
    const requests = h.requests.length;
    h.revise();
    await h.bridge.prepare(h.context());
    expect(h.requests).toHaveLength(requests);
    expect(await h.bridge.readCreator(h.row())).toMatchObject({ actorId: "real-auth-actor" });
  });

  it("does not expose a sign-in link for an invitation that has not been created", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    h.absentLegacy();
    expect(await h.bridge.readCreator(h.row())).not.toHaveProperty("signInUrl");
    expect(await h.bridge.describe(h.row())).toMatchObject({
      status: "failed",
      retryable: true,
      canChooseAccount: true,
    });
  });

  it.each(["invitation", "actor", "grant", "unknown"] as const)(
    "preserves existing %s state when choosing an account",
    async (state) => {
      const h = harness();
      await h.bridge.prepare(h.context());
      if (state !== "invitation") {
        h.absentLegacy();
      }
      if (state === "actor") {
        h.bindActor();
      }
      if (state === "grant") {
        h.completeCreator();
      }
      if (state === "unknown") {
        h.unknownRead();
      }
      const before = structuredClone(h.row());
      await expect(
        h.bridge.chooseRecipient(h.context(), "other@example.com", randomUUID()),
      ).rejects.toThrow();
      expect(h.row()).toEqual(before);
    },
  );

  it("reuses the linked account email across apps and does not borrow it for an explicitly different account", async () => {
    const source = await linkedOwner();
    const next = harness({
      scope: { ...scope, appId: "linked-app" },
      ownerEmail: "different-builder@example.com",
      candidates: [source],
    });
    await next.bridge.prepare(next.context());
    expect(next.invitation()?.email).toBe(source.invitation?.email);
    expect(next.requests.map((request) => request.action)).toEqual(["create", "link-creator"]);
    const explicit = harness({ scope: { ...scope, appId: "explicit-app" }, candidates: [source] });
    await explicit.bridge.chooseRecipient(
      explicit.context(),
      "another-app-account@example.com",
      randomUUID(),
    );
    await explicit.bridge.prepare(explicit.context());
    expect(explicit.invitation()?.email).toBe("another-app-account@example.com");
    expect(explicit.requests.map((request) => request.action)).toEqual(["create", "send"]);
    expect(explicit.invitation()?.verifiedActorId).toBeNull();
  });

  it("reuses the verified owner identity for a different app without sending another sign-in email", async () => {
    const source = await linkedOwner();
    const next = harness({ scope: { ...scope, appId: "another-app" }, candidates: [source] });
    await next.bridge.prepare(next.context());
    expect(next.requests.map((request) => request.action)).toEqual(["create", "link-creator"]);
    expect(await next.bridge.readCreator(next.row())).toMatchObject({
      actorId: "actor-1",
      invitationId: next.row().operationRef,
      kind: "managed-invitation",
    });
    expect(next.row().operationRef).not.toBe(source.row.operationRef);
    expect(source.invitation?.status).toBe("accepted");
    expect(next.invitation()?.verifiedSessionId).toBeNull();
    next.patchInvitation({ status: "accepted" });
    next.completeCreator();
    const third = harness({
      scope: { ...scope, appId: "third-app" },
      candidates: [{ row: next.row(), invitation: next.invitation() }],
    });
    await third.bridge.prepare(third.context());
    expect(third.requests.map((request) => request.action)).toEqual(["create", "link-creator"]);
    expect(await third.bridge.readCreator(third.row())).toHaveProperty("actorId", "actor-1");
  });

  it("requires the exact recorded source and actor when reading a linked target", async () => {
    const source = await linkedOwner();
    const next = harness({ scope: { ...scope, appId: "another-app" }, candidates: [source] });
    await next.bridge.prepare(next.context());
    next.patchInvitation({ linkedFromInvitationId: randomUUID() });
    expect(await next.bridge.readCreator(next.row())).toHaveProperty("state", "required");
    next.patchInvitation({
      linkedFromInvitationId: source.row.operationRef,
      verifiedActorId: "different-actor",
    });
    expect(await next.bridge.readCreator(next.row())).toHaveProperty("state", "required");
    expect(await next.bridge.complete(next.row().operationRef)).toBe("pending");
  });

  it.each(["owner", "workspace", "realm"])(
    "does not reuse a verified creator across a different %s",
    async (difference) => {
      const source = await linkedOwner();
      const targetScope: RepositoryProductionScope = {
        ...scope,
        appId: "another-app",
        authority: { ...scope.authority },
      };
      if (difference === "owner") {
        targetScope.authority.ownerUserId = "other-owner";
      }
      if (difference === "workspace") {
        targetScope.authority.workspaceId = "other-workspace";
      }
      const options: NonNullable<Parameters<typeof harness>[0]> = { scope: targetScope };
      if (difference === "realm") {
        options.realmDigest = "f".repeat(64);
      }
      const next = harness({ ...options, candidates: [source] });
      await next.bridge.prepare(next.context());
      expect(next.requests.map((request) => request.action)).toEqual(["create", "send"]);
      expect(await next.bridge.readCreator(next.row())).toHaveProperty("state", "required");
    },
  );

  it("requires an accepted source identity and reconciles a lost link reply without another enrollment", async () => {
    const source = await linkedOwner();
    const rejected = harness({
      scope: { ...scope, appId: "not-linked" },
      candidates: [{ ...source, invitation: { ...source.invitation, status: "pending" } }],
    });
    await rejected.bridge.prepare(rejected.context());
    expect(rejected.requests.map((request) => request.action)).toEqual(["create", "send"]);
    const next = harness({ scope: { ...scope, appId: "another-app" }, candidates: [source] });
    next.loseLinkResponse();
    await expect(next.bridge.prepare(next.context())).rejects.toThrow("link response lost");
    await next.bridge.prepare(next.context());
    expect(next.requests.map((request) => request.action)).toEqual(["create", "link-creator"]);
    expect(await next.bridge.readCreator(next.row())).toHaveProperty("actorId", "actor-1");
  });

  it("does not use another destination's same-app link to restore app access", async () => {
    const source = await linkedOwner();
    const next = harness({
      scope: { ...scope, organizationId: "another-organization" },
      candidates: [source],
    });
    await next.bridge.prepare(next.context());
    expect(next.requests.map((request) => request.action)).toEqual(["create", "send"]);
    expect(await next.bridge.readCreator(next.row())).toHaveProperty("state", "required");
  });

  it("persists owner/session scope before creating and sending, then reuses the same invitation", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    await h.bridge.prepare(h.context());
    expect(h.requests.map((value) => value.action)).toEqual(["create", "send"]);
    expect(h.requests.every((value) => value.frameCount > 0)).toBe(true);
    expect(h.invitation()).toMatchObject({
      email: "creator@example.com",
      returnUrl: "https://builder.example/builds/original-session/access",
    });
    expect(await h.bridge.readCreator(h.row())).toEqual({
      state: "required",
      signInUrl: `https://apps.example/api/auth/platform/app-invitation/accept?invitationId=${h.row().operationRef}`,
      expiresAt: h.invitation()?.expiresAt,
    });
  });

  it("reads the retained invitation expiry without renewing or sending another link", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    const expiresAt = "2026-11-07T15:10:00.000Z";
    h.patchInvitation({ expiresAt });
    const before = [...h.requests];
    h.advance();
    expect(await h.bridge.readCreator(h.row())).toMatchObject({ expiresAt, state: "required" });
    expect(await h.bridge.describe(h.row())).toMatchObject({ expiresAt });
    expect(h.requests).toEqual(before);
    expect(h.resumes).toEqual([]);
  });

  it("reconciles a lost create response without allocating another invitation", async () => {
    const h = harness();
    h.loseCreateResponse();
    await expect(h.bridge.prepare(h.context())).rejects.toThrow("response lost");
    await h.bridge.prepare(h.context());
    expect(h.requests.map((value) => value.action)).toEqual(["create", "send"]);
  });

  it("never turns matching email into identity proof; actual Auth actor and session are required", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    h.patchInvitation({ status: "verified", verifiedActorId: "actor-1" });
    expect(await h.bridge.readCreator(h.row())).toHaveProperty("state", "required");
    expect(await h.bridge.complete(h.row().operationRef)).toBe("pending");
    expect(h.resumes).toEqual([]);
    h.patchInvitation({ verifiedSessionId: "real-auth-session" });
    expect(await h.bridge.readCreator(h.row())).toEqual({
      actorId: "actor-1",
      invitationId: h.row().operationRef,
      kind: "managed-invitation",
      scopeDigest: "b".repeat(64),
    });
    expect(await h.bridge.complete(h.row().operationRef)).toBe("ready");
    expect(h.resumes).toEqual(["original-session"]);
  });

  it("coalesces an automatic completion before starting another Auth read or setup resume", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    h.patchInvitation({
      status: "verified",
      verifiedActorId: "actor-1",
      verifiedSessionId: "real-auth-session",
    });
    const reads = h.invitationReads();
    h.setCompletionBusy();
    await expect(h.bridge.complete(h.row().operationRef)).rejects.toThrow("completion busy");
    expect(h.invitationReads()).toBe(reads);
    expect(h.resumes).toEqual([]);
  });

  it("retains the physical completion fence through verified identity and the original resume", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    h.patchInvitation({
      status: "verified",
      verifiedActorId: "actor-1",
      verifiedSessionId: "real-auth-session",
    });
    expect(await h.bridge.complete(h.row().operationRef)).toBe("ready");
    expect(h.completionFenceChecks()).toBeGreaterThanOrEqual(3);
    expect(h.resumes).toEqual(["original-session"]);
  });

  it("reuses accepted identity across revisions and resumes the original owner session", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    h.patchInvitation({
      status: "accepted",
      verifiedActorId: "actor-1",
      verifiedSessionId: "real-auth-session",
    });
    h.revise();
    await h.bridge.prepare(h.context());
    expect(await h.bridge.readCreator(h.row())).toHaveProperty("actorId", "actor-1");
    await h.bridge.complete(h.row().operationRef);
    expect(h.resumes).toEqual(["original-session"]);
    expect(h.requests.map((value) => value.action)).toEqual(["create", "send"]);
  });

  it.each(["appId", "organizationId", "workspaceId", "email", "returnUrl", "operationRef"])(
    "rejects a mismatched Auth %s",
    async (field) => {
      const h = harness();
      await h.bridge.prepare(h.context());
      const replacements = new Map([
        ["email", "other@example.com"],
        ["returnUrl", "https://other.example"],
        ["operationRef", randomUUID()],
      ]);
      const replacement = replacements.get(field) ?? "other";
      h.patchInvitation({ [field]: replacement });
      await expect(h.bridge.readCreator(h.row())).rejects.toThrow(
        "repository_production_creator_invitation_mismatch",
      );
      expect(h.resumes).toEqual([]);
    },
  );

  it("rejects a moved owner scope or revoked canonical authorization", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    h.corruptScope();
    await expect(h.bridge.readCreator(h.row())).rejects.toThrow(
      "repository_production_creator_owner_mismatch",
    );
    const other = harness();
    await other.bridge.prepare(other.context());
    other.deny();
    await expect(other.bridge.complete(other.row().operationRef)).rejects.toThrow("denied");
  });

  it("keeps read/status side-effect free and never resends unknown delivery automatically", async () => {
    const h = harness();
    expect(await h.bridge.readCreator(h.row())).toEqual({ state: "required" });
    expect(await h.bridge.describe(h.row())).toMatchObject({ status: "setting_up" });
    expect(await h.bridge.readRecipient(h.row())).toBeUndefined();
    expect(h.requests).toEqual([]);
    await h.bridge.prepare(h.context());
    h.patchInvitation({ deliveryStatus: "unknown" });
    await h.bridge.prepare(h.context());
    await h.bridge.describe(h.row());
    expect(h.requests.map((value) => value.action)).toEqual(["create", "send"]);
  });

  it("requires explicit renewal, retains the invitation, and does not duplicate retries", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    h.advance();
    await h.bridge.prepare(h.context());
    expect(h.requests.map((value) => value.action)).toEqual(["create", "send"]);
    const requestId = randomUUID();
    await h.bridge.renew(h.context(), requestId);
    const expiry = h.invitation()?.expiresAt;
    await h.bridge.renew(h.context(), requestId);
    expect(h.invitation()?.expiresAt).toBe(expiry);
    expect(h.requests.map((value) => value.action)).toEqual(["create", "send", "renew", "send"]);
    expect(h.requests[1]?.operationRef).not.toBe(h.requests[3]?.operationRef);
  });

  it("permits an explicit resend even within the same clock instant", async () => {
    const h = harness();
    await h.bridge.prepare(h.context());
    await h.bridge.renew(h.context(), randomUUID());
    expect(h.requests.map((value) => value.action)).toEqual(["create", "send", "renew", "send"]);
  });

  it("does not claim unrelated invitations or renew a cancelled creator link", async () => {
    const h = harness();
    expect(await h.bridge.complete(randomUUID())).toBe("not-owned");
    await h.bridge.prepare(h.context());
    h.patchInvitation({ status: "cancelled" });
    await expect(h.bridge.renew(h.context(), randomUUID())).rejects.toThrow(
      "repository_production_creator_invitation_cancelled",
    );
  });
});
