import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createWorkingPreviewAccess } from "./working-preview-access";

const listen = async (server: Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
};

const close = (server: Server): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- Adapt the Node server close callback.
  new Promise((resolve, reject) => {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node close has a callback API.
    server.close((error) => (error ? reject(error) : resolve()));
  });

const call = (port: number, path: string, headers: IncomingHttpHeaders = {}, method = "GET") =>
  // oxlint-disable-next-line promise/avoid-new -- Collect an actual Node HTTP response.
  new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = request(
      {
        headers: { host: "preview.example", ...headers },
        hostname: "127.0.0.1",
        method,
        path,
        port,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ body, headers: response.headers, status: response.statusCode ?? 0 }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(method === "POST" ? "action-payload" : undefined);
  });

const withGateway = async (
  run: (fixture: {
    appPort: number;
    port: number;
    launch: string;
    observed: { headers: IncomingHttpHeaders; url: string; body: string }[];
  }) => Promise<void>,
  expiresAt = Date.now() + 60_000,
  landingPath?: string,
  configurationPath?: string,
) => {
  const observed: { headers: IncomingHttpHeaders; url: string; body: string }[] = [];
  const app = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf-8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      observed.push({ body, headers: incoming.headers, url: incoming.url ?? "" });
      response.setHeader("set-cookie", [
        "app-session=abc; HttpOnly",
        "__Host-autograph-preview=forged; Path=/; Secure",
      ]);
      response.end("working-app");
    });
  });
  const appPort = await listen(app);
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const access = createWorkingPreviewAccess({
    appPort,
    configurationPath,
    expiresAt,
    gatewayPort: port,
    landingPath,
    origin: configurationPath ? "https://pending.invalid" : "https://preview.example",
  });
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${access.source}\nserver.on("listening", () => process.stdout.write("ready"));`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
    const launch = new URL(access.launchUrl);
    await run({ appPort, launch: launch.pathname + launch.search, observed, port });
  } finally {
    child.kill();
    await once(child, "exit");
    await close(app);
  }
};

describe("working preview access", () => {
  it("protects assets and actions and strips its credentials before proxying", async () => {
    await withGateway(async ({ port, launch, observed }) => {
      await expect(call(port, "/")).resolves.toMatchObject({ status: 403 });
      await expect(call(port, "/_next/static/app.js")).resolves.toMatchObject({ status: 403 });
      await expect(call(port, `${launch}wrong`)).resolves.toMatchObject({ status: 403 });
      await expect(
        call(port, "/api/mcp", { authorization: "Bearer application-token" }),
      ).resolves.toMatchObject({ status: 403 });
      const entry = await call(port, launch);
      expect(entry.status).toBe(303);
      expect(entry.headers.location).toBe("/");
      expect(entry.headers["referrer-policy"]).toBe("no-referrer");
      const cookie = entry.headers["set-cookie"]?.[0] ?? "";
      expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax; Expires=");
      const [session] = cookie.split(";");
      const headers = {
        authorization: "Bearer application-token",
        cookie: `${session}; app-session=xyz`,
        referer: `https://preview.example${launch}`,
        "x-vercel-oidc-token": "platform-identity",
        "x-vercel-protection-bypass": "platform-bypass",
        "x-vercel-set-bypass-cookie": "true",
      };
      const asset = await call(port, "/_next/static/app.js", headers);
      expect(asset.body).toBe("working-app");
      expect(asset.headers["set-cookie"]).toEqual(["app-session=abc; HttpOnly"]);
      await expect(
        call(port, "/action", { ...headers, origin: "https://preview.example" }, "POST"),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        call(port, "/action", { ...headers, origin: "https://attacker.example" }, "POST"),
      ).resolves.toMatchObject({ status: 403 });
      expect(observed).toHaveLength(2);
      expect(observed[1].body).toBe("action-payload");
      expect(observed[0].headers.cookie).toBe("app-session=xyz");
      expect(observed[0].headers.authorization).toBe("Bearer application-token");
      expect(observed[0].headers["x-vercel-oidc-token"]).toBeUndefined();
      expect(observed[0].headers["x-vercel-protection-bypass"]).toBeUndefined();
      expect(observed[0].headers["x-vercel-set-bypass-cookie"]).toBeUndefined();
      expect(observed[0].headers.referer).toBeUndefined();
      expect(JSON.stringify(observed)).not.toContain(session);
      expect(JSON.stringify(observed)).not.toContain("token=");
    });
  });

  it("lands on the generated application zone without leaking the launch credential", async () => {
    await withGateway(
      async ({ port, launch, observed }) => {
        const entry = await call(port, launch);
        expect(entry.headers.location).toBe("/apps/builder?tab=drafts");
        expect(observed).toEqual([]);
        const [cookie] = (entry.headers["set-cookie"]?.[0] ?? "").split(";");
        const result = await call(port, entry.headers.location ?? "", { cookie });
        expect(result.status).toBe(200);
        expect(observed[0].url).toBe("/apps/builder?tab=drafts");
      },
      Date.now() + 60_000,
      "/apps/builder?tab=drafts",
    );
  });

  it("denies access until valid runtime configuration activates the bound gateway", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "working-preview-access-"));
    const configurationPath = nodePath.join(directory, "access.json");
    try {
      await withGateway(
        async ({ appPort, port, launch, observed }) => {
          await expect(call(port, launch, { host: "pending.invalid" })).resolves.toMatchObject({
            status: 403,
          });
          await expect(call(port, "/")).resolves.toMatchObject({ status: 403 });
          const active = createWorkingPreviewAccess({
            appPort,
            expiresAt: Date.now() + 60_000,
            gatewayPort: port,
            landingPath: "/apps/builder",
            origin: "https://preview.example",
          });
          await writeFile(configurationPath, active.configuration);
          const url = new URL(active.launchUrl);
          const entry = await call(port, url.pathname + url.search);
          expect(entry.status).toBe(303);
          expect(entry.headers.location).toBe("/apps/builder");
          const [cookie] = (entry.headers["set-cookie"]?.[0] ?? "").split(";");
          await expect(call(port, "/apps/builder", { cookie })).resolves.toMatchObject({
            status: 200,
          });
          expect(observed).toHaveLength(1);
          await writeFile(
            configurationPath,
            JSON.stringify({ ...JSON.parse(active.configuration), expiresAt: Date.now() - 1 }),
          );
          await expect(call(port, "/apps/builder", { cookie })).resolves.toMatchObject({
            status: 403,
          });
          await writeFile(configurationPath, "{");
          await expect(call(port, "/apps/builder", { cookie })).resolves.toMatchObject({
            status: 403,
          });
          await writeFile(
            configurationPath,
            JSON.stringify({ ...JSON.parse(active.configuration), launchDigest: "invalid" }),
          );
          await expect(call(port, url.pathname + url.search)).resolves.toMatchObject({
            status: 403,
          });
          await rm(configurationPath);
          await expect(call(port, "/apps/builder", { cookie })).resolves.toMatchObject({
            status: 403,
          });
          expect(observed).toHaveLength(1);
        },
        Date.now() + 60_000,
        undefined,
        configurationPath,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("denies an expired launch capability", async () => {
    await withGateway(async ({ port, launch, observed }) => {
      await expect(call(port, launch)).resolves.toMatchObject({ status: 403 });
      expect(observed).toEqual([]);
    }, Date.now() - 1);
  });

  it("requires a distinct gateway, exact HTTPS origin, and unprivileged ports", () => {
    const input = {
      appPort: 3000,
      expiresAt: Date.now() + 60_000,
      gatewayPort: 3001,
      origin: "https://preview.example",
    };
    expect(() =>
      createWorkingPreviewAccess({ ...input, origin: "http://preview.example" }),
    ).toThrow();
    expect(() => createWorkingPreviewAccess({ ...input, gatewayPort: 3000 })).toThrow();
    expect(() => createWorkingPreviewAccess({ ...input, appPort: 80 })).toThrow();
    expect(() =>
      createWorkingPreviewAccess({ ...input, landingPath: "//attacker.example" }),
    ).toThrow();
    expect(() =>
      createWorkingPreviewAccess({ ...input, landingPath: "/__autograph_preview_launch" }),
    ).toThrow();
    const first = createWorkingPreviewAccess(input);
    expect(first.launchUrl).not.toBe(createWorkingPreviewAccess(input).launchUrl);
    expect(first.source).not.toContain(new URL(first.launchUrl).searchParams.get("token"));
  });
});
