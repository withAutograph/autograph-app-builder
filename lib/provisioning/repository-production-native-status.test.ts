/* oxlint-disable eslint/require-await -- Controlled asynchronous read ports exercise real owner and HTTP boundaries. */
import { describe, expect, it, vi } from "vitest";
import { HostedOperatorError } from "./hosted-operator-contract";
import { createRepositoryProductionNativeStatus } from "./repository-production-native-status";
import {
  repositoryProductionExpectedMergeShaSchema,
  repositoryProductionNativeStatusSchema,
} from "./repository-production-native-status-contract";
import {
  createRepositoryProductionObservationResolver,
  readRepositoryProductionObservationSession,
} from "./repository-production-management-subject";
import type {
  ManagementProfile,
  RepositoryProductionObservationSession,
} from "./repository-production-management-subject";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type { ExistingRepositoryDestination } from "./builder-session-destination-contract";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "creator",
};
const principal = { ...authority, scopes: ["autograph:send"] };
const profile: ManagementProfile = {
  workspaceId: authority.workspaceId,
  repositoryId: "123",
  repositoryFullName: "example/apps",
  projectId: "app-project",
  publicOrigin: "https://apps.example",
  organization: { id: "org", name: "Dev" },
};
const ownerFor = (appId: string): RepositoryProductionRequestOwner => ({
  appId,
  sessionId: "original-session",
  ownerContext: {
    kind: "direct",
    authority,
    principal,
    sessionId: "original-session",
    adapterSessionId: "current-worker",
    adapterGeneration: 2,
  },
});
const destinationFor = (appId: string): ExistingRepositoryDestination => ({
  kind: "existing-repository",
  version: 1,
  appId,
  installationId: "456",
  confirmedByCallId: "selected-repository",
  repository: {
    repositoryId: profile.repositoryId,
    owner: "example",
    name: "apps",
    defaultBranch: "current-default",
  },
});
interface FixtureDomain {
  verified: boolean;
  gitBranch: string | null;
  redirect: string | null;
}
interface FixtureActivation {
  aliasAssigned?: boolean;
  aliasError?: { code: string; message: string } | null;
  source?: string;
  gitSource?: object;
  meta?: object;
}
interface FixtureProjectLink {
  type: string;
  org: string;
  repo: string;
  repoId: number;
  productionBranch: string;
}
type CanObserveSavedSetup = NonNullable<
  Parameters<typeof createRepositoryProductionObservationResolver>[0]["canObserveSavedSetup"]
