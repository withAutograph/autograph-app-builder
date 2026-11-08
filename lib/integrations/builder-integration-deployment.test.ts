import { beforeEach, expect, it, vi } from "vitest";
import { loadBuilderIntegrationState } from "./builder-integration-deployment";

const stores = vi.hoisted(() => ({
  listGitHub: vi.fn(),
  listVercel: vi.fn(),
  readGitHub: vi.fn(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../mcp/hosted-route dependency used by this test.
vi.mock("../mcp/hosted-route", () => ({ openHostedPostgresDatabase: () => ({}) }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../auth/github-app-installation dependency used by this test.
vi.mock("../auth/github-app-installation", () => ({
  readGitHubAppInstallationEnvironment: vi.fn(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../auth/preview-oauth-runtime dependency used by this test.
vi.mock("../auth/preview-oauth-runtime", () => ({
  readPreviewOAuthRuntimeConfig: () => ({
    databaseUrl: "postgres://test",
    issuer: "issuer",
    resource: "audience",
  }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../repository/postgres-github-installation-store dependency used by this test.
vi.mock("../repository/postgres-github-installation-store", () => ({
  createPostgresHostedGitHubInstallationStore: () => ({
    list: stores.listGitHub,
    read: stores.readGitHub,
  }),
  mergeHostedGitHubInstallationBindings: (bindings: unknown[]) => bindings,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./postgres-vercel-installation dependency used by this test.
vi.mock("./postgres-vercel-installation", () => ({
  createPostgresVercelInstallationStore: () => ({ list: stores.listVercel }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./vercel-installation dependency used by this test.
vi.mock("./vercel-installation", () => ({ readVercelIntegrationEnvironment: () => ({}) }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./local-provider-emulation dependency used by this test.
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
