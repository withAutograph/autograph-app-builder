import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRealOAuthHarness,
  codexClientMetadata,
  codexClientId,
  codexRedirectUris,
  grantRealOAuth,
  refreshRealOAuth,
  registerTestCursorClient,
  origin,
  issuer,
  resource,
} from "../auth/real-oauth-test-harness";
import { cursorClientId, cursorRedirectUri } from "../auth/cursor-client";
import { previewOAuthScopes } from "../auth/preview-oauth-contract";
import { createBuilderHandoffRouteHandler } from "../handoff/deployment";
import {
  createBuilderHandoffService,
  type BuilderHandoffStore,
} from "../handoff/service";
import type { BuilderHandoffRecord } from "../handoff/contracts";
import { InMemoryHostedEveStore } from "../eve/hosted-store";
import type { HostedEveTransport } from "../eve/hosted-service";
import { createMcpRequestHandler } from "./request-handler";
import { createRemoteJwksAccessTokenVerifier } from "./request-auth";
import {
  preparedJournal,
  preparedProviderFixture,
  sessionEnvelope,
} from "./handoff-provider-test-harness";

function handoffStore(): BuilderHandoffStore {
  const records = new Map<string, BuilderHandoffRecord>();
  const read: BuilderHandoffStore["read"] = async ({
    authority,
    handoffId,
  }) => {
    const record = records.get(handoffId);
    return record &&
      Object.entries(authority).every(
        ([key, value]) =>
          record.authority[key as keyof typeof authority] === value,
      )
      ? record
      : undefined;
  };
  return {
    read,
    async reserve(record) {
      const existing = [...records.values()].find(
        (candidate) =>
          candidate.creationRequestId === record.creationRequestId &&
          candidate.requestDigest === record.requestDigest,
      );
      if (existing) return { disposition: "existing", record: existing };
      records.set(record.handoffId, record);
      return { disposition: "created", record };
    },
    async bindSession(input) {
      const record = await read(input);
      if (
        !record ||
        record.requestDigest !== input.requestDigest ||
        input.now >= record.expiresAt
      )
        return undefined;
      if (record.sessionId) return record;
      const bound = {
        ...record,
        sessionId: input.sessionId,
        redeemedAt: input.now,
      };
      records.set(record.handoffId, bound);
      return bound;
    },
  };
}