>;
const fixture = (appId = "requests", canObserveSavedSetup?: CanObserveSavedSetup) => {
  const owner = ownerFor(appId);
  const scope: RepositoryProductionScope = {
    authority,
    appId,
    repositoryId: profile.repositoryId,
    repositoryFullName: profile.repositoryFullName,
    projectId: profile.projectId,
    organizationId: profile.organization.id,
    publicOrigin: profile.publicOrigin,
    environment: "production",
  };
  const session: RepositoryProductionObservationSession = {
    appId,
    adapterSessionId: "current-worker",
    adapterGeneration: 2,
    status: "working",
    cancellationRevision: 0,
    resumedCancellationRevision: 0,
    builderDestination: destinationFor(appId),
  };
  let row: RepositoryProductionRow | undefined;
  let denyOwner = false;
  const readSession = vi.fn(async () => {
    if (denyOwner) {
      throw new HostedOperatorError("authorization_required");
    }
    return structuredClone(session);
  });
  const store = { read: vi.fn(async () => row) };
  const resolve = createRepositoryProductionObservationResolver({
    repositories: [profile],
    readSession,
    store,
    canObserveSavedSetup,
  });
  let activeId = "provider-current";
  let readyState = "READY";
  let activation: FixtureActivation = {};
  let projectLink: FixtureProjectLink | undefined;
  let aliasDeploymentId: string | undefined;
  let aliasProjectId = profile.projectId;
  let registered = true;
  let routeStatus = 303;
  let routeOwner: string | null = appId;
  let location: string | undefined = "/auth/sign-in?callbackURL=%2Frequests";
  let domain: FixtureDomain = {
    verified: true,
    gitBranch: null,
    redirect: null,
  };
  let providerStatus = 200;
  const requests: { url: URL; initial?: RequestInit }[] = [];
  let duringRead: ((url: URL) => void) | undefined;
  const fetcher: typeof fetch = async (input, initial) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ url, initial });
    expect(initial?.method).toBe("GET");
    const headers = new Headers(initial?.headers);
    if (url.origin === "https://api.vercel.com") {
      expect(headers.get("authorization")).toBe("Bearer protected-provider-token");
      expect(url.searchParams.get("teamId")).toBe("team");
      expect(initial?.redirect).toBe("error");
      duringRead?.(url);
      if (providerStatus !== 200) {
        return Response.json({ private: "must never be returned" }, { status: providerStatus });
      }
      if (url.pathname === `/v9/projects/${profile.projectId}`) {
        return Response.json({
          id: profile.projectId,
          targets: { production: { id: activeId } },
          link: projectLink,
        });
      }
      if (url.pathname.endsWith("/domains/apps.example")) {
        return Response.json({ name: "apps.example", ...domain });
      }
      if (url.pathname === "/v4/aliases/apps.example") {
        return Response.json({
          alias: "apps.example",
          projectId: aliasProjectId,
          deploymentId: aliasDeploymentId ?? activeId,
        });
      }
      if (url.pathname.startsWith("/v13/deployments/")) {
        return Response.json({
          id: activeId,
          projectId: profile.projectId,
          target: "production",
          readyState,
          ...activation,
        });
      }
      throw new Error("Unexpected provider read");
    }
    expect(url.origin).toBe(profile.publicOrigin);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("x-vercel-trusted-oidc-idp-token")).toBe(false);
    expect(initial?.credentials).toBe("omit");
    expect(initial?.redirect).toBe("manual");
    duringRead?.(url);
    if (url.pathname === "/_platform/catalog") {
      return Response.json({
        applications: registered ? [{ id: appId, label: "App", basePath: `/${appId}` }] : [],
      });
    }
    expect(url.pathname).toBe(`/${appId}`);
    const responseHeaders = new Headers({
      "x-platform-route-origin": "https://private.services.vercel-infra.com",
      "content-type": "text/html",
    });
    if (routeOwner !== null) {
      responseHeaders.set("x-platform-route-application", routeOwner);
    }
    if (location !== undefined) {
      responseHeaders.set("location", location);
    }
    return new Response(null, { status: routeStatus, headers: responseHeaders });
  };
  const controller = new AbortController();
  const readCredential = vi.fn(async () => "protected-provider-token");
  const read = createRepositoryProductionNativeStatus({
    resolve,
    teamId: "team",
    readCredential,
    signal: controller.signal,
    fetch: fetcher,
    now: () => new Date("2026-11-10T15:30:00Z"),
  });
  return {
    owner,
    scope,
    session,
    store,
    readSession,
    readCredential,
    requests,
    controller,
    read,
    saved: (persistent = false, sessionId = owner.sessionId) => {
      const record = initialRepositoryProductionRecord(scope, {
        sessionId,
        sourceSha: "a".repeat(40),
        creatorRoles: [],
        entryPath: `/${appId}`,
        storage: persistent
          ? {
              kind: "postgres",
              releaseId: "prior-release",
              artifactRef: "absent-artifact",
              manifestSha256: "b".repeat(64),
              databaseEnvironment: "APP_DATABASE_URL",
            }
          : { kind: "none" },
      });
      record.ownerContext = { ...structuredClone(owner.ownerContext), sessionId };
      row = { operationRef: repositoryProductionOperationRef(scope), revision: 1, record };
      return row;
    },
    denyOwner: () => {
      denyOwner = true;
    },
    duringRead: (observe: (url: URL) => void) => {
      duringRead = observe;
    },
    changeActivation: () => {
      activeId = "another-provider-current";
    },
    setRegistered: (value: boolean) => {
      registered = value;
    },
    setRoute: (value: { status?: number; owner?: string | null; location?: string | null }) => {
      routeStatus = value.status ?? routeStatus;
      if ("owner" in value) {
        routeOwner = value.owner ?? null;
      }
      if ("location" in value) {
        location = value.location ?? undefined;
      }
    },
    setProviderStatus: (value: number) => {
      providerStatus = value;
    },
    setReadyState: (value: string) => {
      readyState = value;
    },
    setActivation: (value: FixtureActivation) => {
      activation = value;
    },
    setProjectLink: (value: FixtureProjectLink | undefined) => {
      projectLink = value;
    },
    setAlias: (value: { deploymentId?: string; projectId?: string }) => {
      aliasDeploymentId = value.deploymentId;
      aliasProjectId = value.projectId ?? profile.projectId;
    },
    setDomain: (value: Partial<FixtureDomain>) => {
      domain = { ...domain, ...value };
    },
  };
};

