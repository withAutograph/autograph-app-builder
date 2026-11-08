/* oxlint-disable eslint/require-await -- In-memory ports implement asynchronous production contracts. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRepositoryProductionCreator } from "./repository-production-creator";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
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
      sessionId: "original-session",
      sourceSha: "a".repeat(40),
      storage: { kind: "none" },
    }),
  };
  let invitation: Record<string, z.infer<ReturnType<typeof z.json>>> | null = null;
  const requests: { action: string; operationRef: string; frameCount: number }[] = [];
  const resumes: string[] = [];
  let failAfterCreate = false;
  let failAfterLink = false;
  let authorized = true;
  let clock = new Date("2026-11-06T10:00:00.000Z");
  const assertAuthorized = async () => {
    if (!authorized) {
      throw new Error("denied");
    }
  };
  const context = (): RepositoryProductionEffectContext => ({
    row,
    effect: "creator-access",
    assertCurrent: assertAuthorized,
    checkpoint: async (value) => {
      row = {
        ...row,
        revision: row.revision + 1,
        record: { ...row.record, workerCheckpoints: [...row.record.workerCheckpoints, value] },
      };
    },
  });
  const bridge = createRepositoryProductionCreator({
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
    readInvitation: async (saved) =>
      saved.operationRef === row.operationRef
        ? invitation
        : options.candidates?.find((candidate) => candidate.row.operationRef === saved.operationRef)
            ?.invitation,
    readOwner: async () => ({ email: "Creator@Example.com" }),
    realmDigest: () => options.realmDigest ?? "e".repeat(64),
    resume: async (_row, sessionId) => {
      resumes.push(sessionId);
      return { state: "ready" };
    },
  });
  return {
    bridge,
    context,
    requests,
    resumes,
    row: () => row,
    invitation: () => invitation,
    patchInvitation: (value: Record<string, z.infer<ReturnType<typeof z.json>>>) => {
      invitation = { ...invitation, ...value };
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
    expect(await h.bridge.describe(h.row())).toEqual({ status: "setting_up" });
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