async function callStart(
  handler: ReturnType<typeof createMcpRequestHandler>,
  token: string,
  handoffId: string,
) {
  const response = await handler(
    new Request(resource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "autograph_start",
          arguments: { handoffId, clientRequestId: randomUUID() },
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const result = JSON.parse(
    text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6) ?? text,
  );
  return result.result as {
    isError?: boolean;
    structuredContent: { sessionId: string };
  };
}

describe("web session to real OAuth to hosted MCP handoff", () => {
  it.each(["cursor", "codex"] as const)(
    "continues %s with the web owner, recovers across clients, and forwards durable handoff context",
    async (firstClient) => {
      const auth = await createRealOAuthHarness(
        ["workspace_1"],
        codexClientMetadata,
      );
      await registerTestCursorClient(auth);
      const browser = await auth.signIn();
      const browserSession = await auth.auth.api.getSession({
        headers: browser,
      });
      expect(browserSession).not.toBeNull();
      const authority = {
        issuer,
        audience: resource,
        workspaceId: "workspace_1",
        ownerUserId: browserSession!.user.id,
      };
      const provisioningRequestId = randomUUID();
      const journalRow = preparedJournal(authority, provisioningRequestId);
      const durableHandoffs = handoffStore();
      const handoffs = createBuilderHandoffService({ store: durableHandoffs });
      const providers = preparedProviderFixture({
        authority,
        handoffs: durableHandoffs,
        isActiveMember: async (owner) =>
          owner.ownerUserId === authority.ownerUserId &&
          auth.membershipState.activeWorkspaces.includes(owner.workspaceId),
      });
      const readPrepared = providers.createReader();
      const journalRead = vi.fn(
        async (value: { authority: typeof authority; requestId: string }) => {
          if (
            value.requestId !== provisioningRequestId ||
            Object.entries(authority).some(
              ([key, expected]) =>
                value.authority[key as keyof typeof authority] !== expected,
            )
          )
            return undefined;
          return structuredClone(journalRow);
        },
      );
      const route = createBuilderHandoffRouteHandler({
        origin,
        handoffs,
        journal: {
          read: journalRead,
          reserve: vi.fn(),
          compareAndSet: vi.fn(),
        },
        async authorityForRequest(request) {
          const session = await auth.auth.api.getSession({
            headers: request.headers,
          });
          if (!session) return undefined;
          const workspaces = auth.membershipState.activeWorkspaces;
          if (workspaces.length !== 1) return undefined;
          return {
            issuer,
            audience: resource,
            workspaceId: workspaces[0],
            ownerUserId: session.user.id,
          };
        },
      });
      const webHeaders = new Headers(browser);
      webHeaders.set("origin", origin);
      webHeaders.set("content-type", "application/json");
      const create = await route(
        new Request(`${origin}/api/builder/handoffs`, {
          method: "POST",
          headers: webHeaders,
          body: JSON.stringify({
            version: 1,
            creationRequestId: randomUUID(),
            provisioningRequestId,
            appName: "Vendor Review",
            repository: { name: "vendor-review", private: true },
            brief: "Review new vendors before activation.",
            modelId: "openai/gpt-5.6-terra",
            connections: ["Ramp"],
          }),
        }),
      );
      expect(create.status).toBe(200);
      const { handoffId } = (await create.json()) as { handoffId: string };
      expect(journalRead).toHaveBeenCalledWith({
        authority,
        requestId: provisioningRequestId,
      });
      const preparedRecord = await durableHandoffs.read({
        authority,
        handoffId,
      });
      expect(preparedRecord?.intent).toMatchObject({
        appName: journalRow.record.request.appName,
        repository: {
          requestedName: "prepared-vendor-review",
          resolvedFullName: "acme/prepared-vendor-review",
        },
        providers: journalRow.record.request.providers,
        provisioning: journalRow.record.response,
      });
      const clients = {
        cursor: { id: cursorClientId, redirectUri: cursorRedirectUri },
        codex: { id: codexClientId, redirectUri: codexRedirectUris[0] },
      };
      const first = await grantRealOAuth(
        auth,
        browser,
        clients[firstClient],
        previewOAuthScopes.join(" "),
      );
      const snapshot = {
        status: "waiting" as const,
        events: [
          { type: "assistant.message", index: 0, text: "Ready to continue." },
        ],
      };
      const observedContexts: Array<Awaited<ReturnType<typeof readPrepared>>> =
        [];
      const start = vi.fn<HostedEveTransport["start"]>(async (value) => {
        expect(value.sourceHandoffId).toBe(handoffId);
        observedContexts.push(
          await readPrepared(
            sessionEnvelope(value.principal, value.sourceHandoffId!),
          ),
        );
        return { adapterSessionId: "adapter-handoff", snapshot };
      });
      const store = new InMemoryHostedEveStore();
      const config = {
        issuer,
        audience: resource,
        resourceUrl: resource,
        jwksUrl: `${issuer}/jwks`,
        algorithm: "ES256" as const,
      };
      const jwksFetch = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe(config.jwksUrl);
        return auth.customFetchImpl(url, init);
      });
      const handler = createMcpRequestHandler({
        environment: { EVE_HOSTED_ADAPTER: "1" },
        hostedRuntime: {
          auth: config,
          verifier: createRemoteJwksAccessTokenVerifier({
            config,
            fetchImplementation: jwksFetch,
          }),
          membership: {
            isMember: async ({ workspaceId }) =>
              auth.membershipState.activeWorkspaces.includes(workspaceId),
          },
          store,
          transport: {
            start,
            get: async () => snapshot,
            send: vi.fn(),
            respond: vi.fn(),
            cancel: vi.fn(),
          },
          handoffs: {
            ...handoffs,
            recheckRepositoryAccess: async ({
              principal,
              repository,
              sourceHandoffId,
            }) => {
              expect(repository).toBe("acme/prepared-vendor-review");
              expect(sourceHandoffId).toBe(handoffId);
              const prepared = await readPrepared(
                sessionEnvelope(principal, sourceHandoffId!),
              );
              return prepared.status === "prepared" &&
                prepared.access.github.status === "ready"
                ? { status: "ready" as const }
                : { status: "provider-unavailable" as const };
            },
          },
        },
      });
      const result = await callStart(
        handler,
        first.tokens.access_token,
        handoffId,
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent.sessionId).toEqual(expect.any(String));
      expect(jwksFetch).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect(observedContexts[0]).toMatchObject({
        status: "prepared",
        app: {
          name: "Prepared Vendor Review",
          brief: "Review new vendors before activation.",
          connections: ["Ramp"],
        },
        resources: {
          github: {
            installationId: "10",
            repositoryId: "100",
            fullName: "acme/prepared-vendor-review",
          },
          vercel: {
            installationId: "icfg_prepared",
            projectId: "prj_prepared",
            scope: { id: "team_prepared" },
          },
        },
        access: {
          github: { status: "ready", scope: { installationId: "10" } },
          vercel: {
            status: "ready",
            project: { id: "prj_prepared", name: "observed-project-name" },
          },
        },
      });
      expect(providers.githubHttp).toHaveBeenCalled();
      expect(providers.vercelHttp).toHaveBeenCalled();
      expect(providers.credentialRead).toHaveBeenCalledWith({
        authority,
        installationId: "icfg_prepared",
      });
      expect(JSON.stringify(observedContexts)).not.toMatch(
        /mock_server|ghs_|privateIgnoredField|PRIVATE KEY/u,
      );
      expect(start.mock.calls[0][0]).toMatchObject({
        principal: {
          ownerUserId: first.claims.sub,
          workspaceId: "workspace_1",
        },
      });
      const refreshed = await refreshRealOAuth(
        auth,
        clients[firstClient].id,
        first.tokens.refresh_token,
      );
      const retry = await callStart(
        handler,
        refreshed.tokens.access_token,
        handoffId,
      );
      expect(retry.structuredContent.sessionId).toBe(
        result.structuredContent.sessionId,
      );
      const second = await grantRealOAuth(
        auth,
        browser,
        clients[firstClient === "cursor" ? "codex" : "cursor"],
        previewOAuthScopes.join(" "),
      );
      const switched = await callStart(
        handler,
        second.tokens.access_token,
        handoffId,
      );
      expect(switched.structuredContent.sessionId).toBe(
        result.structuredContent.sessionId,
      );
      expect(start).toHaveBeenCalledTimes(1);
      const strangerCredentials = {
        email: "other-owner@example.test",
        password: "other-owner-test-password",
      };
      await auth.auth.api.signUpEmail({
        body: { ...strangerCredentials, name: "Other owner" },
      });
      const strangerBrowser = await auth.signIn(strangerCredentials);
      const stranger = await grantRealOAuth(
        auth,
        strangerBrowser,
        clients[firstClient],
        previewOAuthScopes.join(" "),
      );
      expect(stranger.claims.sub).not.toBe(first.claims.sub);
      const denied = await callStart(
        handler,
        stranger.tokens.access_token,
        handoffId,
      );
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain(
        result.structuredContent.sessionId,
      );
      expect(start).toHaveBeenCalledTimes(1);
      // Requires the coordinator's sourceHandoffId implementation, intentionally
      // asserted on the transport, not merely on a model-visible prompt.
      expect(start.mock.calls[0][0]).toMatchObject({
        sourceHandoffId: handoffId,
      });
      const {principal} = start.mock.calls[0][0];
      expect(
        await store.getSession(principal, result.structuredContent.sessionId),
      ).toMatchObject({ sourceHandoffId: handoffId });
      const persisted = await store.getSession(
        principal,
        result.structuredContent.sessionId,
      );
      if (!persisted || persisted.version !== 2 || !persisted.sourceHandoffId)
        throw new Error("Durable prepared session missing.");
      const restartedAuth = sessionEnvelope(
        persisted.principal,
        persisted.sourceHandoffId,
      );
      providers.rotateCredentials();
      const credentialReadsBeforeRestart =
        providers.credentialRead.mock.calls.length;
      // A new reader uses only durable state and the saved verified principal.
      const restartedReader = providers.createReader();
      expect(await restartedReader(restartedAuth)).toEqual(observedContexts[0]);
      expect(providers.credentialRead.mock.calls.length).toBe(
        credentialReadsBeforeRestart + 1,
      );
      const foreignSession = sessionEnvelope(
        { ...principal, ownerUserId: String(stranger.claims.sub) },
        persisted.sourceHandoffId,
      );
      const providerCallsBeforeDenial =
        providers.githubHttp.mock.calls.length +
        providers.vercelHttp.mock.calls.length;
      await expect(restartedReader(foreignSession)).rejects.toThrow();
      auth.membershipState.activeWorkspaces = [];
      await expect(restartedReader(restartedAuth)).rejects.toThrow();
      expect(
        providers.githubHttp.mock.calls.length +
          providers.vercelHttp.mock.calls.length,
      ).toBe(providerCallsBeforeDenial);
      auth.membershipState.activeWorkspaces = ["workspace_1"];
      providers.setVercelStatus(503);
      const outage = await restartedReader(restartedAuth);
      expect(outage).toMatchObject({
        access: { vercel: { status: "provider-unavailable", retryable: true } },
        resources:
          observedContexts[0].status === "prepared"
            ? observedContexts[0].resources
            : {},
      });
      providers.setVercelStatus(401);
      expect(await restartedReader(restartedAuth)).toMatchObject({
        access: {
          vercel: {
            status: "authorization-required",
            reconnectUrl: `${origin}/vercel/installations?returnTo=%2Fhandoff%2F${handoffId}`,
          },
        },
      });
      providers.setVercelStatus(200);
      expect(await providers.createReader()(restartedAuth)).toEqual(
        observedContexts[0],
      );
    },
  );
});