describe("read-only native Production observation", () => {
  it.each(["requests", "equipment-notes", "brand-new-calculator"])(
    "observes %s through its saved destination with no provisioning row or Build grant",
    async (appId) => {
      const f = fixture(appId);
      const result = await f.read(f.owner);
      expect(result).toMatchObject({
        status: "available",
        appId,
        deployment: { state: "active" },
        app: { state: "sign-in-required", url: `${profile.publicOrigin}/${appId}` },
        requestedRevision: "unassessed",
      });
      expect(JSON.stringify(result)).not.toMatch(
        /protected-provider-token|vercel-infra|must never be returned/u,
      );
      expect(f.requests.every(({ initial }) => initial?.method === "GET")).toBe(true);
    },
  );
  it("reads a retained persistent app without its old artifacts, setup approval or completed effects", async () => {
    const canObserveSavedSetup = vi.fn<CanObserveSavedSetup>().mockResolvedValue(false);
    const f = fixture("requests", canObserveSavedSetup);
    const row = f.saved(true);
    delete f.session.builderDestination;
    expect(row.record.approval).toBeUndefined();
    const result = await f.read(f.owner);
    expect(result.status).toBe("available");
    expect(canObserveSavedSetup).not.toHaveBeenCalled();
    expect(row.revision).toBe(1);
    expect(row.record.effects["allocate-storage"].state).toBe("idle");
  });
  it("observes an existing app from a fresh revision only through verified saved setup", async () => {
    const canObserveSavedSetup = vi.fn<CanObserveSavedSetup>().mockResolvedValue(true);
    const f = fixture("requests", canObserveSavedSetup);
    const row = f.saved(true, "prior-session");
    const before = structuredClone(row);
    // The authenticated revision proof can establish the exact repository when
    // a fresh session lacks an explicit saved destination.
    delete f.session.builderDestination;
    expect(await f.read(f.owner)).toMatchObject({
      status: "available",
      app: { state: "sign-in-required", url: "https://apps.example/requests" },
      requestedRevision: "unassessed",
    });
    expect(canObserveSavedSetup).toHaveBeenCalledWith(f.owner, f.scope, row);
    expect(row).toEqual(before);
    expect(f.requests.every(({ initial }) => initial?.method === "GET")).toBe(true);
  });
  it("does not disclose availability when another session's setup proof is unavailable", async () => {
    const f = fixture("requests", vi.fn<CanObserveSavedSetup>().mockResolvedValue(false));
    f.saved(true, "prior-session");
    await expect(f.read(f.owner)).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.readCredential).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });
  it("does not try cross-session setup proof for a different saved owner", async () => {
    const canObserveSavedSetup = vi.fn<CanObserveSavedSetup>().mockResolvedValue(true);
    const f = fixture("requests", canObserveSavedSetup);
    const row = f.saved(true, "prior-session");
    if (!row.record.ownerContext) {
      throw new Error("Missing fixture owner");
    }
    row.record.ownerContext.authority.ownerUserId = "another-owner";
    await expect(f.read(f.owner)).rejects.toMatchObject({ code: "authorization_required" });
    expect(canObserveSavedSetup).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });
  it("rechecks Stop after a pending cross-session setup read before provider access", async () => {
    const canObserveSavedSetup = vi.fn<CanObserveSavedSetup>();
    const f = fixture("requests", canObserveSavedSetup);
    f.saved(true, "prior-session");
    canObserveSavedSetup.mockImplementation(async () => {
      f.session.status = "cancelled";
      return true;
    });
    await expect(f.read(f.owner)).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.readCredential).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });
  it("returns a nonblocking managed service issue when no owned destination can be resolved", async () => {
    const f = fixture();
    delete f.session.builderDestination;
    expect(await f.read(f.owner)).toMatchObject({
      status: "service-unavailable",
      serviceIssue: "configuration",
    });
    expect(f.readCredential).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });
  it("keeps the revision unassessed for an independent availability read", async () => {
    const f = fixture();
    f.setRoute({ status: 200, location: null });
    expect(await f.read(f.owner)).toMatchObject({
      status: "available",
      app: { state: "responding" },
      requestedRevision: "unassessed",
    });
  });
  const mergeSha = "a".repeat(40);
  const priorSha = "b".repeat(40);
  const linkedRepository = {
    type: "github",
    org: "example",
    repo: "apps",
    repoId: 123,
    productionBranch: "main",
  };
  const currentGitSource = { type: "github", repoId: 123, ref: "main", sha: mergeSha };
  const nativeMetadata = {
    githubOrg: "example",
    githubRepo: "apps",
    githubCommitRef: "main",
    githubCommitSha: mergeSha,
  };

  it("waits for the squash merge SHA while an older app revision is available", async () => {
    const f = fixture();
    f.setProjectLink(linkedRepository);
    f.setActivation({ source: "git", gitSource: { ...currentGitSource, sha: priorSha } });
    expect(await f.read(f.owner, mergeSha)).toMatchObject({
      status: "available",
      app: { state: "sign-in-required", url: "https://apps.example/requests" },
      requestedRevision: "awaiting-activation",
    });
    f.changeActivation();
    f.setActivation({ source: "git", gitSource: currentGitSource });
    expect(await f.read(f.owner, mergeSha)).toMatchObject({
      status: "available",
      requestedRevision: "live",
    });
    expect(
      f.requests
        .filter(({ url }) => url.pathname.startsWith("/v13/deployments/"))
        .map(({ url }) => url.searchParams.get("withGitRepoInfo")),
    ).toEqual(["true", "true"]);
  });

  it("projects opted-in activation proof while the exact revision's app route is unavailable", async () => {
    const f = fixture();
    f.setProjectLink(linkedRepository);
    f.setActivation({ source: "git", gitSource: currentGitSource });
    f.setRoute({ status: 500 });
    const standard = await f.read(f.owner, mergeSha);
    const activation = await f.read(f.owner, mergeSha, true);
    expect(standard.deployment).toEqual({ state: "active" });
    expect(activation).toMatchObject({
      status: "service-unavailable",
      serviceIssue: "gateway-read",
      requestedRevision: "unassessed",
      deployment: { state: "active", requestedRevisionActive: true },
    });
    const withoutMerge = await f.read(f.owner, undefined, true);
    expect(withoutMerge.deployment.requestedRevisionActive).toBeUndefined();
  });

  it("verifies reduced Vercel Git provenance against the linked repository", async () => {
    const f = fixture();
    f.setProjectLink(linkedRepository);
    f.setActivation({ source: "git", meta: nativeMetadata });
    expect(await f.read(f.owner, mergeSha)).toMatchObject({
      status: "available",
      requestedRevision: "live",
    });
    f.setProjectLink(undefined);
    expect(await f.read(f.owner, mergeSha)).toMatchObject({
      status: "available",
      requestedRevision: "awaiting-activation",
    });
  });

  it.each([
    { source: "cli", gitSource: currentGitSource, meta: nativeMetadata },
    { source: "git", gitSource: { ...currentGitSource, repoId: 456 }, meta: nativeMetadata },
    {
      source: "git",
      gitSource: currentGitSource,
      meta: { ...nativeMetadata, githubCommitSha: priorSha },
    },
    { source: "git", meta: { ...nativeMetadata, githubRepo: "another-app" } },
    { source: "git", meta: { ...nativeMetadata, githubCommitRef: "feature" } },
  ])(
    "preserves the open app without confirming incompatible provenance: %j",
    async (activation) => {
      const f = fixture();
      f.setProjectLink(linkedRepository);
      f.setActivation(activation);
      const result = await f.read(f.owner, mergeSha, true);
      expect(result).toMatchObject({
        status: "available",
        requestedRevision: "awaiting-activation",
      });
      expect(result.deployment.requestedRevisionActive).toBeUndefined();
    },
  );

  it("waits for the canonical alias and owned app route before confirming the exact revision", async () => {
    const f = fixture();
    f.setProjectLink(linkedRepository);
    f.setActivation({ source: "git", gitSource: currentGitSource, aliasAssigned: false });
    f.setAlias({ deploymentId: "previous-production" });
    const awaitingAlias = await f.read(f.owner, mergeSha, true);
    expect(awaitingAlias).toMatchObject({
      status: "pending",
      requestedRevision: "awaiting-activation",
    });
    expect(awaitingAlias.deployment.requestedRevisionActive).toBeUndefined();
    f.setAlias({});
    f.setRegistered(false);
    expect(await f.read(f.owner, mergeSha, true)).toMatchObject({
      status: "pending",
      requestedRevision: "awaiting-activation",
      deployment: { state: "active", requestedRevisionActive: true },
    });
    f.setRegistered(true);
    f.duringRead((url) => {
      if (url.pathname === "/_platform/catalog") {
        f.changeActivation();
      }
    });
    const movedAlias = await f.read(f.owner, mergeSha, true);
    expect(movedAlias).toMatchObject({
      status: "pending",
      requestedRevision: "awaiting-activation",
    });
    expect(movedAlias.deployment.requestedRevisionActive).toBeUndefined();
  });

  it("does not confirm reduced metadata after the project link changes during the public read", async () => {
    const f = fixture();
    f.setProjectLink(linkedRepository);
    f.setActivation({ source: "git", meta: nativeMetadata });
    f.duringRead((url) => {
      if (url.pathname === "/_platform/catalog") {
        f.setProjectLink({ ...linkedRepository, repoId: 456 });
      }
    });
    const movedLink = await f.read(f.owner, mergeSha, true);
    expect(movedLink).toMatchObject({
      status: "available",
      requestedRevision: "awaiting-activation",
    });
    expect(movedLink.deployment.requestedRevisionActive).toBeUndefined();
  });

  it("rejects a live revision without a verified available app", async () => {
    const f = fixture();
    f.setProjectLink(linkedRepository);
    f.setActivation({ source: "git", gitSource: currentGitSource });
    const live = await f.read(f.owner, mergeSha);
    expect(live.requestedRevision).toBe("live");
    expect(
      repositoryProductionNativeStatusSchema.safeParse({ ...live, status: "pending" }).success,
    ).toBe(false);
    expect(
      repositoryProductionNativeStatusSchema.safeParse({
        ...live,
        app: { state: "registered", url: live.app.url },
      }).success,
    ).toBe(false);
  });

  it("rejects proof on a deployment that was not observed active", async () => {
    const f = fixture();
    const result = await f.read(f.owner);
    expect(
      repositoryProductionNativeStatusSchema.safeParse({
        ...result,
        deployment: { state: "not-observed", requestedRevisionActive: true },
      }).success,
    ).toBe(false);
  });

  it("accepts exact Git object IDs only", () => {
    expect(repositoryProductionExpectedMergeShaSchema.safeParse(mergeSha).success).toBe(true);
    expect(repositoryProductionExpectedMergeShaSchema.safeParse("b".repeat(64)).success).toBe(true);
    expect(repositoryProductionExpectedMergeShaSchema.safeParse("a".repeat(39)).success).toBe(
      false,
    );
    expect(repositoryProductionExpectedMergeShaSchema.safeParse("A".repeat(40)).success).toBe(
      false,
    );
  });
  it("keeps an app missing from the active catalog pending without guessing a URL", async () => {
    const f = fixture();
    f.setRegistered(false);
    const result = await f.read(f.owner);
    expect(result).toMatchObject({
      status: "pending",
      app: { state: "not-observed" },
    });
    expect(result.app.url).toBeUndefined();
  });
  it.each([null, "https://other.example/sign-in", "/requests-sibling"])(
    "retains the app URL when an owned response redirects outside the app or lacks Location %s",
    async (location) => {
      const f = fixture();
      f.setRoute({ location });
      expect(await f.read(f.owner)).toMatchObject({
        status: "service-unavailable",
        serviceIssue: "gateway-read",
        app: { state: "registered", url: "https://apps.example/requests" },
      });
    },
  );
  it("recognizes an owned redirect within the app base path", async () => {
    const f = fixture();
    f.setRoute({ location: "/requests/notes" });
    expect(await f.read(f.owner)).toMatchObject({
      status: "available",
      app: { state: "responding", url: "https://apps.example/requests" },
    });
  });
  it.each([null, "another-app"])(
    "retains the known app URL when the document ownership receipt is %s",
    async (owner) => {
      const f = fixture();
      f.setRoute({ status: 200, owner });
      expect(await f.read(f.owner)).toMatchObject({
        status: "service-unavailable",
        serviceIssue: "gateway-read",
        app: { state: "registered", url: "https://apps.example/requests" },
      });
    },
  );
  it("keeps an existing safe destination link when the provider refuses observation", async () => {
    const f = fixture();
    f.saved();
    f.setProviderStatus(403);
    expect(await f.read(f.owner)).toMatchObject({
      status: "service-unavailable",
      serviceIssue: "provider-access",
      app: { url: "https://apps.example/requests" },
    });
  });
  it.each([
    { readyState: "QUEUED", activation: {} },
    { readyState: "INITIALIZING", activation: {} },
    { readyState: "BUILDING", activation: {} },
    { readyState: "READY", activation: { aliasAssigned: false, aliasError: null } },
  ])(
    "waits while the selected Production deployment is $readyState and the alias still serves the previous deployment",
    async ({ readyState, activation }) => {
      const f = fixture();
      f.saved();
      f.setReadyState(readyState);
      f.setActivation(activation);
      f.setAlias({ deploymentId: "previous-production" });
      const pending = await f.read(f.owner);
      expect(pending).toMatchObject({
        status: "pending",
        deployment: { state: "not-observed" },
        app: { state: "not-observed" },
      });
      expect(pending.app.url).toBeUndefined();
      expect(pending.serviceIssue).toBeUndefined();

      f.setAlias({});
      f.setReadyState("READY");
      f.setActivation({ aliasAssigned: true, aliasError: null });
      expect(await f.read(f.owner)).toMatchObject({
        status: "available",
        deployment: { state: "active" },
        app: { state: "sign-in-required", url: "https://apps.example/requests" },
      });
    },
  );
  it.each([
    { readyState: "BUILDING", projectId: "another-project", activation: {} },
    { readyState: "READY", activation: {} },
    { readyState: "READY", activation: { aliasAssigned: true, aliasError: null } },
    {
      readyState: "READY",
      activation: {
        aliasAssigned: false,
        aliasError: { code: "alias_failed", message: "Assignment failed" },
      },
    },
    { readyState: "ERROR", activation: { aliasAssigned: false, aliasError: null } },
  ])(
    "keeps an invalid alias binding actionable: %j",
    async ({ readyState, projectId, activation }) => {
      const f = fixture();
      f.setReadyState(readyState);
      f.setActivation(activation);
      f.setAlias({ deploymentId: "previous-production", projectId });
      expect(await f.read(f.owner)).toMatchObject({
        status: "service-unavailable",
        serviceIssue: "domain-binding",
      });
    },
  );
  it.each([
    { verified: false },
    { gitBranch: "a-preview-branch" },
    { redirect: "https://other.example" },
  ])("does not describe an incompatible Production domain as active: %j", async (domain) => {
    const f = fixture();
    f.setReadyState("BUILDING");
    f.setAlias({ deploymentId: "previous-production" });
    f.setDomain(domain);
    expect(await f.read(f.owner)).toMatchObject({
      status: "service-unavailable",
      serviceIssue: "domain-binding",
    });
  });
  it("reports a real selected deployment failure separately from a pending activation", async () => {
    const f = fixture();
    f.setReadyState("ERROR");
    expect(await f.read(f.owner)).toMatchObject({
      status: "service-unavailable",
      deployment: { state: "service-unavailable" },
    });
  });
  it("does not elect another deployment if activation changes while the public app is read", async () => {
    const f = fixture();
    f.duringRead((url) => {
      if (url.pathname === "/_platform/catalog") {
        f.changeActivation();
      }
    });
    expect(await f.read(f.owner)).toMatchObject({
      status: "pending",
      deployment: { state: "not-observed" },
    });
  });
  it("keeps an actual app failure actionable without removing its safe URL", async () => {
    const f = fixture();
    f.setRoute({ status: 500 });
    expect(await f.read(f.owner)).toMatchObject({
      status: "service-unavailable",
      serviceIssue: "gateway-read",
      app: { url: "https://apps.example/requests" },
    });
  });
  it.each(["provider", "public"])("preserves owner denial during the %s read", async (phase) => {
    const f = fixture();
    f.duringRead((url) => {
      if ((url.origin === "https://api.vercel.com") === (phase === "provider")) {
        f.denyOwner();
      }
    });
    await expect(f.read(f.owner)).rejects.toMatchObject({ code: "authorization_required" });
  });
  it.each(["adapter", "generation", "stop", "repository"])(
    "rejects a changed owner %s across reads",
    async (dimension) => {
      const f = fixture();
      f.duringRead(() => {
        if (dimension === "adapter") {
          f.session.adapterSessionId = "another-worker";
        }
        if (dimension === "generation") {
          f.session.adapterGeneration += 1;
        }
        if (dimension === "stop") {
          f.session.cancellationRevision = 1;
        }
        if (dimension === "repository") {
          f.session.builderDestination = {
            ...destinationFor(f.owner.appId),
            repository: { ...destinationFor(f.owner.appId).repository, repositoryId: "789" },
          };
        }
      });
      await expect(f.read(f.owner)).rejects.toMatchObject({ code: "authorization_required" });
    },
  );
  it("honors Stop before any provider read and cancellation during a read", async () => {
    const f = fixture();
    f.session.status = "cancelled";
    await expect(f.read(f.owner)).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.requests).toEqual([]);
    f.session.status = "working";
    f.duringRead(() => {
      f.controller.abort(new Error("Stopped"));
    });
    await expect(f.read(f.owner)).rejects.toThrow("Stopped");
  });
  it.each([
    "https://user:password@apps.example/requests",
    "https://private.services.vercel-infra.com/requests",
  ])("rejects credential-bearing or private URL output %s", (url) => {
    expect(
      repositoryProductionNativeStatusSchema.safeParse({
        version: 1,
        appId: "requests",
        observedAt: new Date().toISOString(),
        status: "pending",
        deployment: { state: "not-observed" },
        app: { state: "registered", url },
        requestedRevision: "unassessed",
      }).success,
    ).toBe(false);
  });
});

