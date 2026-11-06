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
const harness = () => {
  let row: RepositoryProductionRow = {
    operationRef: repositoryProductionOperationRef(scope),
    revision: 0,
    record: initialRepositoryProductionRecord(scope, {
      sessionId: "original-session",
      sourceSha: "a".repeat(40),
      creatorRoles: ["editor"],
      storage: { kind: "none" },
    }),
  };
  let invitation: Record<string, z.infer<ReturnType<typeof z.json>>> | null = null;
  const requests: { action: string; operationRef: string; frameCount: number }[] = [];
  const resumes: string[] = [];
  let failAfterCreate = false;
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
    builderOrigin: "https://builder.example",
    now: () => clock,
    readOwner: async () => ({ email: "Creator@Example.com" }),
    readCurrent: async () => row,
    findInvitation: async (id) => (id === row.operationRef ? row : undefined),
    readInvitation: async () => invitation,
    assertAuthorized,
    resume: async (_row, sessionId) => {
      resumes.push(sessionId);
      return { state: "ready" };
    },
    invokeAuth: async (current, request) => {
      const parsed = z
        .object({
          action: z.string(),
          invitation: z.record(z.string(), z.json()).optional(),
          expiresAt: z.string().optional(),
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
          workspaceId: scope.authority.workspaceId,
          appId: scope.appId,
          organizationId: scope.organizationId,
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
      }
      return invitation;
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
    });
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
      kind: "managed-invitation",
      invitationId: h.row().operationRef,
      actorId: "actor-1",
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
