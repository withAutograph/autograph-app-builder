import { describe, expect, it, vi } from "vitest";
import { inspectNativeTargetVercelAuthorization } from "./native-target-vercel-authorization";

const metadata = () => ({
  arbitrary: "private extra metadata",
  id: "icfg_expected",
  ownerId: "team_expected",
  projectSelection: "all",
  scopes: ["read-write:project"],
  teamId: "team_expected",
});
const fixture = (response: Response = Response.json(metadata())) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const controller = new AbortController();
  const readInstallationToken = vi
    .fn<() => Promise<string>>()
    .mockResolvedValue("private-installation-token");
  const input = {
    expectedInstallationId: "icfg_expected",
    expectedTeamId: "team_expected",
    fetch,
    readInstallationToken,
    signal: controller.signal,
  };
  return { controller, fetch, input, run: () => inspectNativeTargetVercelAuthorization(input) };
};

describe("read-only installation authorization metadata", () => {
  it("uses only the scoped configuration GET and projects structural metadata", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      allProjectsConfigured: true,
      disabled: false,
      installationMatches: true,
      ownerMatches: true,
      projectWriteConfigured: true,
      status: "observed",
      statusCode: 200,
      teamMatches: true,
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const call = f.fetch.mock.calls.at(0);
    if (!call) {
      throw new Error("expected request");
    }
    const [url, options] = call;
    if (!(url instanceof URL)) {
      throw new Error("expected URL");
    }
    expect(url.href).toBe(
      "https://api.vercel.com/v1/integrations/configuration/icfg_expected?teamId=team_expected",
    );
    expect(options).toEqual({
      headers: { authorization: "Bearer private-installation-token" },
      method: "GET",
      redirect: "error",
      signal: f.controller.signal,
    });
  });
  it.each(["id", "teamId", "ownerId"] as const)(
    "exposes %s mismatch without granting permission",
    async (field) => {
      const result = await fixture(Response.json({ ...metadata(), [field]: "different" })).run();
      expect(result.status).toBe("observed");
      const key = {
        id: "installationMatches",
        ownerId: "ownerMatches",
        teamId: "teamMatches",
      } as const;
      expect(result[key[field]]).toBe(false);
      expect(result).not.toHaveProperty("authorized");
    },
  );
  it("accepts nullable inactive disabled metadata", async () => {
    expect(
      await fixture(Response.json({ ...metadata(), disabledAt: null, disabledReason: null })).run(),
    ).toMatchObject({ disabled: false, status: "observed" });
  });
  it("observes disabled and restricted configuration", async () => {
    expect(
      await fixture(
        Response.json({
          ...metadata(),
          disabledAt: 0,
          projectSelection: "selected",
          scopes: ["read:project"],
        }),
      ).run(),
    ).toMatchObject({
      allProjectsConfigured: false,
      disabled: true,
      projectWriteConfigured: false,
    });
  });
  it.each([
    "forbidden",
    "invalid_token",
    "integration_configuration_disabled",
    "private-provider-code",
  ])("redacts a denial with %s", async (code) => {
    const result = await fixture(
      Response.json(
        { error: { code, message: "private body token user headers URL" } },
        { status: 403 },
      ),
    ).run();
    expect(result).toEqual({
      failure: "provider_rejected",
      providerCode: code === "private-provider-code" ? "unknown" : code,
      status: "unavailable",
      statusCode: 403,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it.each([
    { ...metadata(), teamId: null },
    { ...metadata(), scopes: "read-write:project" },
    { ...metadata(), disabledAt: "invalid" },
    { ...metadata(), projectSelection: "unknown" },
  ])("rejects malformed configuration", async (value) => {
    expect(await fixture(Response.json(value)).run()).toEqual({
      failure: "invalid_response",
      status: "unavailable",
      statusCode: 200,
    });
  });
  it("bounds the response without exposing its content", async () => {
    expect(await fixture(new Response("private".repeat(20_000))).run()).toEqual({
      failure: "invalid_response",
      status: "unavailable",
      statusCode: 200,
    });
  });
  it("does not read credentials or fetch after cancellation", async () => {
    const f = fixture();
    f.controller.abort();
    expect(await f.run()).toEqual({ failure: "cancelled", status: "unavailable" });
    expect(f.input.readInstallationToken).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("cancels a pending body read and never observes authorization", async () => {
    const { promise: started, resolve: reading } = Promise.withResolvers<null>();
    const cancel = vi.fn();
    const f = fixture(
      new Response(
        new ReadableStream(
          {
            cancel,
            pull() {
              reading(null);
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    const result = f.run();
    await started;
    f.controller.abort();
    expect(await result).toEqual({ failure: "cancelled", status: "unavailable", statusCode: 200 });
    expect(cancel).toHaveBeenCalled();
  });
  it("sanitizes transport and credential failures", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error("private provider body"));
    expect(await f.run()).toEqual({ failure: "request_failed", status: "unavailable" });
    f.input.readInstallationToken.mockRejectedValue(new Error("private credential"));
    expect(await f.run()).toEqual({ failure: "request_failed", status: "unavailable" });
  });
});