describe("current physical observation authority", () => {
  const sourceHandoffId = "ba08a0fe-7f70-4a99-91d6-f410d8b5d919";
  const handoffOwner = (
    owner: RepositoryProductionRequestOwner,
  ): RepositoryProductionRequestOwner => ({
    ...owner,
    ownerContext: { ...owner.ownerContext, kind: "handoff", sourceHandoffId },
  });
  it("rejects an explicit app that differs from the verified owner even when both records agree", async () => {
    const f = fixture();
    const wrongApp = { ...f.session, appId: "other-app", principal, sourceHandoffId };
    await expect(
      readRepositoryProductionObservationSession(handoffOwner(f.owner), {
        readCanonical: async () => wrongApp,
        readCurrent: async () => wrongApp,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });

  it("accepts equivalent scope sets while refusing a different current principal", async () => {
    const f = fixture();
    const canonical = {
      ...f.session,
      principal: { ...principal, scopes: ["autograph:send", "autograph:get"] },
    };
    const current = {
      ...canonical,
      principal: { ...principal, scopes: ["autograph:get", "autograph:send", "autograph:get"] },
    };
    await expect(
      readRepositoryProductionObservationSession(f.owner, {
        readCanonical: async () => canonical,
        readCurrent: async () => current,
      }),
    ).resolves.toMatchObject({ appId: f.owner.appId });
    current.principal.ownerUserId = "someone-else";
    await expect(
      readRepositoryProductionObservationSession(f.owner, {
        readCanonical: async () => canonical,
        readCurrent: async () => current,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });
  it("uses the physical Stop revision instead of the original recovered projection", async () => {
    const f = fixture();
    const canonical = {
      ...f.session,
      principal,
      cancellationRevision: 0,
      resumedCancellationRevision: 0,
      nativeRecoveryBinding: { logicalSessionId: "logical-session" },
    };
    const readCurrent = vi.fn(async () => ({
      ...canonical,
      cancellationRevision: 1,
      resumedCancellationRevision: 1,
    }));
    expect(
      await readRepositoryProductionObservationSession(f.owner, {
        readCanonical: async () => canonical,
        readCurrent,
      }),
    ).toMatchObject({ cancellationRevision: 1, resumedCancellationRevision: 1 });
    expect(readCurrent).toHaveBeenCalledWith(f.owner, "logical-session");
  });
  it("rejects an original direct Stop", async () => {
    const f = fixture();
    const canonical = { ...f.session, principal };
    const stopped = { ...canonical, status: "cancelled" as const, cancellationRevision: 1 };
    await expect(
      readRepositoryProductionObservationSession(f.owner, {
        readCanonical: async () => canonical,
        readCurrent: async () => stopped,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });
  it("fills a missing legacy app ID from the canonically verified handoff owner", async () => {
    const f = fixture();
    const canonical = { ...f.session, principal, sourceHandoffId };
    delete canonical.appId;
    expect(
      await readRepositoryProductionObservationSession(handoffOwner(f.owner), {
        readCanonical: async () => canonical,
        readCurrent: async () => canonical,
      }),
    ).toMatchObject({ appId: f.owner.appId });
  });
});
