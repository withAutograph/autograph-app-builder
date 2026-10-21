import { APIError, Sandbox } from "@vercel/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedOperatorSandboxFetch } from "./hosted-operator-sandbox-fetch";

const management =
  "https://vercel.com/api/v2/sandboxes/owned-name?projectId=builder&resume=true&teamId=team";
const requestUrl = (input: Parameters<typeof fetch>[0] | undefined): string => {
  if (input === undefined) {
    throw new Error("Missing controlled fetch input");
  }
  if (input instanceof Request) {
    return input.url;
  }
  return input instanceof URL ? input.href : input;
};
const response = () => Response.json({ ok: true });
const tokenFor = (project: string) =>
  [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        owner_id: "team",
        project_id: project,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url"),
    "synthetic-signature",
  ].join(".");
const resumed = () =>
  Response.json({
    sandbox: {
      name: "owned-name",
      persistent: true,
      status: "running",
      currentSessionId: "owned-session",
      createdAt: 1,
      updatedAt: 1,
    },
    session: {
      id: "owned-session",
      memory: 1024,
      vcpus: 1,
      region: "iad1",
      timeout: 60_000,
      status: "running",
      requestedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/workspace",
    },
    routes: [],
    resumed: true,
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request-owned Sandbox management fetch", () => {
  it("pins the verified bearer and retains the original URL and unrelated headers/options", async () => {
    const raw = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const token = vi.fn(() => "verified-builder");
    const adapted = createHostedOperatorSandboxFetch(token, raw);
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>();
    const dispatcher = { owned: true };
    const init: RequestInit & { dispatcher: typeof dispatcher; duplex: "half" } = {
      method: "POST",
      headers: { AUTHORIZATION: "ambient-operator", "x-existing": "retained" },
      body,
      signal: controller.signal,
      dispatcher,
      duplex: "half",
      redirect: "follow",
    };
    await adapted(management, init);
    expect(raw).toHaveBeenCalledOnce();
    expect(raw.mock.calls[0]?.[0]).toBe(management);
    const forwarded = raw.mock.calls[0]?.[1];
    expect(forwarded).toMatchObject({
      method: "POST",
      body,
      signal: controller.signal,
      dispatcher,
      duplex: "half",
      redirect: "manual",
    });
    expect(new Headers(forwarded?.headers).get("authorization")).toBe("Bearer verified-builder");
    expect(new Headers(forwarded?.headers).get("x-existing")).toBe("retained");
    expect(init.headers).toEqual({ AUTHORIZATION: "ambient-operator", "x-existing": "retained" });
    expect(body.locked).toBe(false);
    expect(token).toHaveBeenCalledOnce();
  });

  it("preserves Request identity/body/signal and native init header replacement semantics", async () => {
    const raw = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const adapted = createHostedOperatorSandboxFetch(() => "verified-builder", raw);
    const request = new Request(management, {
      method: "POST",
      body: "unchanged",
      headers: { "x-request": "original", authorization: "ambient" },
    });
    await adapted(request);
    expect(raw.mock.calls[0]?.[0]).toBe(request);
    expect(new Headers(raw.mock.calls[0]?.[1]?.headers).get("x-request")).toBe("original");
    expect(request.bodyUsed).toBe(false);
    const replacement = new Headers({ "x-init": "replacement" });
    await adapted(request, { headers: replacement });
    const forwarded = new Headers(raw.mock.calls[1]?.[1]?.headers);
    expect(forwarded.get("x-request")).toBeNull();
    expect(forwarded.get("x-init")).toBe("replacement");
    expect(forwarded.get("authorization")).toBe("Bearer verified-builder");
    expect(replacement.has("authorization")).toBe(false);
    expect(request.headers.get("authorization")).toBe("ambient");
    expect(request.bodyUsed).toBe(false);
    expect(raw.mock.calls[1]?.[0]).toBe(request);
  });

  it.each([
    "https://vercel.com/api/v2/sandboxes",
    "https://vercel.com/api/v2/sandboxes/sessions/session/cmd",
    "https://vercel.com/api/v2/sandboxes/sessions/session/fs/read",
  ])("covers the supported management namespace %s", async (url) => {
    const raw = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const input = new URL(url);
    await createHostedOperatorSandboxFetch(() => "verified-builder", raw)(input);
    expect(raw.mock.calls[0]?.[0]).toBe(input);
    expect(new Headers(raw.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer verified-builder",
    );
  });

  it.each([
    "https://foreign.test/api/v2/sandboxes/owned-name",
    "https://vercel.com.evil.test/api/v2/sandboxes/owned-name",
    // oxlint-disable-next-line sonarjs/no-clear-text-protocols -- This rejected destination proves HTTP never receives the verified carrier.
    "http://vercel.com/api/v2/sandboxes/owned-name",
    "https://vercel.com/api/v2/sandboxes-other/owned-name",
    "https://vercel.com/api/v2/sandboxes%2Fowned-name",
    "https://vercel.com/api/v3/sandboxes",
    "https://vercel.com/api/v2/drives/drive",
    "https://user:password@vercel.com/api/v2/sandboxes/owned-name",
    "https://download.test/file?signed=synthetic",
    "https://runtime.test/interactive",
    "wss://runtime.test/interactive",
    "/relative-input",
  ])("leaves foreign or unsupported destinations unchanged: %s", async (input) => {
    const raw = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const token = vi.fn(() => "verified-builder");
    const init = {
      headers: { authorization: "original-destination-credential" },
      redirect: "follow" as const,
    };
    await createHostedOperatorSandboxFetch(token, raw)(input, init);
    expect(raw.mock.calls[0]).toEqual([input, init]);
    expect(raw.mock.calls[0]?.[1]).toBe(init);
    expect(token).not.toHaveBeenCalled();
  });

  it("keeps concurrent request workloads isolated and resolves only their own live carrier", async () => {
    const raw = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    let first = "first-builder";
    const a = createHostedOperatorSandboxFetch(() => first, raw);
    const b = createHostedOperatorSandboxFetch(() => "second-builder", raw);
    await Promise.all([a(management), b(management)]);
    first = "first-builder-next";
    await a(management);
    expect(
      raw.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")),
    ).toEqual(["Bearer first-builder", "Bearer second-builder", "Bearer first-builder-next"]);
  });

  it("does not follow redirects and preserves fetch rejection and cancellation identity", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "https://foreign.test/target" },
    });
    const raw = vi.fn<typeof fetch>(() => Promise.resolve(redirect));
    const adapted = createHostedOperatorSandboxFetch(() => "verified-builder", raw);
    expect(await adapted(management)).toBe(redirect);
    expect(raw.mock.calls[0]?.[1]?.redirect).toBe("manual");
    const controller = new AbortController();
    const cancellation = new Error("controlled cancellation");
    controller.abort(cancellation);
    raw.mockRejectedValueOnce(cancellation);
    await expect(adapted(management, { signal: controller.signal })).rejects.toBe(cancellation);
    expect(raw.mock.calls[1]?.[1]?.signal).toBe(controller.signal);
  });

  it("pins the verified Builder token after the installed SDK's ambient refresh and retains child file I/O", async () => {
    const builder = tokenFor("builder");
    const operator = tokenFor("operator");
    vi.stubEnv("VERCEL_OIDC_TOKEN", operator);
    const raw = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        requestUrl(input).includes("/fs/read")
          ? new Response("owned bytes", { headers: { "content-type": "application/octet-stream" } })
          : resumed(),
      ),
    );
    const controller = new AbortController();
    // The same SDK call without the adapter demonstrates its supported pre-fetch replacement.
    await Sandbox.get({
      name: "owned-name",
      resume: true,
      projectId: "builder",
      teamId: "team",
      token: builder,
      fetch: raw,
      signal: controller.signal,
    });
    expect(new Headers(raw.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${operator}`,
    );
    raw.mockClear();
    const sandbox = await Sandbox.get({
      name: "owned-name",
      resume: true,
      projectId: "builder",
      teamId: "team",
      token: builder,
      fetch: createHostedOperatorSandboxFetch(() => builder, raw),
      signal: controller.signal,
    });
    expect(sandbox.name).toBe("owned-name");
    const url = new URL(requestUrl(raw.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/v2/sandboxes/owned-name");
    expect(url.searchParams.get("projectId")).toBe("builder");
    expect(url.searchParams.get("teamId")).toBe("team");
    expect(url.searchParams.get("resume")).toBe("true");
    expect(raw.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(await sandbox.readFileToBuffer({ path: "/workspace/existing.txt" })).toEqual(
      Buffer.from("owned bytes"),
    );
    expect(raw).toHaveBeenCalledTimes(2);
    expect(
      raw.mock.calls.every(
        ([, init]) =>
          new Headers(init?.headers).get("authorization") === `Bearer ${builder}` &&
          init?.redirect === "manual",
      ),
    ).toBe(true);
  });

  it("lets the installed SDK surface management redirects as its original APIError status", async () => {
    const raw = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, { status: 307, headers: { location: "https://foreign.test/target" } }),
      ),
    );
    const result = Sandbox.get({
      name: "owned-name",
      resume: true,
      projectId: "builder",
      teamId: "team",
      token: "synthetic-builder",
      fetch: createHostedOperatorSandboxFetch(() => "synthetic-builder", raw),
    });
    await expect(result).rejects.toBeInstanceOf(APIError);
    await expect(result).rejects.toMatchObject({ response: { status: 307 } });
    expect(raw).toHaveBeenCalledOnce();
  });
});
