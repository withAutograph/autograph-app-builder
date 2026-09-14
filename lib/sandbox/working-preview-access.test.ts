import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";

import { describe, expect, it } from "vitest";
import { blockCrossSiteDEV } from "next/dist/server/lib/router-utils/block-cross-site-dev";

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
    app: Server;
    shutdown: () => void;
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
      `${access.source}\nserver.on("listening", () => process.stdout.write("ready")); process.stdin.on("data", () => server.close());`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
    const launch = new URL(access.launchUrl);
    await run({
      app,
      appPort,
      launch: launch.pathname + launch.search,
      observed,
      port,
      shutdown: () => {
        child.stdin.write("close");
      },
    });
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

const openUpgrade = async (
  port: number,
  headers: Record<string, string>,
  head = "",
  path = "/_next/webpack-hmr",
) => {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: preview.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${Object.entries(
      headers,
    )
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("")}\r\n${head}`,
  );
  return socket;
};
const untilText = async (socket: Socket, expected: string) => {
  let text = "";
  while (!text.includes(expected)) {
    // oxlint-disable-next-line no-await-in-loop -- Read consecutive chunks from one socket.
    const [chunk] = await once(socket, "data", { signal: AbortSignal.timeout(3000) });
    text += chunk.toString();
  }
  return text;
};
describe("working preview WebSocket upgrade", () => {
  it("rejects missing credentials and cross-origin upgrades before reaching the app", async () => {
    await withGateway(async ({ app, port, launch }) => {
      let upgrades = 0;
      app.on("upgrade", (_request, socket) => {
        upgrades += 1;
        socket.destroy();
      });
      const entry = await call(port, launch);
      const [cookie] = (entry.headers["set-cookie"]?.[0] ?? "").split(";");
      const attempts: Record<string, string>[] = [
        { origin: "https://preview.example" },
        { cookie, origin: "https://attacker.example" },
        { cookie },
      ];
      for (const headers of attempts) {
        // oxlint-disable-next-line no-await-in-loop -- Exercise isolated rejected handshakes sequentially.
        const socket = await openUpgrade(port, headers);
        try {
          // oxlint-disable-next-line no-await-in-loop -- Read the current rejected handshake.
          expect(await untilText(socket, "403")).toContain("403");
        } finally {
          socket.destroy();
        }
      }
      expect(upgrades).toBe(0);
    });
  });
  it.each(["expiry", "shutdown"])(
    "forwards authenticated duplex bytes and closes both peers on %s",
    async (boundary) => {
      await withGateway(
        async ({ app, port, launch, shutdown }) => {
          let observed: IncomingHttpHeaders | undefined;
          const peerClosed = Promise.withResolvers<null>();
          app.on("upgrade", (incoming, socket, head) => {
            observed = incoming.headers;
            socket.on("close", () => peerClosed.resolve(null));
            socket.on("end", () => socket.destroy());
            socket.on("error", () => {});
            socket.write(
              "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: __Host-autograph-preview=forged\r\n\r\nupstream-head",
            );
            if (head.length) {
              socket.write(head);
            }
            socket.on("data", (chunk) => socket.write(chunk));
          });
          const entry = await call(port, launch);
          const [cookie] = (entry.headers["set-cookie"]?.[0] ?? "").split(";");
          const socket = await openUpgrade(
            port,
            {
              authorization: "Bearer application-token",
              cookie: `${cookie}; app-session=abc`,
              origin: "https://preview.example",
              referer: `https://preview.example${launch}`,
              "x-vercel-oidc-token": "secret",
            },
            "client-head",
          );
          try {
            const response = await untilText(socket, "client-head");
            expect(response).toContain("101 Switching Protocols");
            expect(response).toContain("upstream-head");
            expect(response).not.toContain("forged");
            socket.write("duplex-message");
            expect(await untilText(socket, "duplex-message")).toContain("duplex-message");
            expect(observed).toMatchObject({
              authorization: "Bearer application-token",
              cookie: "app-session=abc",
              host: "preview.example",
            });
            expect(observed?.referer).toBeUndefined();
            expect(observed?.["x-vercel-oidc-token"]).toBeUndefined();
            const closed = once(socket, "close", { signal: AbortSignal.timeout(4000) });
            if (boundary === "shutdown") {
              shutdown();
            }
            await closed;
            await peerClosed.promise;
          } finally {
            socket.destroy();
          }
        },
        Date.now() + (boundary === "expiry" ? 1800 : 60_000),
      );
    },
  );
});

it.each(["/_next/hmr", "/apps/builder/_next/hmr"])(
  "authenticates then translates only Next HMR origin at %s",
  async (hmrPath) => {
    await withGateway(async ({ app, appPort, port, launch, observed }) => {
      const origins: (string | undefined)[] = [];
      app.on("upgrade", (incoming, socket) => {
        origins.push(incoming.headers.origin);
        socket.on("error", () => {});
        socket.on("end", () => socket.destroy());
        if (blockCrossSiteDEV(incoming, socket, undefined, "0.0.0.0")) {
          return;
        }
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\naccepted",
        );
      });
      const direct = await openUpgrade(appPort, { origin: "https://preview.example" }, "", hmrPath);
      try {
        expect(await untilText(direct, "Unauthorized")).toContain("Unauthorized");
      } finally {
        direct.destroy();
      }
      const entry = await call(port, launch);
      const [cookie] = (entry.headers["set-cookie"]?.[0] ?? "").split(";");
      const rejected = await openUpgrade(
        port,
        { cookie, origin: "https://foreign.example" },
        "",
        hmrPath,
      );
      try {
        expect(await untilText(rejected, "403")).toContain("403");
      } finally {
        rejected.destroy();
      }
      const stale = await openUpgrade(
        port,
        { cookie: "__Host-autograph-preview=stale", origin: "https://preview.example" },
        "",
        hmrPath,
      );
      try {
        expect(await untilText(stale, "403")).toContain("403");
      } finally {
        stale.destroy();
      }
      const allowed = await openUpgrade(
        port,
        { cookie, origin: "https://preview.example" },
        "",
        hmrPath,
      );
      try {
        expect(await untilText(allowed, "accepted")).toContain("101 Switching Protocols");
      } finally {
        allowed.destroy();
      }
      const application = await openUpgrade(
        port,
        { cookie, origin: "https://preview.example" },
        "",
        "/app/socket",
      );
      try {
        expect(await untilText(application, "accepted")).toContain("101 Switching Protocols");
      } finally {
        application.destroy();
      }
      expect(origins).toEqual([
        "https://preview.example",
        `http://localhost:${appPort}`,
        "https://preview.example",
      ]);
      await call(port, "/api/data", { cookie, origin: "https://preview.example" });
      expect(observed[0].headers.origin).toBe("https://preview.example");
    });
  },
);
