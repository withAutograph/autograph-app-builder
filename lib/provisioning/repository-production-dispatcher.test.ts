/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member -- Async fixture ports retain rejection semantics; assertions inspect their awaited outcomes directly. */
import type { z } from "zod";
import { RepositoryProductionDestinationRequiredError } from "./repository-production-destination";
import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryProductionHandler,
  observeRepositoryProductionCompletion,
  repositoryProductionPath,
  repositoryProductionCompletionPath,
} from "./repository-production-dispatcher";
import type { RepositoryProductionHandlerDependencies } from "./repository-production-dispatcher";
import type {
  RepositoryProductionScope,
  RepositoryProductionIntent,
} from "./repository-production-contract";

const authority = {
  issuer: "https://builder.test/api/auth",
  audience: "https://builder.test/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const owner = {
  appId: "requests",
  sessionId: "session",
  ownerContext: {
    kind: "direct" as const,
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: "session",
    adapterSessionId: "adapter",
    adapterGeneration: 1,
  },
};
const scope: RepositoryProductionScope = {
  authority,
  appId: "requests",
  repositoryId: "repo",
  repositoryFullName: "example/repo",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.test",
  environment: "production",
};
const intent: RepositoryProductionIntent = {
  sessionId: "session",
  sourceSha: "a".repeat(40),
  creatorRoles: [],
  storage: { kind: "none" },
};
const snapshot = {
  sessionId: "session",
  appId: "requests",
  appName: "Requests",
  organizationName: "Dev",
  canManage: true,
  roles: [],
  members: [],
  invitations: [],
  creator: { status: "ready" as const },
};
const fixture = () => {
  const prepared = vi.fn(async () => ({
    operationRef: "11111111-1111-4111-a111-111111111111",
    state: "ready" as const,
  }));
  const deps: RepositoryProductionHandlerDependencies = {
    verifyBuilderWorkload: vi.fn(async (request: Request) => {
      if (request.headers.get("authorization") !== "Bearer builder") {
        throw new Error("denied");
      }
    }),
    verifyAuthWorkload: vi.fn(async (request: Request) => {
      if (request.headers.get("authorization") !== "Bearer auth") {
        throw new Error("denied");
      }
    }),
    resolvePlan: vi.fn(async () => ({ scope, intent })),
    readSetup: prepared,
    resolveSetup: vi.fn(async (_owner, id) => {
      if (id !== "approved") {
        throw new Error("no saved approval");
      }
      return { scope, intent, setup: { prepare: prepared, status: prepared } };
    }),
    management: {
      read: vi.fn(async () => snapshot),
      execute: vi.fn(async () => snapshot),
      completeInvitation: vi.fn(async () => "ready" as const),
    },
  };
  const send = (
    body: z.infer<ReturnType<typeof z.json>>,
    token = "builder",
    path = repositoryProductionPath,
  ) =>
    createRepositoryProductionHandler(deps)(
      new Request(`https://operator.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { deps, prepared, send };
};
describe("protected repository Production dispatcher", () => {
  it("plans without provisioning and refuses a prepare with no saved approval", async () => {
    const f = fixture();
    const response = await f.send({ version: 1, ...owner, action: "plan" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, plan: { scope, intent } });
    expect(f.prepared).not.toHaveBeenCalled();
    expect(
      (await f.send({ version: 1, ...owner, action: "prepare", approvedByCallId: "invented" }))
        .status,
    ).toBe(503);
    expect(f.prepared).not.toHaveBeenCalled();
    expect(
      (await f.send({ version: 1, ...owner, action: "prepare", approvedByCallId: "approved" }))
        .status,
    ).toBe(200);
    expect(f.prepared).toHaveBeenCalledOnce();
  });
  it("reports missing saved destination without starting setup or hiding workload denial", async () => {
    const f = fixture();
    vi.mocked(f.deps.resolvePlan).mockRejectedValue(
      new RepositoryProductionDestinationRequiredError(),
    );
    const request = { version: 1, ...owner, action: "plan" };
    const response = await f.send(request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "app_setup_destination_required" });
    expect(f.prepared).not.toHaveBeenCalled();
    expect(f.deps.resolveSetup).not.toHaveBeenCalled();
    expect((await f.send(request, "foreign-workload")).status).toBe(403);
  });
  it("keeps Auth callbacks independent of a creator's Builder session", async () => {
    const f = fixture();
    const body = { version: 1, invitationId: "11111111-1111-4111-a111-111111111111" };
    expect((await f.send(body, "builder", repositoryProductionCompletionPath)).status).toBe(403);
    expect(f.deps.management.completeInvitation).not.toHaveBeenCalled();
    expect(await (await f.send(body, "auth", repositoryProductionCompletionPath)).json()).toEqual({
      version: 1,
      status: "ready",
    });
    expect(f.deps.verifyBuilderWorkload).not.toHaveBeenCalled();
  });
  it("returns progress without closing the verified callback's operation", async () => {
    const f = fixture();
    const work = Promise.withResolvers<"ready">();
    const retain = vi.fn<(task: Promise<void>) => void>();
    const dispose = vi.fn(async () => {});
    vi.mocked(f.deps.management.completeInvitation).mockImplementation(() =>
      observeRepositoryProductionCompletion(work.promise, retain, dispose, 5),
    );
    const response = await f.send(
      { version: 1, invitationId: "11111111-1111-4111-a111-111111111111" },
      "auth",
      repositoryProductionCompletionPath,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ version: 1, status: "pending" });
    expect(retain).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    work.resolve("ready");
    await retain.mock.calls[0]?.[0];
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("rejects actor injection and moved owner-session requests before effects", async () => {
    const f = fixture();
    expect(
      (
        await f.send(
          { version: 1, invitationId: "11111111-1111-4111-a111-111111111111", actorId: "forged" },
          "auth",
          repositoryProductionCompletionPath,
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.send({ version: 1, ...owner, sessionId: "other", action: "access-status" })).status,
    ).toBe(403);
    expect(f.deps.management.read).not.toHaveBeenCalled();
    expect(f.deps.management.completeInvitation).not.toHaveBeenCalled();
  });
});
