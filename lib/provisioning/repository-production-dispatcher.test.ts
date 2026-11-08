/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member -- Async fixture ports retain rejection semantics; assertions inspect their awaited outcomes directly. */
import { z } from "zod";
import { createRepositoryProductionManagement } from "../app-access/native-management";
import { RepositoryProductionDestinationRequiredError } from "./repository-production-destination";
import { HostedOperatorError } from "./hosted-operator-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryProductionSetup } from "./repository-production-setup";
import type { RepositoryProductionSetupPorts } from "./repository-production-setup";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
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
  RepositoryProductionRow,
} from "./repository-production-contract";

afterEach(() => vi.restoreAllMocks());

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
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
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
  it("carries the selected creator account through normal protected planning and preparation", async () => {
    const f = fixture();
    const planned = await f.send({
      version: 1,
      ...owner,
      action: "plan",
      creatorEmail: "APP@EXAMPLE.TEST",
    });
    expect(planned.status).toBe(200);
    expect(f.deps.resolvePlan).toHaveBeenCalledWith(owner, "app@example.test");
    const prepared = await f.send({
      version: 1,
      ...owner,
      action: "prepare",
      approvedByCallId: "approved",
      creatorEmail: "APP@EXAMPLE.TEST",
    });
    expect(prepared.status).toBe(200);
    expect(f.deps.resolveSetup).toHaveBeenCalledWith(owner, "approved", "app@example.test");
  });

  it.each(["idle", "pending"] as const)(
    "projects the real initial sign-in before app schema exists (%s schema)",
    async (schemaState) => {
      const f = fixture();
      const appIntent: RepositoryProductionIntent = {
        ...intent,
        creatorRoles: ["requester"],
        storage: {
          kind: "postgres",
          artifactRef: "checked-release",
          releaseId: "release",
          manifestSha256: "b".repeat(64),
          databaseEnvironment: "APP_DATABASE_URL",
        },
      };
      let row: RepositoryProductionRow = {
        operationRef: repositoryProductionOperationRef(scope),
        revision: 1,
        record: {
          ...initialRepositoryProductionRecord(scope, appIntent),
          privateState: { sealed: "existing-credentials" },
          lease: { leaseId: "11111111-1111-4111-a111-111111111111", fenceGeneration: 1 },
        },
      };
      row.record.effects["allocate-storage"] = { state: "applied", receipt: { owned: true } };
      row.record.effects["install-schema"] = { state: schemaState };
      const signInUrl = `${scope.publicOrigin}/api/auth/platform/app-invitation/accept?invitationId=${row.operationRef}`;
      const unavailableAppDatabase = vi.fn(async () => {
        throw new Error("app schema is not installed");
      });
      const prepareIdentity = vi.fn(async () => {});
      const setup = createRepositoryProductionSetup({
        store: {
          read: async () => structuredClone(row),
          reserve: unavailableAppDatabase,
          compareAndSet: async (before, record) => {
            expect(before.revision).toBe(row.revision);
            row = { ...row, revision: row.revision + 1, record: structuredClone(record) };
            return structuredClone(row);
          },
        },
        assertAuthorized: async () => {},
        withLease: async (_scope, run) => await run(async () => {}),
        reservePrivateState: unavailableAppDatabase,
        prepareCreatorIdentity: prepareIdentity,
        readCreatorIdentity: async () => ({ state: "required", signInUrl }),
        apply: unavailableAppDatabase,
        reconcile: async ({ effect }) =>
          effect === "allocate-storage"
            ? { state: "applied", receipt: { owned: true } }
            : await unavailableAppDatabase(),
      });
      const authReads: string[] = [];
      const management = createRepositoryProductionManagement({
        builderOrigin: "https://builder.test",
        readSetup: async () => structuredClone(row),
        realm: () => ({}),
        appUrl: async () => `${scope.publicOrigin}/${scope.appId}`,
        roles: async () => appIntent.creatorRoles,
        assertAuthorized: async () => {},
        withLease: async (_scope, run) => await run(async () => {}),
        journal: {
          pending: async () => [],
          reserve: unavailableAppDatabase,
          update: unavailableAppDatabase,
          findInvitation: unavailableAppDatabase,
        },
        retrySetup: unavailableAppDatabase,
        renewSignIn: unavailableAppDatabase,
        chooseCreatorAccount: unavailableAppDatabase,
        resolve: async () => {
          const state = await setup.status(scope, appIntent);
          return {
            scope,
            appName: "Requests",
            organizationName: "Dev",
            canManage: true,
            roles: appIntent.creatorRoles.map((id) => ({ id, label: id })),
            creator: {
              status: state.state === "identity-required" ? "sign_in_required" : "setting_up",
              // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
              ...(state.signInUrl === undefined ? {} : { signInUrl: state.signInUrl }),
            },
          };
        },
        workers: () => ({
          mutateAppAccess: unavailableAppDatabase,
          inspectAppAccess: unavailableAppDatabase,
          invokeAuthManagement: async (context, input, readOnly) => {
            const { action } = z
              .object({ request: z.object({ action: z.string() }) })
              .parse(input).request;
            expect(readOnly).toBe(true);
            expect(["list-members", "list"]).toContain(action);
            authReads.push(action);
            return {
              version: 1,
              status: "applied",
              operation_id: context.row.operationRef,
              context_digest: "c".repeat(64),
              fence_generation: 1,
              readback_sha256: "d".repeat(64),
              result: [],
            };
          },
        }),
      });
      f.deps.management.read = management.read;
      vi.mocked(f.deps.resolveSetup).mockResolvedValue({ scope, intent: appIntent, setup });
      const response = await f.send({
        version: 1,
        ...owner,
        action: "prepare",
        approvedByCallId: "approved",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        creator: { status: "sign_in_required", signInUrl },
        members: [],
        invitations: [],
        setup: { state: "identity-required", signInUrl },
      });
      expect(prepareIdentity).toHaveBeenCalledOnce();
      expect(authReads).toEqual(["list-members", "list"]);
      expect(unavailableAppDatabase).not.toHaveBeenCalled();
      expect(row.record.effects["install-schema"].state).toBe(schemaState);
    },
  );
  it("plans without provisioning and refuses a prepare with no saved approval", async () => {
    const f = fixture();
    const response = await f.send({ version: 1, ...owner, action: "plan" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ plan: { intent, scope }, version: 1 });
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
  it("observes an actual setup fence rejection before access projection", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    const failure = new Error("Protected resource lease fence is stale.", {
      cause: "private-provider-token",
    });
    const unexpected = vi.fn(async () => {
      throw new Error("unexpected effect");
    });
    const ports: RepositoryProductionSetupPorts = {
      store: {
        read: vi.fn(async () => ({
          operationRef: repositoryProductionOperationRef(scope),
          revision: 1,
          record: initialRepositoryProductionRecord(scope, intent),
        })),
        reserve: unexpected,
        compareAndSet: unexpected,
      },
      assertAuthorized: vi.fn(async () => {}),
      withLease: async (_scope, run) =>
        await run(async () => {
          throw failure;
        }),
      reservePrivateState: unexpected,
      readCreatorIdentity: unexpected,
      reconcile: unexpected,
      apply: unexpected,
    };
    vi.mocked(f.deps.resolveSetup).mockResolvedValue({
      scope,
      intent,
      setup: createRepositoryProductionSetup(ports),
    });
    const response = await f.send({
      version: 1,
      ...owner,
      action: "prepare",
      approvedByCallId: "approved",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "app_access_unknown" });
    expect(f.deps.management.read).not.toHaveBeenCalled();
    expect(unexpected).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"phase":"setup_prepare"'));
    expect(log.mock.calls.flat().join("")).toContain('"reason":"lease_fence_stale"');
    expect(log.mock.calls.flat().join("")).not.toContain("private-provider-token");
  });

  it("records request cancellation while preserving the existing sanitized setup response", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    const controller = new AbortController();
    f.prepared.mockImplementation(async () => {
      controller.abort();
      throw new HostedOperatorError("operator_unavailable", { cause: "private-cancel-token" });
    });
    const response = await createRepositoryProductionHandler(f.deps)(
      new Request(`https://operator.test${repositoryProductionPath}`, {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: "Bearer builder", "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          ...owner,
          action: "prepare",
          approvedByCallId: "approved",
        }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "app_access_unknown" });
    expect(f.deps.management.read).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      phase: "setup_prepare",
      operatorCode: "operator_unavailable",
      requestAborted: true,
    });
    expect(log.mock.calls.flat().join("")).not.toContain("private-cancel-token");
  });

  it("distinguishes projection rejection after successful setup and preserves sanitized 503", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    vi.mocked(f.deps.management.read).mockRejectedValue(
      new Error("repository_production_owner_changed", { cause: "private-connection-url" }),
    );
    const response = await f.send({
      version: 1,
      ...owner,
      action: "prepare",
      approvedByCallId: "approved",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "app_access_unknown" });
    expect(f.prepared).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"phase":"setup_projection"'));
    const output = log.mock.calls.flat().join("");
    expect(output).toContain('"reason":"authority_changed"');
    expect(output).not.toContain('"phase":"setup_prepare"');
    expect(output).not.toContain("private-connection-url");
  });

  it("classifies invalid access projection without leaking the rejected snapshot", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    vi.mocked(f.deps.management.read).mockResolvedValue({ ...snapshot, appId: "" });
    const response = await f.send({
      version: 1,
      ...owner,
      action: "prepare",
      approvedByCallId: "approved",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "app_access_unknown" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"schema_invalid"'));
    expect(log.mock.calls.flat().join("")).toContain('"phase":"setup_projection"');
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
      status: "ready",
      version: 1,
    });
    expect(f.deps.verifyBuilderWorkload).not.toHaveBeenCalled();
  });
  it("returns progress without closing the verified callback's operation", async () => {
    const f = fixture();
    const work = Promise.withResolvers<"ready">();
    const retain = vi.fn<(task: Promise<void>) => void>();
    const dispose = vi.fn(async () => {});
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    vi.mocked(f.deps.management.completeInvitation).mockImplementation(() =>
      observeRepositoryProductionCompletion(work.promise, retain, dispose, 5),
    );
    const response = await f.send(
      { version: 1, invitationId: "11111111-1111-4111-a111-111111111111" },
      "auth",
      repositoryProductionCompletionPath,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "pending", version: 1 });
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
