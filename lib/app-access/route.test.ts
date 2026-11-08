/* oxlint-disable eslint/require-await -- In-memory adapters implement asynchronous production ports. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppAccessSnapshot } from "./contracts";
import { appAccessCommandSchema } from "./contracts";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import { AppAccessError } from "./errors";
import { createAppAccessOperatorClient } from "./operator-client";
import type { AppAccessOwner } from "./operator-client";
import { createAppAccessRouteHandler } from "./route";
import { createRepositoryProductionHandler } from "../provisioning/repository-production-dispatcher";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const origin = "https://builder.example.test";
const authority = {
  issuer: `${origin}/api/auth`,
  audience: `${origin}/mcp`,
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const owner: AppAccessOwner = {
  sessionId: "session",
  appId: "expenses",
  ownerContext: {
    kind: "direct",
    sessionId: "session",
    adapterSessionId: "adapter",
    adapterGeneration: 1,
    authority,
    principal: { ...authority, scopes: ["autograph:session"] },
  },
};
const routeOwner = { publicSessionId: owner.sessionId, operatorOwner: owner };
const snapshot: AppAccessSnapshot = {
  sessionId: "session",
  appId: "expenses",
  appName: "Expenses",
  organizationName: "Dev",
  canManage: true,
  roles: [],
  members: [],
  invitations: [],
  creator: { status: "ready" },
};
const command = {
  clientRequestId: randomUUID(),
  action: "invite" as const,
  email: "guest@example.test",
  roles: [],
};
const request = (value = command, source = origin) =>
  new Request(`${origin}/api/builder/sessions/session/access`, {
    method: "POST",
    headers: { origin: source, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
const unusedProtectedPort = async () => {
  throw new Error("unused fixture port");
};
const phaseByStage = {
  owner: "access_owner_resolve",
  read: "access_operator_read",
  recheck: "access_owner_recheck",
};

describe("session-owned app access route", () => {
  it.each(["owner", "read", "recheck"] as const)(
    "reports a closed %s stage while preserving the actual GET failure response",
    async (stage) => {
      const secret = "private-token user@example.test https://private.example/path";
      const access = vi.fn(() => {
        throw new Error("private-accessor");
      });
      const failure = Object.defineProperties(new Error(secret), {
        code: { get: access },
        status: { get: access },
        cause: { get: access },
      });
      let resolves = 0;
      const handler = createAppAccessRouteHandler({
        origin,
        execute: vi.fn(),
        resolveOwner: async () => {
          resolves += 1;
          if (stage === "owner" || (stage === "recheck" && resolves === 2)) {
            throw failure;
          }
          return routeOwner;
        },
        read: async () => {
          if (stage === "read") {
            throw failure;
          }
          return snapshot;
        },
      });
      const response = await handler(
        new Request(`${origin}/api/builder/sessions/session/access`),
        "session",
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "app_access_unavailable",
        message: "Builder could not finish setting up access. Your app and progress are saved.",
      });
      const output = vi.mocked(console.warn).mock.calls.flat().join("");
      expect(output).toContain(`"phase":"${phaseByStage[stage]}"`);
      for (const value of [
        secret,
        "user@example.test",
        "private-accessor",
        "session",
        "workspace",
      ]) {
        expect(output).not.toContain(value);
      }
      expect(access).not.toHaveBeenCalled();
    },
  );
  it("traces a real protected status rejection through the client and web GET without exposing its body", async () => {
    const protectedHandler = createRepositoryProductionHandler({
      verifyBuilderWorkload: async () => {},
      verifyAuthWorkload: async () => {},
      resolvePlan: unusedProtectedPort,
      readSetup: unusedProtectedPort,
      resolveSetup: unusedProtectedPort,
      management: {
        read: async () => {
          throw new Error("repository_production_capture_unavailable");
        },
        execute: unusedProtectedPort,
        completeInvitation: unusedProtectedPort,
      },
    });
    const client = createAppAccessOperatorClient({
      endpoint: "https://operator.example.test",
      token: async () => "private-workload-token",
      fetch: async (input, init) => await protectedHandler(new Request(input, init)),
    });
    const response = await createAppAccessRouteHandler({
      origin,
      resolveOwner: async () => routeOwner,
      ...client,
    })(new Request(`${origin}/api/builder/sessions/session/access`), "session");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("capture_unavailable");
    const output = vi.mocked(console.warn).mock.calls.flat().join("");
    expect(output).toContain('"phase":"access_projection"');
    expect(output).toContain('"reason":"capture_unavailable"');
    expect(output).toContain('"phase":"access_operator_http"');
    expect(output).toContain('"httpStatus":503');
    expect(output).toContain('"phase":"access_operator_read"');
    expect(output).not.toContain("private-workload-token");
    expect(output).not.toContain("operator.example.test");
  });
  it("keeps the GET response unchanged when diagnostic logging fails", async () => {
    vi.mocked(console.warn).mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const handler = createAppAccessRouteHandler({
      origin,
      resolveOwner: async () => routeOwner,
      execute: vi.fn(),
      read: async () => {
        throw new Error("private-error");
      },
    });
    const response = await handler(
      new Request(`${origin}/api/builder/sessions/session/access`),
      "session",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "app_access_unavailable" });
  });
  it("rejects cross-origin commands before dispatching any effect", async () => {
    const execute = vi.fn();
    const handler = createAppAccessRouteHandler({
      origin,
      resolveOwner: vi.fn(),
      read: vi.fn(),
      execute,
    });
    const response = await handler(request(command, "https://other.example.test"), "session");
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses server-owned scope and the original request identity for a valid command", async () => {
    const execute = vi.fn(async () => snapshot);
    const handler = createAppAccessRouteHandler({
      execute,
      origin,
      read: vi.fn(),
      resolveOwner: async () => routeOwner,
    });
    const response = await handler(request(), "session");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(execute).toHaveBeenCalledWith(owner, command);
  });

  it("does not disclose a response after owner access is revoked during a read", async () => {
    const resolveOwner = vi
      .fn()
      .mockResolvedValueOnce(routeOwner)
      .mockRejectedValueOnce(new AppAccessError("app_access_denied"));
    const handler = createAppAccessRouteHandler({
      execute: vi.fn(),
      origin,
      read: async () => snapshot,
      resolveOwner,
    });
    const response = await handler(
      new Request(`${origin}/api/builder/sessions/session/access`),
      "session",
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("organizationName");
  });

  it("rejects another app's response and never exposes provider diagnostics", async () => {
    const handler = createAppAccessRouteHandler({
      execute: vi.fn(),
      origin,
      read: async () => ({ ...snapshot, appId: "other" }),
      resolveOwner: async () => routeOwner,
    });
    const response = await handler(
      new Request(`${origin}/api/builder/sessions/session/access`),
      "session",
    );
    expect(response.status).toBe(503);
    const failed = createAppAccessRouteHandler({
      execute: vi.fn(),
      origin,
      read: async () => {
        throw new Error("postgres://secret@private");
      },
      resolveOwner: async () => routeOwner,
    });
    const failedResponse = await failed(
      new Request(`${origin}/api/builder/sessions/session/access`),
      "session",
    );
    expect(await failedResponse.text()).not.toContain("secret");
  });

  it("checks the canonical response before projecting a recovered public handle", async () => {
    const handler = createAppAccessRouteHandler({
      execute: vi.fn(),
      origin,
      read: async () => ({ ...snapshot, sessionId: "child" }),
      resolveOwner: async () => ({ publicSessionId: "child", operatorOwner: owner }),
    });
    const response = await handler(
      new Request(`${origin}/api/builder/sessions/child/access`),
      "child",
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("organizationName");
  });

  it("streams a bounded command body even without a content-length header", async () => {
    const execute = vi.fn();
    const handler = createAppAccessRouteHandler({
      execute,
      origin,
      read: vi.fn(),
      resolveOwner: async () => routeOwner,
    });
    const response = await handler(request({ ...command, email: "x".repeat(70_000) }), "session");
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes pagination to the reader without issuing mutations", async () => {
    const read = vi.fn(async () => snapshot);
    const execute = vi.fn();
    const handler = createAppAccessRouteHandler({
      execute,
      origin,
      read,
      resolveOwner: async () => routeOwner,
    });
    const response = await handler(
      new Request(`${origin}/api/builder/sessions/session/access?cursor=next`),
      "session",
    );
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith(owner, "next");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("protected app access transport", () => {
  it.each([
    "http://operator.example.test",
    "https://user:password@operator.example.test",
    "https://operator.example.test/another-path",
    "https://operator.example.test?token=untrusted",
  ])("rejects an unsafe configured operator endpoint %s", (endpoint) => {
    expect(() =>
      createAppAccessOperatorClient({ endpoint, token: async () => "workload" }),
    ).toThrow();
  });

  it("parses known request conflicts without trusting malformed failure bodies", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: "request_id_conflict" }, { status: 409 }))
      .mockResolvedValueOnce(new Response("not json", { status: 400 }));
    const client = createAppAccessOperatorClient({
      endpoint: "https://operator.example.test",
      fetch: send,
      token: async () => "workload",
    });
    await expect(client.execute(owner, command)).rejects.toMatchObject({
      code: "request_id_conflict",
    });
    await expect(client.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("leaves an interrupted mutation unknown and never retries it automatically", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connection closed after commit"));
    const client = createAppAccessOperatorClient({
      endpoint: "https://operator.example.test",
      fetch: send,
      token: async () => "workload",
    });
    await expect(client.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = z
      .object({ command: appAccessCommandSchema, ownerContext: operatorOwnerContextSchema })
      .parse(JSON.parse(z.string().parse(send.mock.calls[0]?.[1]?.body)));
    expect(payload.command).toEqual(command);
    expect(payload.ownerContext.authority).toEqual(authority);
    expect(send.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("rejects a response belonging to another session", async () => {
    const client = createAppAccessOperatorClient({
      endpoint: "https://operator.example.test",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ...snapshot, sessionId: "other" })),
      token: async () => "workload",
    });
    await expect(client.read(owner)).rejects.toMatchObject({ code: "app_access_unavailable" });
  });
});
