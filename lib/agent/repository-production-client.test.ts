import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryProductionClient,
  repositoryProductionResponseError,
} from "./repository-production-client";

describe("Production request failure guidance", () => {
  it.each(["plan", "setup-status"] as const)(
    "does not claim %s provisioned anything",
    async (action) => {
      const error = await repositoryProductionResponseError(
        Response.json({ code: "app_access_unknown" }, { status: 503 }),
        action,
      );
      expect(error.message).toContain("This read did not start setup");
      expect(error.message).not.toContain("setup is saved");
    },
  );
  it("retains uncertainty for an unconfirmed preparation", async () => {
    const error = await repositoryProductionResponseError(
      new Response("unavailable", { status: 503 }),
      "prepare",
    );
    expect(error.message).toContain("Check its status before retrying");
  });
  it("guides recovery of the saved delivery in the same session", async () => {
    const error = await repositoryProductionResponseError(
      Response.json(
        { code: "app_setup_destination_required", secret: "never expose" },
        { status: 409 },
      ),
      "plan",
    );
    expect(error.message).toContain("saved delivery in the same session");
    expect(error.message).toContain("repository and current source for Production");
    expect(error.message).not.toContain("never expose");
  });
});

const repository = { repositoryId: "123", repositoryFullName: "example/repo" };
type RequestTarget = Partial<typeof repository> & {
  reviewedHeadSha?: string;
  expectedMergeSha?: string;
  expectedSchemaGrantDigest?: string;
};
const reviewedTarget = { ...repository, reviewedHeadSha: "a".repeat(40) };
const status = {
  version: 1,
  appId: "example-app",
  ...repository,
  applicable: true,
  operationRef: "11111111-1111-4111-a111-111111111111",
  state: "ready",
  preparationRequired: false,
};

const deliveryClient = () => {
  const authority = {
    audience: "https://builder.test/mcp",
    issuer: "https://builder.test/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  };
  const ownerContext = {
    kind: "direct" as const,
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: "session",
    adapterSessionId: "adapter",
    adapterGeneration: 1,
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = createRepositoryProductionClient({
    endpoint: "https://operator.test/",
    ownerContext,
    callId: "delivery-status",
    signal: new AbortController().signal,
    workloadToken: vi.fn<() => Promise<string>>().mockResolvedValue("builder-token"),
    fetch,
  });
  const requestBody = (target: RequestTarget, action = "delivery-status") =>
    JSON.stringify({
      version: 1,
      action,
      appId: status.appId,
      sessionId: ownerContext.sessionId,
      ownerContext,
      ...target,
    });
  return { client, fetch, requestBody };
};

describe("reviewed-head Production readiness transport", () => {
  it("sends the reviewed SHA in the read and preserves the readiness response shape", async () => {
    const fixture = deliveryClient();
    fixture.fetch.mockResolvedValueOnce(Response.json(status));
    await expect(fixture.client.deliveryStatus(status.appId, reviewedTarget)).resolves.toEqual(
      status,
    );
    expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(
      new URL("https://operator.test/v1/repository-production"),
      expect.objectContaining({ body: fixture.requestBody(reviewedTarget) }),
    );
  });

  it("retries the exact legacy read once on an explicit request-shape rejection", async () => {
    const fixture = deliveryClient();
    fixture.fetch
      .mockResolvedValueOnce(Response.json({ code: "request_invalid" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(status));
    await expect(fixture.client.deliveryStatus(status.appId, reviewedTarget)).resolves.toEqual(
      status,
    );
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(fixture.fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://operator.test/v1/repository-production"),
      expect.objectContaining({ body: fixture.requestBody(repository) }),
    );
  });

  it.each([
    [403, "app_access_denied"],
    [403, "request_invalid"],
    [400, "app_access_denied"],
    [503, "app_access_unknown"],
  ] as const)("keeps %s %s closed without a fallback", async (statusCode, code) => {
    const fixture = deliveryClient();
    fixture.fetch.mockResolvedValueOnce(Response.json({ code }, { status: statusCode }));
    await expect(fixture.client.deliveryStatus(status.appId, reviewedTarget)).rejects.toThrow(
      "could not read this app's Production setup",
    );
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it("preserves a denial from an older operator when the legacy read cannot prove authority", async () => {
    const fixture = deliveryClient();
    fixture.fetch
      .mockResolvedValueOnce(Response.json({ code: "request_invalid" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ code: "app_access_denied" }, { status: 403 }));
    await expect(fixture.client.deliveryStatus(status.appId, reviewedTarget)).rejects.toThrow(
      "could not read this app's Production setup",
    );
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed reviewed SHA without contacting the operator", async () => {
    const fixture = deliveryClient();
    await expect(
      fixture.client.deliveryStatus(status.appId, { ...repository, reviewedHeadSha: "main" }),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});

describe("native Production revision transport", () => {
  const native = {
    version: 1,
    appId: status.appId,
    observedAt: "2026-11-11T00:00:00Z",
    status: "available",
    deployment: { state: "active" },
    app: { state: "responding", url: "https://apps.test/example-app" },
    requestedRevision: "live",
  };
  const expectedMergeSha = "c".repeat(40);

  it("requests evidence for the merged revision", async () => {
    const f = deliveryClient();
    f.fetch.mockResolvedValueOnce(Response.json(native));
    await expect(f.client.nativeStatus(status.appId, expectedMergeSha)).resolves.toEqual(native);
    expect(f.fetch).toHaveBeenCalledWith(
      new URL("https://operator.test/v1/repository-production"),
      expect.objectContaining({ body: f.requestBody({ expectedMergeSha }, "native-status") }),
    );
  });

  it("keeps legacy availability unassessed during rollout", async () => {
    const f = deliveryClient();
    const legacy = { ...native, requestedRevision: "unassessed" };
    f.fetch
      .mockResolvedValueOnce(Response.json({ code: "request_invalid" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(legacy));
    await expect(f.client.nativeStatus(status.appId, expectedMergeSha)).resolves.toEqual(legacy);
    expect(f.fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://operator.test/v1/repository-production"),
      expect.objectContaining({ body: f.requestBody({}, "native-status") }),
    );
  });

  it("does not fall back to an ordinary read when the operator cannot check the expected schema grant", async () => {
    const f = deliveryClient();
    const expectedSchemaGrantDigest = "e".repeat(64);
    f.fetch.mockResolvedValueOnce(Response.json({ code: "request_invalid" }, { status: 400 }));
    await expect(
      f.client.nativeStatus(status.appId, expectedMergeSha, undefined, expectedSchemaGrantDigest),
    ).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledExactlyOnceWith(
      new URL("https://operator.test/v1/repository-production"),
      expect.objectContaining({
        body: f.requestBody({ expectedMergeSha, expectedSchemaGrantDigest }, "native-status"),
      }),
    );
  });
});
