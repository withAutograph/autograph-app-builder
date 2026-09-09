import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  builderHandoffRecordSchema,
  type BuilderHandoffRecord,
} from "./contracts";
import { BuilderHandoffUnavailableError } from "./service";
import {
  getBuilderHandoffPageData,
  getBuilderHandoffStatusDeploymentHandler,
} from "./deployment";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  read: vi.fn(),
  cursorReady: vi.fn(),
  database: {},
}));

vi.mock("../auth/preview-oauth-deployment", () => ({
  ensurePreviewOAuthDeploymentSessionOrganization: mocks.session,
}));
vi.mock("../auth/preview-oauth-runtime", () => ({
  readPreviewOAuthRuntimeConfig: () => ({
    issuer: "https://builder.example.test/api/auth",
    resource: "https://builder.example.test/mcp",
    databaseUrl: "postgres://test:private-password@localhost/handoff-page",
  }),
}));
vi.mock("../mcp/hosted-route", () => ({
  openHostedPostgresDatabase: () => mocks.database,
}));
vi.mock("../auth/cursor-client", () => ({
  isCursorClientReady: mocks.cursorReady,
}));
vi.mock("./postgres-store", () => ({
  createPostgresBuilderHandoffStore: () => ({ read: mocks.read }),
}));

const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace-one",
  ownerUserId: "user-one",
};
const prepared = builderHandoffRecordSchema.parse({
  version: 1,
  handoffId,
  authority,
  creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
  requestDigest: "a".repeat(64),
  intent: {
    appName: "Vendor Review",
    appId: "vendor-review",
    brief: "Review new vendors.",
    repository: { requestedName: "vendor-review", private: true },
    modelId: "openai/gpt-5.6-sol",
    connections: [],
    providers: {
      githubInstallationId: "123",
      vercelInstallationId: "icfg_selected",
    },
  },
  createdAt: new Date("2026-09-01T12:00:00Z"),
  expiresAt: new Date("2026-09-08T12:00:00Z"),
});
const pageInput = {
  environment: {},
  headers: new Headers({ cookie: "private-session-cookie" }),
  handoffId,
};

describe("owner-only handoff browser data", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));
    mocks.session.mockReset().mockResolvedValue({
      organization: { workspaceId: authority.workspaceId },
      user: { id: authority.ownerUserId },
    });
    mocks.cursorReady.mockReset().mockResolvedValue(false);
    mocks.read
      .mockReset()
      .mockImplementation(
        async (input: {
          authority: BuilderHandoffRecord["authority"];
          handoffId: string;
        }) =>
          JSON.stringify(input.authority) === JSON.stringify(authority) &&
          input.handoffId === handoffId
            ? prepared
            : undefined,
      );
  });

  it("returns only public fields and uses the exact web session authority", async () => {
    const data = await getBuilderHandoffPageData(pageInput);
    expect(data).toEqual({
      version: 1,
      handoffId,
      expiresAt: prepared.expiresAt.toISOString(),
      status: "prepared",
      intent: prepared.intent,
      destination: "codex",
      cursorInstallReady: false,
      mcpUrl: authority.audience,
    });
    expect(mocks.session).toHaveBeenCalledWith({
      environment: pageInput.environment,
      headers: pageInput.headers,
    });
    expect(mocks.read).toHaveBeenCalledWith({ authority, handoffId });
    expect(mocks.cursorReady).toHaveBeenCalledWith(
      mocks.database,
      authority.audience,
    );
    expect(JSON.stringify(data)).not.toMatch(
      /private-password|private-session-cookie|ownerUserId|workspaceId|requestDigest|sessionId/u,
    );
  });

  it("returns undefined without login before reading any handoff or checking Cursor readiness", async () => {
    mocks.session.mockResolvedValue(undefined);
    expect(await getBuilderHandoffPageData(pageInput)).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.cursorReady).not.toHaveBeenCalled();
    const response = await getBuilderHandoffStatusDeploymentHandler({})(
      new Request(`${authority.audience}/unused`),
      handoffId,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["other-owner", "other-workspace", "missing", "invalid-id"])(
    "hides %s rows with the same generic 404",
    async (scenario) => {
      if (scenario === "other-owner")
        mocks.session.mockResolvedValue({
          organization: { workspaceId: authority.workspaceId },
          user: { id: "user-two" },
        });
      if (scenario === "other-workspace")
        mocks.session.mockResolvedValue({
          organization: { workspaceId: "workspace-two" },
          user: { id: authority.ownerUserId },
        });
      const id =
        scenario === "missing"
          ? "123e4567-e89b-42d3-a456-426614174099"
          : scenario === "invalid-id"
            ? "invalid"
            : handoffId;
      await expect(
        getBuilderHandoffPageData({ ...pageInput, handoffId: id }),
      ).rejects.toBeInstanceOf(BuilderHandoffUnavailableError);
      const response = await getBuilderHandoffStatusDeploymentHandler({})(
        new Request(`${authority.audience}/unused`),
        id,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "handoff_unavailable" });
      expect(mocks.cursorReady).not.toHaveBeenCalled();
    },
  );

  it("reads expired records and exposes a bound session as continued without its engine ID", async () => {
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    expect(await getBuilderHandoffPageData(pageInput)).toMatchObject({
      status: "expired",
    });
    mocks.read.mockResolvedValue({
      ...prepared,
      redeemedAt: new Date("2026-09-02T12:00:00Z"),
      sessionId: "private-engine-id",
    });
    const response = await getBuilderHandoffStatusDeploymentHandler({})(
      new Request(`${authority.audience}/unused`),
      handoffId,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.status).toBe("continued");
    expect(JSON.stringify(data)).not.toMatch(
      /sessionId|private-engine-id|redeemedAt/u,
    );
  });

  it("reports Cursor destination separately from registration readiness", async () => {
    mocks.read.mockResolvedValue({
      ...prepared,
      intent: { ...prepared.intent, destination: "cursor" },
    });
    expect(await getBuilderHandoffPageData(pageInput)).toMatchObject({
      destination: "cursor",
      cursorInstallReady: false,
    });
    mocks.cursorReady.mockResolvedValue(true);
    expect(await getBuilderHandoffPageData(pageInput)).toMatchObject({
      destination: "cursor",
      cursorInstallReady: true,
    });
  });
});
