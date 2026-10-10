/* oxlint-disable eslint/require-await -- Synthetic authority and Source ports preserve asynchronous production interfaces. */
import { describe, expect, it, vi } from "vitest";
import {
  custodyActorDigest,
  custodyGrantDigest,
  custodyPlanDigest,
  custodyPlanSchema,
  custodyRecordSchema,
} from "./vercel-token-key-custody";
import type { CustodyJournalRow } from "./vercel-token-key-custody";
import { custodySetupConfigurationSchema } from "./vercel-token-key-custody-deployment";
import type { createCustodySourceHandler } from "./vercel-token-key-custody-deployment";
import {
  createCustodyOwnerInvocationHandler,
  custodyOwnerInvocationPath,
} from "./vercel-token-key-custody-owner-invocation";
import type { CustodyBrowserActor } from "./vercel-token-key-custody-owner-invocation";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const operationRef = "11111111-1111-4111-8111-111111111111";
const plan = custodyPlanSchema.parse({
  action: "transfer-active-vercel-token-key-to-operator-preview",
  actorAuthorityDigest: custodyActorDigest(authority),
  approvalExpiresAt: "2099-10-10T13:00:00Z",
  destination: {
    environment: "preview",
    gitBranch: null,
    key: "VERCEL_INTEGRATION_TOKEN_KEY",
    projectId: "operator",
    requiredVersion: "v1",
    teamId: "team",
    type: "sensitive",
    versionKey: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
    write: "create-only",
  },
  installationId: "installation",
  operationRef,
  ownerSessionId: "session",
  source: {
    deploymentId: "source-deployment",
    environment: "production",
    key: "VERCEL_INTEGRATION_TOKEN_KEY",
    keyVersion: "v1",
    projectId: "builder",
    teamId: "team",
    versionKey: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
  },
  version: 1,
});
const setupGrant = {
  approvalRef: "approval",
  approvedAt: "2026-10-10T11:00:00Z",
  approvedPlanDigest: custodyPlanDigest(plan),
  expiresAt: plan.approvalExpiresAt,
  grantRef: "grant",
  operationRef,
  originalActor: authority,
  ownerSessionId: "session",
  scope: "source-global-active-v1-key-custody" as const,
  version: 1 as const,
};
const record = custodyRecordSchema.parse({
  approvalRef: "approval",
  fenceGeneration: 0,
  grantDigest: custodyGrantDigest(setupGrant),
  grantRef: "grant",
  kind: "vercel-token-key-custody-v1",
  originalActor: authority,
  phase: "reserved",
  plan,
  planDigest: custodyPlanDigest(plan),
  setupGrant,
  version: 1,
});
const setupInput = {
  capturedOwner: {
    adapterGeneration: 1,
    adapterSessionId: "adapter-session",
    authority,
    kind: "direct",
    principal: { ...authority, scopes: ["autograph:start"] },
    sessionId: "session",
  },
  grantRef: "grant",
  operationRef,
  recipient: {
    origin: "https://operator.example",
    workload: {
      audience: "https://vercel.com/team",
      environment: "preview",
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "operator",
      subject: "recipient-subject",
    },
  },
  source: {
    origin: "https://builder.example",
    workload: {
      audience: "https://vercel.com/team",
      environment: "production",
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "builder",
      subject: "source-subject",
    },
  },
  version: 1,
};

const setup = custodySetupConfigurationSchema.parse(setupInput);
const now = Date.parse("2026-10-10T12:00:00Z");
const address = `${setup.source.origin}${custodyOwnerInvocationPath}`;
const getRequest = () => new Request(address);
const formRequest = (
  body = `operationRef=${operationRef}`,
  overrides: Record<string, string> = {},
) =>
  new Request(address, {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: setup.source.origin,
      ...overrides,
    },
    method: "POST",
  });
const fixture = () => {
  const readBrowserActor = vi.fn(async (): Promise<CustodyBrowserActor | undefined> => ({
    sessionId: "browser-session",
    userId: "owner",
  }));
  const assertOriginalOwner = vi.fn(async () => {});
  const read = vi.fn(async (): Promise<CustodyJournalRow | undefined> => ({ record, revision: 1 }));
  const effect = vi.fn(async () => Response.json({ operationRef, phase: "secret-confirmed" }));
  const sourceRequest = vi.fn(async (request: Request) => {
    expect(await request.json()).toEqual({ operationRef });
  });
  const createSourceHandler: typeof createCustodySourceHandler = vi.fn(
    (
      _environment: Readonly<Record<string, string | undefined>> = {},
      dependencies: NonNullable<Parameters<typeof createCustodySourceHandler>[1]> = {},
    ) =>
      async (request: Request) => {
        await dependencies.verifyCaller?.(request, setup);
        await dependencies.currentOwner?.(setup);
        await sourceRequest(request);
        return await effect();
      },
  );
  const factory = vi.mocked(createSourceHandler);
  const handler = createCustodyOwnerInvocationHandler(
    {},
    {
      assertOriginalOwner,
      createSourceHandler,
      now: () => now,
      readBrowserActor,
      readSetup: async () => setup,
      store: { read },
    },
  );
  return { assertOriginalOwner, effect, factory, handler, read, readBrowserActor, sourceRequest };
};
const assertDenied = async (response: Response) => {
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toContain("Key custody unavailable");
  expect(body).not.toContain("<form");
  expect(body).not.toContain("PRIVATE_FAILURE_MARKER");
};

