import { beforeEach, expect, it, vi } from "vitest";
import { loadBuilderIntegrationState } from "./builder-integration-deployment";

const stores = vi.hoisted(() => ({
  listGitHub: vi.fn(),
  listVercel: vi.fn(),
  readGitHub: vi.fn(),
}));
vi.mock("../mcp/hosted-route", () => ({ openHostedPostgresDatabase: () => ({}) }));
vi.mock("../auth/github-app-installation", () => ({
  readGitHubAppInstallationEnvironment: vi.fn(),
}));
vi.mock("../auth/preview-oauth-runtime", () => ({
  readPreviewOAuthRuntimeConfig: () => ({
    databaseUrl: "postgres://test",
    issuer: "issuer",
    resource: "audience",
  }),
}));
vi.mock("../repository/postgres-github-installation-store", () => ({
  createPostgresHostedGitHubInstallationStore: () => ({
    list: stores.listGitHub,
    read: stores.readGitHub,
  }),
  mergeHostedGitHubInstallationBindings: (bindings: unknown[]) => bindings,
}));
vi.mock("./postgres-vercel-installation", () => ({
  createPostgresVercelInstallationStore: () => ({ list: stores.listVercel }),
}));
vi.mock("./vercel-installation", () => ({ readVercelIntegrationEnvironment: () => ({}) }));
vi.mock("./local-provider-emulation", () => ({
  providerEmulationEnvironment: (value: unknown) => value,
}));

const request = {
  authenticated: true as const,
  environment: {},
  organizationId: "org",
  userId: "user",
  workspaceId: "workspace",
};
// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
const models = async () => ({ cached: false, entries: [], status: "unavailable" as const });

beforeEach(() => {
  vi.resetAllMocks();
  stores.listGitHub.mockResolvedValue([]);
  stores.readGitHub.mockResolvedValue(null);
  stores.listVercel.mockResolvedValue([]);
});

it("starts independent reads before either provider settles and passes the same tenant authority", async () => {
  const pending = Promise.withResolvers<never[]>();
  stores.listGitHub.mockReturnValue(pending.promise);
  const result = loadBuilderIntegrationState(request, models);
  expect(stores.readGitHub).toHaveBeenCalledOnce();
  expect(stores.listVercel).toHaveBeenCalledOnce();
  const authority = {
    audience: "audience",
    issuer: "issuer",
    ownerUserId: "user",
    workspaceId: "workspace",
  };
  expect(stores.listGitHub).toHaveBeenCalledWith(authority);
  expect(stores.readGitHub).toHaveBeenCalledWith(authority);
  expect(stores.listVercel).toHaveBeenCalledWith(authority);
  pending.resolve([]);
  expect(await result).toMatchObject({
    github: { status: "disconnected" },
    vercel: { status: "disconnected" },
  });
});

it("isolates provider failure without skipping the other provider", async () => {
  stores.listGitHub.mockRejectedValue(new Error("offline"));
  expect(await loadBuilderIntegrationState(request, models)).toMatchObject({
    github: { status: "unavailable" },
    vercel: { status: "disconnected" },
  });
});

it("does not read provider stores for an anonymous visitor", async () => {
  await loadBuilderIntegrationState({ authenticated: false, environment: {} }, models);
  expect(stores.listGitHub).not.toHaveBeenCalled();
  expect(stores.listVercel).not.toHaveBeenCalled();
});
