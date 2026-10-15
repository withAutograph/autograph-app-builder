import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EveSessionService } from "../eve/service";
import { createDeploymentPrototypePreviewRequestHandler } from "./browser-preview-deployment";
import { hostedPrincipalSchema, tenantKeyFor } from "../eve/hosted-auth";
import { durableHostedSessionRecordSchema, InMemoryHostedEveStore } from "../eve/hosted-store";
import type { HostedEveStore, HostedPagedCheckpointMetadata } from "../eve/hosted-store";
import { HostedAdapterSessionUnavailableError } from "../eve/hosted-service";
import type { HostedEveTransport } from "../eve/hosted-service";
import type { getPrototypeChunk, PrototypeChunkKey } from "../agent/postgres-prototype-chunks";
import type { ResumeRealmContinuation } from "./realm-continuation-read";

const providers = vi.hoisted(() => ({
  auth: vi.fn(),
  chunks: vi.fn(),
  store: vi.fn(),
  transport: vi.fn(),
  workspace: vi.fn(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Authentication session read is an external authority boundary.
vi.mock("../auth/preview-oauth-deployment", () => ({
  getPreviewOAuthDeploymentAuth: () => ({ api: { getSession: providers.auth } }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Active organization membership is the external database authority boundary.
vi.mock("../auth/postgres-organization-user-authority", () => ({
  createPostgresPreviewOrganizationAuthority: () => ({
    activeWorkspaceForUser: providers.workspace,
  }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Runtime configuration is fixture-owned; no real credentials are read.
vi.mock("../auth/preview-oauth-runtime", () => ({
  readPreviewOAuthRuntimeConfig: () => ({
    databaseUrl: "postgresql://fixture@example.invalid/test",
    issuer: "https://builder.example.test/api/auth",
    resource: "https://builder.example.test/mcp",
  }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Prevent opening external PostgreSQL connections.
vi.mock("./hosted-route", () => ({ openHostedPostgresDatabase: () => ({}) }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Substitute only the external storage implementation; real hosted service and tenant checks remain active.
vi.mock("../eve/postgres-hosted-store", () => ({ createPostgresHostedEveStore: providers.store }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Eve HTTP transport is an external boundary; no provider requests are dispatched.
vi.mock("../eve/same-origin-http", () => ({ createSameOriginEveTransport: providers.transport }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Chunk storage is external; the real immutable manifest verifier remains active.
vi.mock("../agent/postgres-prototype-chunks", () => ({ getPrototypeChunk: providers.chunks }));

const content = "<!doctype html><html><body>Vendor queue</body></html>";
const digest = createHash("sha256").update(content).digest("hex");

const owner = hostedPrincipalSchema.parse({
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "owner",
  scopes: ["autograph:get", "autograph:session"],
  workspaceId: "workspace",
});
const ownedFixture = (
  options: {
    current?: string;
    origin?: string;
    artifactSessionId?: string;
    missingManifest?: boolean;
    lostAdapter?: boolean;
    resumeRealmContinuation?: ResumeRealmContinuation;
  } = {},
) => {
  const publicId = "ses_public";
  const current = options.current ?? "wrun_current";
  const origin = options.origin ?? current;
  const artifact = {
    appId: "vendor-onboarding",
    chunkCount: 2,
    contentBytes: Buffer.byteLength(content),
    digest,
    mediaType: "text/html" as const,
    path: "prototype/vendor-onboarding/index.html",
    recordedByCallId: "call-one",
    revision: createHash("sha256")
      .update(
        JSON.stringify({
          digest,
          mediaType: "text/html",
          path: "prototype/vendor-onboarding/index.html",
        }),
      )
      .digest("hex"),
    sessionId: options.artifactSessionId ?? current,
    version: 2 as const,
  };
  const record = durableHostedSessionRecordSchema.parse({
    adapterGeneration: origin === current ? 1 : 2,
    adapterSessionId: current,
    checkpointDigest: `sha256:${"c".repeat(64)}`,
    checkpointProgressDigest: `sha256:${"d".repeat(64)}`,
    checkpointRef: {
      digest: `sha256:${"c".repeat(64)}`,
      eventCount: 0,
      id: "00000000-0000-4000-8000-000000000001",
    },
    createdAtEpochMs: 1000,
    lastProgressAtEpochMs: 1000,
    originAdapterSessionId: origin,
    parentSessionId: "ses_parent",
    principal: owner,
    resumability: "terminal",
    sessionId: publicId,
    stage: "complete",
    status: "completed",
    title: "Vendor queue",
    updatedAtEpochMs: 1000,
    version: 2,
  });
  const metadata: HostedPagedCheckpointMetadata = {
    capturedAtEpochMs: 1000,
    status: "completed",
    version: 1,
  };
  if (options.missingManifest !== true) {
    metadata.prototypeRef = artifact;
  }
  const store = new InMemoryHostedEveStore();
  const getSession = vi.fn<HostedEveStore["getSession"]>(
    async (principal, sessionId) =>
      await Promise.resolve(
        tenantKeyFor(principal) === tenantKeyFor(owner) && sessionId === publicId ? record : null,
      ),
  );
  const readCheckpointPage = vi.fn<NonNullable<HostedEveStore["readCheckpointPage"]>>(
    async (input) => {
      if (tenantKeyFor(input.principal) !== tenantKeyFor(owner) || input.sessionId !== publicId) {
        throw new Error("Denied checkpoint");
      }
      return await Promise.resolve({
        checkpointDigest: record.checkpointDigest ?? "",
        cursor: 0,
        events: [],
        metadata,
        totalEvents: 0,
      });
    },
  );
  const ownedStore = Object.assign(store, {
    getSession,
    observeSessionPaged: vi.fn<NonNullable<HostedEveStore["observeSessionPaged"]>>(
      async () => await Promise.resolve(record),
    ),
    readCheckpointPage,
  });
  const observe = vi.fn<NonNullable<HostedEveTransport["observe"]>>(async () => {
    if (options.lostAdapter === true) {
      throw new HostedAdapterSessionUnavailableError();
    }
    return await Promise.resolve({
      artifactProjectionRequiresLegacyReadback: false,
      installedEventCount: 0,
      pendingRequests: [],
      prototypeRef: metadata.prototypeRef,
      publicEventCount: 0,
      status: "completed" as const,
    });
  });
  providers.store.mockReturnValue(ownedStore);
  providers.transport.mockReturnValue({ observe });
  providers.auth.mockResolvedValue({ user: { id: owner.ownerUserId } });
  providers.workspace.mockResolvedValue(owner.workspaceId);
  const chunks = [content.slice(0, 19), content.slice(19)];
  providers.chunks.mockImplementation(
    async (_db: Parameters<typeof getPrototypeChunk>[0], key: PrototypeChunkKey) => {
      const matches =
        tenantKeyFor(key.principal) === tenantKeyFor(owner) &&
        key.sessionId === artifact.sessionId &&
        key.path === artifact.path &&
        key.transferDigest === artifact.digest;
      return await Promise.resolve(matches ? chunks[key.chunkIndex] : undefined);
    },
  );
  const handler = createDeploymentPrototypePreviewRequestHandler({
    environment: { EVE_HOSTED_ADAPTER: "1" },
    resumeRealmContinuation: options.resumeRealmContinuation,
    workloadIdentity: {
      async token() {
        await Promise.resolve();
        throw new Error("No provider identity in fixture");
      },
    },
  });
  const request = new Request(`https://builder.example.test/preview/${publicId}/${digest}`, {
    headers: { cookie: "fixture-session=owner" },
  });
  return { artifact, getSession, handler, observe, publicId, readCheckpointPage, record, request };
};

describe("deployment Browser preview route", () => {
  beforeEach(() => {
    for (const mock of Object.values(providers)) {
      mock.mockReset();
    }
  });
  it("recovers the exact authenticated saved build before reading its artifact", async () => {
    const resume = vi.fn<ResumeRealmContinuation>().mockImplementation(() => Promise.resolve());
    const fixture = ownedFixture({ resumeRealmContinuation: resume });
    const response = await fixture.handler(fixture.request, {
      digest,
      sessionId: fixture.publicId,
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({
      principal: owner,
      sessionId: fixture.publicId,
      adapterSessionId: fixture.record.adapterSessionId,
      environment: { EVE_HOSTED_ADAPTER: "1" },
    });
  });

  it("does not recover another account's saved build", async () => {
    const resume = vi.fn<ResumeRealmContinuation>().mockImplementation(() => Promise.resolve());
    const fixture = ownedFixture({ resumeRealmContinuation: resume });
    providers.auth.mockResolvedValue({ user: { id: "other-owner" } });
    const response = await fixture.handler(fixture.request, {
      digest,
      sessionId: fixture.publicId,
    });
    expect(response.status).toBe(404);
    expect(resume).not.toHaveBeenCalled();
  });
  it("serves the exact artifact selected by the request-scoped service", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const get = vi.fn(async () => ({
      cursor: 1,
      events: [],
      prototype: {
        content,
        digest,
        mediaType: "text/html" as const,
        path: "prototype/vendor-onboarding/index.html",
        revision: "b".repeat(64),
      },
      sessionId: "session-one",
      status: "completed" as const,
    }));
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const serviceForRequest = vi.fn(async () => ({ get }) as unknown as EveSessionService);
    const handler = createDeploymentPrototypePreviewRequestHandler({
      environment: {},
      serviceForRequest,
      workloadIdentity: {
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async token() {
          throw new Error("Hosted workload identity must not be requested.");
        },
      },
    });
    const request = new Request(`https://builder.example.test/preview/session-one/${digest}`);
    const response = await handler(request, {
      digest,
      sessionId: "session-one",
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content);
    expect(serviceForRequest).toHaveBeenCalledWith(request);
    expect(get).toHaveBeenCalledWith({
      cursor: 0,
      limit: 1,
      sessionId: "session-one",
    });
  });

  it("fails closed when no request-scoped service is available", async () => {
    const handler = createDeploymentPrototypePreviewRequestHandler({
      environment: {},
      workloadIdentity: {
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async token() {
          throw new Error("Hosted workload identity must not be requested.");
        },
      },
    });
    const response = await handler(
      new Request(`https://builder.example.test/preview/session-one/${digest}`),
      { digest, sessionId: "session-one" },
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each(["different", "same", "origin"])(
    "streams a signed-in owned %s session binding without rewriting its native manifest",
    async (kind) => {
      let f = ownedFixture();
      if (kind === "same") {
        f = ownedFixture({ current: "ses_public" });
      }
      if (kind === "origin") {
        f = ownedFixture({
          artifactSessionId: "wrun_origin",
          lostAdapter: true,
          origin: "wrun_origin",
        });
      }
      const original = JSON.stringify(f.artifact);
      const response = await f.handler(f.request, { digest, sessionId: f.publicId });
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(content);
      expect(JSON.stringify(f.artifact)).toBe(original);
      expect(providers.auth).toHaveBeenCalled();
      expect(providers.workspace).toHaveBeenCalledWith({
        audience: owner.audience,
        issuer: owner.issuer,
        ownerUserId: owner.ownerUserId,
      });
      expect(f.getSession).toHaveBeenCalledWith(owner, f.publicId);
      expect(providers.chunks).toHaveBeenCalledTimes(4);
      for (const [, key] of providers.chunks.mock.calls) {
        expect(key).toMatchObject({
          path: f.artifact.path,
          principal: owner,
          sessionId: f.artifact.sessionId,
          transferDigest: digest,
        });
      }
    },
  );

  it.each(["auth", "membership", "owner", "workspace", "origin"])(
    "denies %s without reading prototype chunks",
    async (kind) => {
      const f = ownedFixture();
      if (kind === "auth") {
        providers.auth.mockResolvedValue(null);
      }
      if (kind === "membership") {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The membership authority returns undefined when no active membership exists.
        providers.workspace.mockResolvedValue(undefined);
      }
      if (kind === "owner") {
        providers.auth.mockResolvedValue({ user: { id: "other-owner" } });
      }
      if (kind === "workspace") {
        providers.workspace.mockResolvedValue("other-workspace");
      }
      const request =
        kind === "origin"
          ? new Request(`https://other.example.test/preview/${f.publicId}/${digest}`)
          : f.request;
      const response = await f.handler(request, { digest, sessionId: f.publicId });
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("");
      expect(providers.chunks).not.toHaveBeenCalled();
    },
  );

  it.each(["wrun_other", "ses_parent"])(
    "refuses unrelated native or parent identity %s on an otherwise owned record",
    async (artifactSessionId) => {
      const f = ownedFixture({ artifactSessionId });
      const response = await f.handler(f.request, { digest, sessionId: f.publicId });
      expect(response.status).toBe(404);
      expect(providers.chunks).not.toHaveBeenCalled();
    },
  );

  it.each(["manifest", "chunk", "digest"])(
    "preserves %s failure denial before HTML is served",
    async (kind) => {
      const f = ownedFixture({ missingManifest: kind === "manifest" });
      if (kind === "chunk") {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing chunks use the storage API undefined result.
        providers.chunks.mockResolvedValue(undefined);
      }
      if (kind === "digest") {
        providers.chunks.mockResolvedValue("tampered");
      }
      const response = await f.handler(f.request, { digest, sessionId: f.publicId });
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("");
    },
  );
});