describe("closed owner key custody invocation", () => {
  it("renders protected metadata and one native operation selector without a Source effect", async () => {
    const { effect, factory, handler, read } = fixture();
    const response = await handler(getRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const body = await response.text();
    expect(body).toContain(record.planDigest);
    expect(body).toContain(record.grantDigest);
    expect(body).toContain('method="post"');
    expect(body.match(/name="operationRef"/gu)).toHaveLength(1);
    expect(body).not.toContain('name="nonce"');
    expect(body).not.toContain('name="approval"');
    expect(read).toHaveBeenCalledWith({ authority, operationRef });
    expect(factory).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });
  it("redirects an unsigned GET to sign-in and denies its POST", async () => {
    const { factory, handler, read, readBrowserActor } = fixture();
    readBrowserActor.mockImplementation(async () => {});
    const response = await handler(getRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${setup.source.origin}/auth/sign-in?redirectTo=${encodeURIComponent(custodyOwnerInvocationPath)}`,
    );
    await assertDenied(await handler(formRequest()));
    expect(read).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
  it("denies a foreign browser owner and stale original ownership before Source", async () => {
    const foreign = fixture();
    foreign.readBrowserActor.mockResolvedValue({ sessionId: "foreign", userId: "other" });
    await assertDenied(await foreign.handler(formRequest()));
    expect(foreign.read).not.toHaveBeenCalled();
    expect(foreign.factory).not.toHaveBeenCalled();
    const stale = fixture();
    stale.assertOriginalOwner.mockRejectedValue(new Error("PRIVATE_FAILURE_MARKER"));
    await assertDenied(await stale.handler(getRequest()));
    expect(stale.read).not.toHaveBeenCalled();
    expect(stale.factory).not.toHaveBeenCalled();
  });
  it("denies changed browser session identity during the initial ownership recheck", async () => {
    const { factory, handler, read, readBrowserActor } = fixture();
    readBrowserActor.mockResolvedValueOnce({ sessionId: "first", userId: "owner" });
    readBrowserActor.mockResolvedValue({ sessionId: "changed", userId: "owner" });
    await assertDenied(await handler(formRequest()));
    expect(read).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(["missing", "revoked", "expired", "grant-mismatch", "session-mismatch"])(
    "denies %s grant context without rendering a form or invoking Source",
    async (variant) => {
      const { factory, handler, read } = fixture();
      if (variant === "missing") {
        read.mockImplementation(async () => {});
      }
      if (variant === "revoked") {
        read.mockResolvedValue({
          record: { ...record, grantRevokedAt: "2026-10-10T11:59:00Z" },
          revision: 1,
        });
      }
      if (variant === "expired") {
        const expiredPlan = { ...plan, approvalExpiresAt: "2026-10-10T11:59:00Z" };
        const expiredGrant = {
          ...setupGrant,
          approvedPlanDigest: custodyPlanDigest(expiredPlan),
          expiresAt: expiredPlan.approvalExpiresAt,
        };
        read.mockResolvedValue({
          record: {
            ...record,
            grantDigest: custodyGrantDigest(expiredGrant),
            plan: expiredPlan,
            planDigest: custodyPlanDigest(expiredPlan),
            setupGrant: expiredGrant,
          },
          revision: 1,
        });
      }
      if (variant === "grant-mismatch") {
        const otherGrant = { ...setupGrant, grantRef: "other" };
        read.mockResolvedValue({
          record: {
            ...record,
            grantDigest: custodyGrantDigest(otherGrant),
            grantRef: "other",
            setupGrant: otherGrant,
          },
          revision: 1,
        });
      }
      if (variant === "session-mismatch") {
        const otherPlan = { ...plan, ownerSessionId: "other-session" };
        const otherGrant = {
          ...setupGrant,
          approvedPlanDigest: custodyPlanDigest(otherPlan),
          ownerSessionId: "other-session",
        };
        read.mockResolvedValue({
          record: {
            ...record,
            grantDigest: custodyGrantDigest(otherGrant),
            plan: otherPlan,
            planDigest: custodyPlanDigest(otherPlan),
            setupGrant: otherGrant,
          },
          revision: 1,
        });
      }
      await assertDenied(await handler(getRequest()));
      await assertDenied(await handler(formRequest()));
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it.each([
    `operationRef=${operationRef}&operationRef=${operationRef}`,
    `operationRef=${operationRef}&nonce=caller-selected`,
    `operationRef=${operationRef}&approval=true`,
    `operationRef=${"x".repeat(4097)}`,
    "operationRef=22222222-2222-4222-8222-222222222222",
  ])("rejects additional, duplicate, oversized or foreign native form input", async (body) => {
    const { factory, handler } = fixture();
    await assertDenied(await handler(formRequest(body)));
    expect(factory).not.toHaveBeenCalled();
  });
  it("denies foreign Origin and JSON input before constructing Source", async () => {
    const { factory, handler } = fixture();
    await assertDenied(
      await handler(formRequest(undefined, { origin: "https://foreign.example" })),
    );
    await assertDenied(
      await handler(
        formRequest(JSON.stringify({ operationRef }), { "content-type": "application/json" }),
      ),
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it("invokes Source in-process with only the selector and actual fresh identity callbacks", async () => {
    const { assertOriginalOwner, effect, factory, handler, readBrowserActor, sourceRequest } =
      fixture();
    const response = await handler(formRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Saved operation continued");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(readBrowserActor).toHaveBeenCalledTimes(5);
    expect(assertOriginalOwner).toHaveBeenCalledTimes(4);
    const [[incoming]] = sourceRequest.mock.calls;
    expect(incoming.headers.get("cookie")).toBeNull();
    expect(incoming.headers.get("authorization")).toBeNull();
    expect(incoming.headers.get("content-type")).toBe("application/json");
  });
  it("Source's verification callback rejects a browser session changed after handoff", async () => {
    const { effect, factory, handler, readBrowserActor } = fixture();
    readBrowserActor
      .mockResolvedValueOnce({ sessionId: "browser-session", userId: "owner" })
      .mockResolvedValueOnce({ sessionId: "browser-session", userId: "owner" })
      .mockResolvedValueOnce({ sessionId: "browser-session", userId: "owner" })
      .mockResolvedValue({ sessionId: "changed", userId: "owner" });
    await assertDenied(await handler(formRequest()));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(effect).not.toHaveBeenCalled();
  });
  it("Source's current-owner callback rejects revocation after handoff", async () => {
    const { assertOriginalOwner, effect, handler } = fixture();
    assertOriginalOwner
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValue(new Error("PRIVATE_FAILURE_MARKER"));
    await assertDenied(await handler(formRequest()));
    expect(effect).not.toHaveBeenCalled();
  });
  it("discards Source failure details and caller-selected response metadata", async () => {
    const failure = fixture();
    failure.effect.mockResolvedValue(new Response("PRIVATE_FAILURE_MARKER", { status: 409 }));
    const response = await failure.handler(formRequest());
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).toContain("Key custody needs review");
    expect(body).not.toContain("PRIVATE_FAILURE_MARKER");
    const unsafe = fixture();
    unsafe.effect.mockResolvedValue(
      Response.json({ operationRef, phase: "secret-confirmed", secret: "PRIVATE_FAILURE_MARKER" }),
    );
    await assertDenied(await unsafe.handler(formRequest()));
  });
  it("escapes metadata and suppresses the continuation form during an active lease", async () => {
    const { factory, handler, read } = fixture();
    const approvalRef = "<script>metadata</script>";
    const escapedGrant = { ...setupGrant, approvalRef };
    read.mockResolvedValue({
      record: {
        ...record,
        approvalRef,
        fenceGeneration: 1,
        grantDigest: custodyGrantDigest(escapedGrant),
        leaseExpiresAt: "2026-10-10T12:00:30Z",
        leaseId: "22222222-2222-4222-8222-222222222222",
        setupGrant: escapedGrant,
      },
      revision: 2,
    });
    const response = await handler(getRequest());
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("&lt;script&gt;metadata&lt;/script&gt;");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<form");
    expect(body).toContain("operation is in progress");
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([
    new Request(`${address}?operationRef=${operationRef}`),
    new Request(address, { headers: { authorization: "Bearer CALLER_TOKEN" } }),
    new Request(address, { method: "PUT" }),
  ])("rejects alternate addresses, bearer ingress and unsupported methods", async (request) => {
    const { factory, handler, read } = fixture();
    await assertDenied(await handler(request));
    expect(read).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});
