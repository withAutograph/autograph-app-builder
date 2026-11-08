import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import type { HostedDatabase } from "../db/hosted-postgres";
import type { isCursorClientReady } from "../auth/cursor-client";

import { activeBuilderModelId } from "../integrations/active-model";
import { builderHandoffRecordSchema } from "./contracts";
import type { BuilderHandoffRecord } from "./contracts";
import { BuilderHandoffUnavailableError } from "./service";
import {
  findAuthenticatedPendingBuilderHandoff as findPending,
  getBuilderHandoffPageData as getPageData,
  getBuilderHandoffStatusDeploymentHandler as getStatusHandler,
} from "./deployment";
import type { BuilderHandoffPageDependencies } from "./deployment";
import type { BuilderHandoffStore } from "./service";

const mocks = {
  cursorReady: vi.fn<typeof isCursorClientReady>(),
  database: drizzle.mock<HostedDatabase["_"]["fullSchema"]>(),
  findLatestPending: vi.fn<NonNullable<BuilderHandoffStore["findLatestPending"]>>(),
  read: vi.fn<BuilderHandoffStore["read"]>(),
  session: vi.fn<BuilderHandoffPageDependencies["session"]>(),
};
const dependencies: BuilderHandoffPageDependencies = {
  databases: new Map(),
  readConfig: () => ({
    databaseUrl: "postgres://test:private-password@localhost/handoff-page",
    issuer: "https://builder.example.test/api/auth",
    resource: "https://builder.example.test/mcp",
  }),
  openDatabase: () => mocks.database,
  session: mocks.session,
  createStore: () => ({
    findLatestPending: mocks.findLatestPending,
    read: mocks.read,
    reserve: vi.fn<BuilderHandoffStore["reserve"]>(),
    bindSession: vi.fn<BuilderHandoffStore["bindSession"]>(),
  }),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous Cursor client loader contract.
  loadCursorClient: async () => ({ isCursorClientReady: mocks.cursorReady }),
};
// oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
const getBuilderHandoffPageData = (input: Parameters<typeof getPageData>[0]) =>
  getPageData(input, dependencies);
// oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
const findAuthenticatedPendingBuilderHandoff = (input: Parameters<typeof findPending>[0]) =>
  findPending(input, dependencies);
const getBuilderHandoffStatusDeploymentHandler = (
  environment: Parameters<typeof getStatusHandler>[0],
) => getStatusHandler(environment, dependencies);

const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user-one",
  workspaceId: "workspace-one",
};
const prepared = builderHandoffRecordSchema.parse({
  authority,
  createdAt: new Date("2026-09-01T12:00:00Z"),
  creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
  expiresAt: new Date("2026-09-08T12:00:00Z"),
  handoffId,
  intent: {
    appId: "vendor-review",
    appName: "Vendor Review",
    brief: "Review new vendors.",
    connections: [],
    modelId: activeBuilderModelId,
    providers: {
      githubInstallationId: "123",
      vercelInstallationId: "icfg_selected",
    },
    repository: { private: true, requestedName: "vendor-review" },
  },
  requestDigest: "a".repeat(64),
  version: 1,
});
const pageInput = {
  environment: {},
  handoffId,
  headers: new Headers({ cookie: "private-session-cookie" }),
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
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Model an absent pending handoff with an undefined result.
    mocks.findLatestPending.mockReset().mockResolvedValue(undefined);
    mocks.read.mockReset().mockImplementation(
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async (input: { authority: BuilderHandoffRecord["authority"]; handoffId: string }) =>
        JSON.stringify(input.authority) === JSON.stringify(authority) &&
        input.handoffId === handoffId
          ? prepared
          : undefined,
    );
  });

  it("returns only public fields and uses the exact web session authority", async () => {
    const data = await getBuilderHandoffPageData(pageInput);
    expect(data).toEqual({
      cursorInstallReady: false,
      destination: "codex",
      expiresAt: prepared.expiresAt.toISOString(),
      handoffId,
      intent: prepared.intent,
      mcpUrl: authority.audience,
      status: "prepared",
      version: 1,
    });
    expect(mocks.session).toHaveBeenCalledWith({
      environment: pageInput.environment,
      headers: pageInput.headers,
    });
    expect(mocks.read).toHaveBeenCalledWith({ authority, handoffId });
    expect(mocks.cursorReady).toHaveBeenCalledWith(mocks.database, authority.audience);
    expect(JSON.stringify(data)).not.toMatch(
      /private-password|private-session-cookie|ownerUserId|workspaceId|requestDigest|sessionId/u,
    );
  });

  it("returns undefined without login before reading any handoff or checking Cursor readiness", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Exercise the missing-session input.
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

  it("returns only an owner-scoped pending handoff ID for builder resume", async () => {
    mocks.findLatestPending.mockResolvedValue(prepared);
    await expect(
      findAuthenticatedPendingBuilderHandoff({
        environment: pageInput.environment,
        headers: pageInput.headers,
      }),
    ).resolves.toEqual({ handoffId });
    expect(mocks.findLatestPending).toHaveBeenCalledWith({ authority });
  });

  it("does not expose pending handoffs without an authenticated authority", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Exercise missing authentication for pending handoffs.
    mocks.session.mockResolvedValue(undefined);
    await expect(
      findAuthenticatedPendingBuilderHandoff({
        environment: pageInput.environment,
        headers: pageInput.headers,
      }),
    ).resolves.toBeUndefined();
    expect(mocks.findLatestPending).not.toHaveBeenCalled();
  });

  it.each(["other-owner", "other-workspace", "missing", "invalid-id"])(
    "hides %s rows with the same generic 404",
    async (scenario) => {
      if (scenario === "other-owner") {
        mocks.session.mockResolvedValue({
          organization: { workspaceId: authority.workspaceId },
          user: { id: "user-two" },
        });
      }
      if (scenario === "other-workspace") {
        mocks.session.mockResolvedValue({
          organization: { workspaceId: "workspace-two" },
          user: { id: authority.ownerUserId },
        });
      }
      let id = handoffId;
      if (scenario === "missing") {
        id = "123e4567-e89b-42d3-a456-426614174099";
      } else if (scenario === "invalid-id") {
        id = "invalid";
      }
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
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
    const data = await response.json();
    // oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing untyped input or fixture boundary.
    expect(data.status).toBe("continued");
    expect(JSON.stringify(data)).not.toMatch(/sessionId|private-engine-id|redeemedAt/u);
  });

  it("reports Cursor destination separately from registration readiness", async () => {
    mocks.read.mockResolvedValue({
      ...prepared,
      intent: { ...prepared.intent, destination: "cursor" },
    });
    expect(await getBuilderHandoffPageData(pageInput)).toMatchObject({
      cursorInstallReady: false,
      destination: "cursor",
    });
    mocks.cursorReady.mockResolvedValue(true);
    expect(await getBuilderHandoffPageData(pageInput)).toMatchObject({
      cursorInstallReady: true,
      destination: "cursor",
    });
  });
});
