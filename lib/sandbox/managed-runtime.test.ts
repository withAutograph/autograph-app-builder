/* oxlint-disable promise/avoid-new -- Focused owned child/socket fixtures adapt Node events; no provider or application fixture is used. */
import { createServer, request as httpRequest } from "node:http";
import type { Server, IncomingHttpHeaders } from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { Socket } from "node:net";
import {
  createPrivateManagedRuntimeCapabilities,
  managedRuntimePublicProfileSchema,
  readManagedRuntimePublicProfile,
  verifyManagedCapability,
} from "./managed-runtime-capabilities";
import type { ManagedRuntimeIdentity, ManagedRuntimeCurrent } from "./managed-runtime-capabilities";
import {
  createManagedOwnedChildLauncher,
  createManagedRuntimeSupervisor,
  managedLifecycleCommandSchema,
} from "./managed-runtime-supervisor";
import { startManagedRuntimeIpc, createManagedRuntimeIpcClient } from "./managed-runtime-ipc";
import { createManagedRuntimeBridge } from "./managed-runtime-bridge";
import type { ManagedGatewayVerificationAdapter } from "./managed-runtime-bridge";

const identity: ManagedRuntimeIdentity = {
  intentId: "10000000-0000-4000-8000-000000000001",
  approvalRef: "approved-suite",
  owner: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
    sessionId: "saved-session",
  },
  appId: "orchard",
  runtimeAttemptId: "20000000-0000-4000-8000-000000000002",
  fence: 1,
  sandboxId: "owned-sandbox",
  providerSessionId: "owned-provider-session",
};
const publicOrigin = "https://gateway.example";
const keys = generateKeyPairSync("ed25519");
const profile = managedRuntimePublicProfileSchema.parse({
  version: 1,
  appId: identity.appId,
  publicOrigin,
  jwksUrl: `${publicOrigin}/_platform/jwks.json`,
  keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "key-one", alg: "EdDSA", use: "sig" }],
});
const listen = async (server: Server) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z.object({ port: z.number().int().positive() }).parse(server.address());
  return address.port;
};
const closeServer = async (server: Server) => {
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
};
const exchange = async (input: {
  port: number;
  method?: string;
  target?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}) =>
  await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.target ?? "/",
        method: input.method ?? "GET",
        headers: input.headers,
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part) => {
          parts.push(Buffer.from(z.instanceof(Uint8Array).parse(part)));
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts) });
        });
      },
    );
    request.once("error", reject);
    request.end(input.body);
  });

test("public profiles contain only exact Gateway public keys and capabilities have separate custody", async () => {
  const capabilities = createPrivateManagedRuntimeCapabilities();
  expect(
    verifyManagedCapability(
      capabilities.private.transport,
      capabilities.projection.transportSha256,
    ),
  ).toBe(true);
  expect(
    verifyManagedCapability(
      capabilities.private.suiteSelector,
      capabilities.projection.transportSha256,
    ),
  ).toBe(false);
  expect(
    verifyManagedCapability(
      capabilities.private.lifecycle,
      capabilities.projection.transportSha256,
    ),
  ).toBe(false);
  expect(verifyManagedCapability("untrusted", capabilities.lifecycleSha256)).toBe(false);
  const loaded = await readManagedRuntimePublicProfile({
    appId: identity.appId,
    publicOrigin,
    readPublicJwks: async (url) => {
      expect(url).toBe(profile.jwksUrl);
      return await Promise.resolve({ keys: profile.keys });
    },
  });
  expect(loaded).toEqual(profile);
  expect(
    managedRuntimePublicProfileSchema.safeParse({
      ...profile,
      keys: [{ ...profile.keys[0], d: "private-key-must-not-cross" }],
    }).success,
  ).toBe(false);
  expect(
    managedRuntimePublicProfileSchema.safeParse({
      ...profile,
      jwksUrl: "https://foreign.example/keys",
    }).success,
  ).toBe(false);
});

const processFixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "managed-owned-process-"));
  const script = path.join(directory, "app.mjs");
  const observation = path.join(directory, "app-observation.json");
  const source = (revision: string) =>
    `import {writeFileSync} from 'node:fs';writeFileSync(process.env.OBSERVATION_FILE,JSON.stringify({pid:process.pid,value:process.env.APP_FIXTURE_VALUE,revision:${JSON.stringify(revision)},ambient:process.env.MANAGED_HOST_ONLY_SENTINEL}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  await writeFile(script, source("one"));
  const environment = {
    APP_FIXTURE_VALUE: "same-approved-environment",
    OBSERVATION_FILE: observation,
  };
  const launch = createManagedOwnedChildLauncher({
    executable: process.execPath,
    args: [script],
    cwd: directory,
    appEnvironment: environment,
    stopTimeoutMs: 500,
  });
  const owner = new AbortController();
  let authorized = true;
  const supervisor = createManagedRuntimeSupervisor({
    identity,
    expiresAt: Date.now() + 60_000,
    ownershipSignal: owner.signal,
    assertCurrent: async () => {
      await Promise.resolve();
      if (!authorized) {
        throw new Error("owned fence changed");
      }
    },
    launchSameEnvironment: launch,
    observeReadiness: async ({ pid }) => {
      await vi.waitFor(
        async () => {
          const raw: unknown = JSON.parse(await readFile(observation, "utf-8"));
          expect(z.object({ pid: z.number() }).parse(raw).pid).toBe(pid);
        },
        { timeout: 2000, interval: 10 },
      );
      return true;
    },
  });
  return {
    supervisor,
    owner,
    environment,
    observation,
    script,
    source,
    loseOwnership: () => {
      authorized = false;
    },
    close: async () => {
      await supervisor.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("owned process replacement retains launch environment and idempotent command observations through ordinary source changes", async () => {
  const f = await processFixture();
  try {
    const commandId = randomUUID();
    const [first, retry] = await Promise.all([
      f.supervisor.execute({ operation: "start-same-environment", commandId }),
      f.supervisor.execute({ operation: "start-same-environment", commandId }),
    ]);
    expect(first).toEqual(retry);
    expect(first.process?.generation).toBe(1);
    await f.supervisor.execute({ operation: "observe-readiness", commandId: randomUUID() });
    const stopped = await f.supervisor.execute({
      operation: "stop-and-wait",
      commandId: randomUUID(),
    });
    expect(stopped.process?.exit?.observedAt).toBeDefined();
    expect(stopped.state).toBe("stopped");
    f.environment.APP_FIXTURE_VALUE = "caller-mutated-after-capture";
    await writeFile(f.script, f.source("two"));
    const next = await f.supervisor.execute({
      operation: "start-same-environment",
      commandId: randomUUID(),
    });
    expect(next.process?.generation).toBe(2);
    const ready = await f.supervisor.execute({
      operation: "observe-readiness",
      commandId: randomUUID(),
    });
    expect(ready.state).toBe("ready");
    const raw: unknown = JSON.parse(await readFile(f.observation, "utf-8"));
    expect(raw).toMatchObject({
      value: "same-approved-environment",
      revision: "two",
      pid: ready.process?.pid,
    });
    await expect(f.supervisor.execute({ operation: "stop-and-wait", commandId })).rejects.toThrow();
    const current = await f.supervisor.execute({ operation: "status" });
    expect(current.process?.generation).toBe(2);
    expect(current.state).toBe("ready");
  } finally {
    await f.close();
  }
});

test("owned wrapper replacement waits for its TERM-resistant server descendant and reuses the same port", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "managed-owned-wrapper-"));
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  const wrapper = path.join(directory, "wrapper.mjs");
  const server = path.join(directory, "server.mjs");
  const observation = path.join(directory, "generation.json");
  await writeFile(
    server,
    `import{createServer}from'node:http';import{readFileSync,writeFileSync}from'node:fs';let generation=1;try{generation=JSON.parse(readFileSync(process.env.OBSERVATION_FILE,'utf8')).generation+1}catch{};process.on('SIGTERM',()=>{});createServer((req,res)=>res.end(JSON.stringify({generation,pid:process.pid}))).listen(Number(process.env.APP_PORT),'127.0.0.1',()=>writeFileSync(process.env.OBSERVATION_FILE,JSON.stringify({generation,pid:process.pid})));`,
  );
  await writeFile(
    wrapper,
    `import{spawn}from'node:child_process';spawn(process.execPath,[process.env.SERVER_FILE],{stdio:'ignore',env:process.env});setInterval(()=>{},1000);`,
  );
  const supervisor = createManagedRuntimeSupervisor({
    identity,
    expiresAt: Date.now() + 60_000,
    ownershipSignal: new AbortController().signal,
    assertCurrent: async () => {
      await Promise.resolve();
    },
    launchSameEnvironment: createManagedOwnedChildLauncher({
      executable: process.execPath,
      args: [wrapper],
      cwd: directory,
      appEnvironment: {
        SERVER_FILE: server,
        APP_PORT: String(port),
        OBSERVATION_FILE: observation,
      },
      stopTimeoutMs: 250,
    }),
    observeReadiness: async ({ generation }) => {
      await vi.waitFor(
        async () => {
          const response = await exchange({ port });
          expect(JSON.parse(response.body.toString())).toMatchObject({ generation });
        },
        { timeout: 2000, interval: 25 },
      );
      return true;
    },
  });
  try {
    await supervisor.execute({ operation: "start-same-environment", commandId: randomUUID() });
    await supervisor.execute({ operation: "observe-readiness", commandId: randomUUID() });
    const before = z
      .object({ generation: z.number(), pid: z.number() })
      .parse(JSON.parse(await readFile(observation, "utf-8")));
    const stopped = await supervisor.execute({
      operation: "stop-and-wait",
      commandId: randomUUID(),
    });
    expect(stopped.state).toBe("stopped");
    expect(() => process.kill(before.pid, 0)).toThrow();
    await expect(exchange({ port })).rejects.toThrow();
    await supervisor.execute({ operation: "start-same-environment", commandId: randomUUID() });
    const ready = await supervisor.execute({
      operation: "observe-readiness",
      commandId: randomUUID(),
    });
    expect(ready.state).toBe("ready");
    const response = await exchange({ port });
    expect(JSON.parse(response.body.toString())).toMatchObject({ generation: 2 });
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("private IPC requires its own capability, rejects arbitrary lifecycle inputs and reuses the same command acknowledgement", async () => {
  const f = await processFixture();
  const capabilities = createPrivateManagedRuntimeCapabilities();
  const ipc = await startManagedRuntimeIpc({
    supervisor: f.supervisor,
    lifecycleSha256: capabilities.lifecycleSha256,
  });
  try {
    const socketInfo = await stat(ipc.socketPath);
    // oxlint-disable-next-line eslint/no-bitwise -- This mask observes the actual Unix socket permission boundary.
    const mode = socketInfo.mode & 0o777;
    expect(mode).toBe(0o600);
    const invalid = createManagedRuntimeIpcClient({
      socketPath: ipc.socketPath,
      lifecycleCapability: capabilities.private.suiteSelector,
    });
    await expect(
      invalid.execute({ operation: "start-same-environment", commandId: randomUUID() }),
    ).rejects.toThrow();
    const client = createManagedRuntimeIpcClient({
      socketPath: ipc.socketPath,
      lifecycleCapability: capabilities.private.lifecycle,
    });
    const commandId = randomUUID();
    const first = await client.execute({ operation: "start-same-environment", commandId });
    expect(await client.execute({ operation: "start-same-environment", commandId })).toEqual(first);
    expect(
      managedLifecycleCommandSchema.safeParse({
        operation: "stop-and-wait",
        commandId: randomUUID(),
        pid: 1,
      }).success,
    ).toBe(false);
    expect(
      managedLifecycleCommandSchema.safeParse({
        operation: "start-same-environment",
        commandId: randomUUID(),
        env: { ARBITRARY: "value" },
      }).success,
    ).toBe(false);
    f.owner.abort();
    await expect(client.execute({ operation: "status" })).rejects.toThrow();
  } finally {
    await ipc.close();
    await f.close();
  }
});

test("lost ownership refuses further lifecycle effects and a closed supervisor cannot relaunch", async () => {
  const f = await processFixture();
  try {
    await f.supervisor.execute({ operation: "start-same-environment", commandId: randomUUID() });
    f.loseOwnership();
    await expect(
      f.supervisor.execute({ operation: "start-same-environment", commandId: randomUUID() }),
    ).rejects.toThrow();
    await f.supervisor.close();
    await expect(
      f.supervisor.execute({ operation: "start-same-environment", commandId: randomUUID() }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

const statusOf = async (response: Promise<{ status: number }>) => {
  const result = await response;
  return result.status;
};

const bridgeFixture = async () => {
  const capabilities = createPrivateManagedRuntimeCapabilities();
  const received: {
    headers: IncomingHttpHeaders;
    body: Buffer;
    method: string;
    target: string;
  }[] = [];
  const app = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of request) {
        parts.push(Buffer.from(z.instanceof(Uint8Array).parse(part)));
      }
      received.push({
        headers: request.headers,
        body: Buffer.concat(parts),
        method: request.method ?? "",
        target: request.url ?? "",
      });
      response.end("app-response");
    })();
  });
  app.on("upgrade", (upgradeRequest, socket, head) => {
    received.push({
      headers: upgradeRequest.headers,
      body: Buffer.from(head),
      method: upgradeRequest.method ?? "",
      target: upgradeRequest.url ?? "",
    });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("end", () => {
      socket.destroy();
    });
    socket.on("data", (bytes) => {
      socket.write(bytes);
    });
  });
  const appPort = await listen(app);
  const owner = new AbortController();
  const current: ManagedRuntimeCurrent = {
    ...identity,
    state: "ready",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  // Controlled verifier port: Arrusted owns real principal cryptography and actor/body authorization; this fixture exercises mandatory acceptance/rejection and unchanged input transport.
  const verifyRequest = vi.fn(
    async (input: {
      headers: Headers;
      method: string;
      target: string;
      body?: Uint8Array;
      actors: readonly { actorId: string; organizationId: string }[];
      verification: { appId: string };
    }) => {
      await Promise.resolve();
      if (input.headers.get("x-platform-principal") !== "controlled-valid-principal") {
        throw new Error("principal denied");
      }
      return { sub: "approved-actor" };
    },
  );
  const adapter: ManagedGatewayVerificationAdapter<{ appId: string }> = {
    createVerification: ({ profile: selectedProfile }) => ({ appId: selectedProfile.appId }),
    verifyRequest,
  };
  const bridge = createManagedRuntimeBridge({
    identity,
    profile,
    transportSha256: capabilities.projection.transportSha256,
    actors: [{ actorId: "approved-actor", organizationId: "approved-org" }],
    appPort,
    expiresAt: Date.now() + 60_000,
    ownershipSignal: owner.signal,
    readCurrent: async () => await Promise.resolve(current),
    verification: adapter,
  });
  const port = await listen(bridge.server);
  return {
    bridge,
    app,
    port,
    capabilities,
    current,
    owner,
    received,
    verifyRequest,
    close: async () => {
      await bridge.close();
      await closeServer(app);
    },
  };
};

test("bridge forwards exact entity bytes, method and target only after transport, ownership and principal verification", async () => {
  const f = await bridgeFixture();
  try {
    const body = Buffer.from('{"content":"租户😀"}\n');
    const response = await exchange({
      port: f.port,
      method: "POST",
      target: "/orchard/action?token=ordinary-business",
      body,
      headers: {
        authorization: `Bearer ${f.capabilities.private.transport}`,
        "x-platform-principal": "controlled-valid-principal",
        "x-platform-managed-suite": f.capabilities.private.suiteSelector,
        "x-vercel-oidc-token": "must-not-reach-app",
        "x-vercel-trusted-oidc-idp-token": "must-not-reach-app-either",
        "x-forwarded-host": "forged.example",
        "content-length": String(body.length),
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("app-response");
    const observed = f.received.at(0);
    expect(observed?.body).toEqual(body);
    expect(observed?.method).toBe("POST");
    expect(observed?.target).toBe("/orchard/action?token=ordinary-business");
    expect(observed?.headers).toMatchObject({
      host: "gateway.example",
      "x-forwarded-host": "gateway.example",
      "x-forwarded-proto": "https",
      "x-platform-principal": "controlled-valid-principal",
    });
    expect(observed?.headers.authorization).toBeUndefined();
    expect(observed?.headers["x-platform-managed-suite"]).toBeUndefined();
    expect(observed?.headers["x-vercel-oidc-token"]).toBeUndefined();
    expect(observed?.headers["x-vercel-trusted-oidc-idp-token"]).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("bridge rejects wrong capability, verifier denial, foreign runtime scope and revoked/expired leases without forwarding", async () => {
  const f = await bridgeFixture();
  try {
    const headers = {
      authorization: `Bearer ${f.capabilities.private.transport}`,
      "x-platform-principal": "controlled-valid-principal",
    };
    expect(
      await statusOf(
        exchange({
          port: f.port,
          headers: { ...headers, authorization: `Bearer ${f.capabilities.private.suiteSelector}` },
        }),
      ),
    ).toBe(403);
    expect(
      await statusOf(
        exchange({
          port: f.port,
          headers: { ...headers, "x-platform-principal": "denied" },
        }),
      ),
    ).toBe(403);
    f.current.fence = 2;
    expect(await statusOf(exchange({ port: f.port, headers }))).toBe(403);
    f.current.fence = 1;
    f.current.state = "revoked";
    expect(await statusOf(exchange({ port: f.port, headers }))).toBe(403);
    f.current.state = "ready";
    f.current.leaseExpiresAt = new Date(0).toISOString();
    expect(await statusOf(exchange({ port: f.port, headers }))).toBe(403);
    expect(f.received).toEqual([]);
  } finally {
    await f.close();
  }
});

test("owner revocation closes an incomplete authorized HTTP entity and awaits actual listener close", async () => {
  const f = await bridgeFixture();
  const accepted = new Promise<void>((resolve) => {
    f.bridge.server.once("request", () => {
      resolve();
    });
  });
  let listenerClosed = false;
  f.bridge.server.once("close", () => {
    listenerClosed = true;
  });
  const pending = httpRequest({
    hostname: "127.0.0.1",
    port: f.port,
    method: "POST",
    path: "/orchard/action",
    headers: {
      authorization: `Bearer ${f.capabilities.private.transport}`,
      "x-platform-principal": "controlled-valid-principal",
      "content-length": "1000",
    },
  });
  const clientClosed = new Promise<void>((resolve) => {
    pending.once("close", () => {
      resolve();
    });
  });
  pending.on("error", () => {
    /* Revocation intentionally aborts this owned incomplete request. */
  });
  try {
    pending.write("incomplete");
    await accepted;
    f.owner.abort();
    await Promise.all([f.bridge.close(), f.bridge.close(), clientClosed]);
    expect(listenerClosed).toBe(true);
    expect(f.bridge.server.listening).toBe(false);
    expect(f.received).toEqual([]);
    expect(f.verifyRequest).not.toHaveBeenCalled();
  } finally {
    pending.destroy();
    await f.close();
  }
});

test("bridge preserves authorized upgrade bytes and revocation closes its owned tunnel", async () => {
  const f = await bridgeFixture();
  try {
    const tunnel = await new Promise<Socket>((resolve, reject) => {
      const upgrade = httpRequest({
        hostname: "127.0.0.1",
        port: f.port,
        path: "/orchard/live?view=history",
        headers: {
          authorization: `Bearer ${f.capabilities.private.transport}`,
          "x-platform-principal": "controlled-valid-principal",
          "x-platform-managed-suite": f.capabilities.private.suiteSelector,
          connection: "Upgrade",
          upgrade: "websocket",
        },
      });
      upgrade.once("upgrade", (_response, socket) => {
        resolve(socket);
      });
      upgrade.once("error", reject);
      upgrade.end();
    });
    try {
      const echoed = new Promise<Buffer>((resolve, reject) => {
        tunnel.once("data", (bytes) => {
          resolve(Buffer.from(z.instanceof(Uint8Array).parse(bytes)));
        });
        tunnel.once("error", reject);
      });
      tunnel.write(Buffer.from([0, 255, 10, 13, 1]));
      expect(await echoed).toEqual(Buffer.from([0, 255, 10, 13, 1]));
      const upgraded = f.received.at(0);
      expect(upgraded?.target).toBe("/orchard/live?view=history");
      expect(upgraded?.headers.authorization).toBeUndefined();
      expect(upgraded?.headers["x-platform-managed-suite"]).toBeUndefined();
      const closed = new Promise<void>((resolve) => {
        tunnel.once("close", () => {
          resolve();
        });
      });
      f.owner.abort();
      await closed;
    } finally {
      tunnel.destroy();
    }
  } finally {
    await f.close();
  }
});

test("public verifier refresh stays owner-only and cannot change the selected app or Gateway", async () => {
  const f = await bridgeFixture();
  try {
    const replacement = structuredClone(profile);
    replacement.keys = profile.keys.map((key) => ({ ...key, kid: "explicit-owner-refresh" }));
    await f.bridge.replacePublicProfile(replacement);
    const success = await exchange({
      port: f.port,
      headers: {
        authorization: `Bearer ${f.capabilities.private.transport}`,
        "x-platform-principal": "controlled-valid-principal",
      },
    });
    expect(success.status).toBe(200);
    await expect(
      f.bridge.replacePublicProfile({ ...replacement, appId: "foreign-app" }),
    ).rejects.toThrow();
    await expect(
      f.bridge.replacePublicProfile({
        ...replacement,
        publicOrigin: "https://foreign.example",
        jwksUrl: "https://foreign.example/_platform/jwks.json",
      }),
    ).rejects.toThrow();
    f.current.state = "revoked";
    await expect(f.bridge.replacePublicProfile(profile)).rejects.toThrow();
  } finally {
    await f.close();
  }
});
