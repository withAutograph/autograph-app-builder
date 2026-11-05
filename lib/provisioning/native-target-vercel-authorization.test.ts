import { describe, expect, it, vi } from "vitest";
import { inspectNativeTargetVercelAuthorization } from "./native-target-vercel-authorization";

const metadata = () => ({
  id: "icfg_expected",
  teamId: "team_expected",
  ownerId: "team_expected",
  scopes: ["read-write:project"],
  projectSelection: "all",
  arbitrary: "private extra metadata",
});
const fixture = (response: Response = Response.json(metadata())) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const controller = new AbortController();
  const readInstallationToken = vi.fn(() => Promise.resolve("private-installation-token"));
  const input = {
    expectedInstallationId: "icfg_expected",
    expectedTeamId: "team_expected",
    readInstallationToken,
    fetch,
    signal: controller.signal,
  };
  return { fetch, controller, input, run: () => inspectNativeTargetVercelAuthorization(input) };
};

describe("read-only installation authorization metadata", () => {
  it("uses only the scoped configuration GET and projects structural metadata", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      status: "observed",
      statusCode: 200,
      installationMatches: true,
      teamMatches: true,
      ownerMatches: true,
      projectWriteConfigured: true,
      allProjectsConfigured: true,
      disabled: false,
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
      method: "GET",
      headers: { authorization: "Bearer private-installation-token" },
      signal: f.controller.signal,
      redirect: "error",
    });
  });
  it.each(["id", "teamId", "ownerId"] as const)(
    "exposes %s mismatch without granting permission",
    async (field) => {
      const result = await fixture(Response.json({ ...metadata(), [field]: "different" })).run();
      expect(result.status).toBe("observed");
      const key = {
        id: "installationMatches",
        teamId: "teamMatches",
        ownerId: "ownerMatches",
      } as const;
      expect(result[key[field]]).toBe(false);
      expect(result).not.toHaveProperty("authorized");
    },
  );
  it("accepts nullable inactive disabled metadata", async () => {
    expect(
      await fixture(Response.json({ ...metadata(), disabledAt: null, disabledReason: null })).run(),
    ).toMatchObject({ status: "observed", disabled: false });
  });
  it("observes disabled and restricted configuration", async () => {
    expect(
      await fixture(
        Response.json({
          ...metadata(),
          disabledAt: 0,
          scopes: ["read:project"],
          projectSelection: "selected",
        }),
      ).run(),
    ).toMatchObject({
      disabled: true,
      projectWriteConfigured: false,
      allProjectsConfigured: false,
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
      status: "unavailable",
      failure: "provider_rejected",
      statusCode: 403,
      providerCode: code === "private-provider-code" ? "unknown" : code,
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
      status: "unavailable",
      failure: "invalid_response",
      statusCode: 200,
    });
  });
  it("bounds the response without exposing its content", async () => {
    expect(await fixture(new Response("private".repeat(20_000))).run()).toEqual({
      status: "unavailable",
      failure: "invalid_response",
      statusCode: 200,
    });
  });
  it("does not read credentials or fetch after cancellation", async () => {
    const f = fixture();
    f.controller.abort();
    expect(await f.run()).toEqual({ status: "unavailable", failure: "cancelled" });
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
            pull() {
              reading(null);
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    const result = f.run();
    await started;
    f.controller.abort();
    expect(await result).toEqual({ status: "unavailable", failure: "cancelled", statusCode: 200 });
    expect(cancel).toHaveBeenCalled();
  });
  it("sanitizes transport and credential failures", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error("private provider body"));
    expect(await f.run()).toEqual({ status: "unavailable", failure: "request_failed" });
    f.input.readInstallationToken.mockRejectedValue(new Error("private credential"));
    expect(await f.run()).toEqual({ status: "unavailable", failure: "request_failed" });
  });
});
