/* oxlint-disable promise/avoid-new -- Controlled listeners and owned child completion expose Node event-to-Promise interfaces. */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { createPrivateManagedRuntimeCapabilities } from "../sandbox/managed-runtime-capabilities";
import { createManagedOwnedChildLauncher } from "../sandbox/managed-runtime-supervisor";
import { createManagedRuntimeIpcClient } from "../sandbox/managed-runtime-ipc";
import { managedRuntimeEntryInputSchema, managedRuntimeReadySchema } from "./managed-runtime-entry";

// oxlint-disable-next-line typescript/strict-void-return -- Node execFile intentionally returns a child handle in addition to its documented completion callback.
const executeFile = promisify(execFile);
// This cross-repository assembly acceptance is explicitly opt-in. Normal Builder
// CI does not acquire another repository, install tools or manufacture a verifier.
const arrustedRoot = process.env.ARRUSTED_MANAGED_RUNTIME_TEST_ROOT;
const availablePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = z.object({ port: z.number().int().positive() }).parse(server.address());
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return port;
};
const exchange = async (port: number, token: string, transport: string, body: Buffer) =>
  await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/orchard/action?view=one",
        headers: {
          authorization: `Bearer ${transport}`,
          "x-platform-principal": token,
          "x-platform-managed-suite": "must-not-reach-app",
          "x-vercel-oidc-token": "controlled-transport-secret",
          "x-vercel-trusted-oidc-idp-token": "controlled-transport-secret-two",
          "content-length": String(body.length),
        },
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
    outgoing.once("error", reject);
    outgoing.end(body);
  });
const observationSchema = z.object({
  generation: z.number().int().positive(),
  pid: z.number().int().positive(),
  method: z.string(),
  target: z.string(),
  body: z.string(),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  environment: z.record(z.string(), z.string()),
  argv: z.array(z.string()),
});
const readJson = async <T>(file: string, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(JSON.parse(await readFile(file, "utf-8")));
const awaitFile = async (file: string, closed: Promise<unknown>) => {
  const deadline = Date.now() + 10_000;
  let workerClosed = false;
  void (async () => {
    await closed;
    workerClosed = true;
  })();
  const isWorkerClosed = () => workerClosed;
  while (Date.now() < deadline && !isWorkerClosed()) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Readiness is a sequential observation of one owned worker.
      await access(file);
      return;
    } catch {
      /* The owned worker has not published readiness yet. */
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Await one owned local worker's readiness, without provider or remote polling.
    await delay(25);
  }
  throw new Error("Controlled compiled worker did not become ready.");
};

test.skipIf(arrustedRoot === undefined || arrustedRoot.length === 0)(
  "compiled managed entry unlinks private input, verifies real principals and replaces only its owned app process",
  async () => {
    const selectedArrustedRoot = z.string().min(1).parse(arrustedRoot);
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "me-")));
    const executable = path.join(directory, "managed-runtime");
    const inputFile = path.join(directory, "runtime-input.json");
    const bin = path.join(directory, "bin");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(bin);
    const bun = process.env.BUN_BINARY ?? "bun";
    const target = `bun-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
    let owned: Awaited<ReturnType<ReturnType<typeof createManagedOwnedChildLauncher>>> | undefined;
    try {
      const built = await executeFile(
        bun,
        ["scripts/build-managed-runtime-worker.mjs", selectedArrustedRoot, executable, target],
        {
          cwd: process.cwd(),
          timeout: 30_000,
          encoding: "utf-8",
        },
      );
      const build: unknown = JSON.parse(built.stdout);
      expect(
        z.object({ sha256: z.string(), bytes: z.number().positive() }).parse(build).sha256,
      ).toBe(
        createHash("sha256")
          .update(await readFile(executable))
          .digest("hex"),
      );
      const shim = `#!${process.execPath}\nimport{existsSync,writeFileSync,readFileSync,statSync}from'node:fs';import path from'node:path';if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['run','app:runtime','run','orchard','dev']))throw Error('Unexpected controlled launch');const stateDirectory=process.env.APP_RUNTIME_STATE_DIR;const environmentPath=path.join(stateDirectory,'environment.json');const runtimeEnvironment=JSON.parse(readFileSync(environmentPath,'utf8'));writeFileSync('launch.json',JSON.stringify({inputRemoved:!existsSync('runtime-input.json'),argv:process.argv.slice(2),stateDirectory,stateMode:statSync(stateDirectory).mode&0o777,environmentMode:statSync(environmentPath).mode&0o777,runtimeEnvironment}));const environment={...process.env,...runtimeEnvironment};delete environment.APP_RUNTIME_STATE_DIR;process.execve(process.execPath,[process.execPath,path.resolve('app.mjs')],environment);\n`;
      await writeFile(path.join(bin, "mise"), shim, { mode: 0o700 });
      await chmod(path.join(bin, "mise"), 0o700);
      // Generic controlled app: no generated-app roles, routes or data are frozen.
      // The fixture self-exits if its owning worker disappears during a failed test.
      await writeFile(
        path.join(directory, "app.mjs"),
        `import{createServer}from'node:http';import{readFileSync,writeFileSync}from'node:fs';const owner=process.ppid;let generation=1;try{generation=JSON.parse(readFileSync('app-generation.json','utf8')).generation+1}catch{};writeFileSync('app-generation.json',JSON.stringify({generation,pid:process.pid}));setInterval(()=>{if(process.ppid!==owner)process.exit(0)},100).unref();createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);res.end(JSON.stringify({generation,pid:process.pid,method:req.method,target:req.url,body:Buffer.concat(chunks).toString('base64'),headers:req.headers,environment:process.env,argv:process.argv}));}).listen(Number(process.env.PORT),'127.0.0.1');`,
      );
      const capabilities = createPrivateManagedRuntimeCapabilities();
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicOrigin = "https://gateway.example";
      const appPort = await availablePort();
      const bridgePort = await availablePort();
      const current = {
        intentId: randomUUID(),
        approvalRef: "controlled-owner-approval",
        owner: {
          issuer: "https://builder.example/api/auth",
          audience: "https://builder.example/mcp",
          workspaceId: "workspace",
          ownerUserId: "owner",
          sessionId: "saved-session",
        },
        appId: "orchard",
        runtimeAttemptId: randomUUID(),
        fence: 1,
        sandboxId: "controlled-sandbox",
        providerSessionId: "controlled-provider-session",
        state: "starting",
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      const input = managedRuntimeEntryInputSchema.parse({
        version: 1,
        current,
        profile: {
          version: 1,
          appId: "orchard",
          publicOrigin,
          jwksUrl: `${publicOrigin}/_platform/jwks.json`,
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              kid: "fixture-key",
              alg: "EdDSA",
              use: "sig",
            },
          ],
        },
        actors: [{ actorId: "fixture-actor", organizationId: "fixture-organization" }],
        root: directory,
        rootDirectory: directory,
        appPort,
        bridgePort,
        appEnvironment: {
          ORCHARD_DATABASE_URL: "postgresql://controlled.invalid/same-resource",
          PLATFORM_ORIGIN: publicOrigin,
        },
        lifecycleSha256: capabilities.lifecycleSha256,
        transportSha256: capabilities.projection.transportSha256,
      });
      const inputText = JSON.stringify(input);
      for (const bearer of Object.values(capabilities.private)) {
        expect(inputText).not.toContain(bearer);
      }
      await writeFile(inputFile, inputText, { mode: 0o600, flag: "wx" });
      owned = await createManagedOwnedChildLauncher({
        executable,
        args: ["protected-managed-app-runtime", "--input-file", inputFile],
        cwd: directory,
        appEnvironment: {
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: directory,
        },
        stopTimeoutMs: 2000,
      })();
      await awaitFile(path.join(directory, "ready.json"), owned.closed);
      const ready = await readJson(path.join(directory, "ready.json"), managedRuntimeReadySchema);
      expect(ready.current.state).toBe("ready");
      expect(ready.current.leaseExpiresAt).toBe(current.leaseExpiresAt);
      const localOwner = await readJson(
        path.join(directory, "current.json"),
        managedRuntimeReadySchema.shape.current,
      );
      expect(Date.parse(localOwner.leaseExpiresAt)).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(Date.parse(localOwner.leaseExpiresAt)).toBeLessThan(
        Date.parse(ready.current.leaseExpiresAt),
      );
      expect(
        await readJson(
          path.join(directory, "launch.json"),
          z.object({
            inputRemoved: z.boolean(),
            stateDirectory: z.string(),
            stateMode: z.number(),
            environmentMode: z.number(),
            runtimeEnvironment: z.record(z.string(), z.string()),
          }),
        ),
      ).toMatchObject({
        inputRemoved: true,
        stateDirectory: path.join(input.rootDirectory, "app-state"),
        stateMode: 0o700,
        environmentMode: 0o600,
        runtimeEnvironment: input.appEnvironment,
      });
      await expect(access(inputFile)).rejects.toThrow();
      const body = Buffer.from('{"content":"租户😀"}\n');
      const header = Buffer.from(
        JSON.stringify({ alg: "EdDSA", kid: "fixture-key", typ: "JWT" }),
      ).toString("base64url");
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(
        JSON.stringify({
          iss: publicOrigin,
          aud: "orchard",
          sub: "fixture-actor",
          organizationId: "fixture-organization",
          customerId: "fixture-organization",
          organizationRole: "member",
          appActorGrants: [{ role: "fixture_operator", fenceGeneration: 1 }],
          method: "POST",
          path: "/orchard/action?view=one",
          bodySha256: createHash("sha256").update(body).digest("base64url"),
          iat: timestamp,
          exp: timestamp + 60,
          jti: randomUUID(),
        }),
      ).toString("base64url");
      const signingInput = `${header}.${payload}`;
      const token = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
      const accepted = await exchange(bridgePort, token, capabilities.private.transport, body);
      expect(accepted.status).toBe(200);
      const first = observationSchema.parse(JSON.parse(accepted.body.toString()));
      expect(first).toMatchObject({
        generation: 1,
        method: "POST",
        target: "/orchard/action?view=one",
        body: body.toString("base64"),
      });
      expect(first.headers.authorization).toBeUndefined();
      expect(first.headers["x-platform-managed-suite"]).toBeUndefined();
      expect(first.headers["x-vercel-oidc-token"]).toBeUndefined();
      expect(first.headers["x-vercel-trusted-oidc-idp-token"]).toBeUndefined();
      for (const bearer of Object.values(capabilities.private)) {
        expect(JSON.stringify(first.environment)).not.toContain(bearer);
      }
      expect(first.environment.APP_RUNTIME_STATE_DIR).toBeUndefined();
      expect(first.environment.ORCHARD_DATABASE_URL).toBe(
        input.appEnvironment.ORCHARD_DATABASE_URL,
      );
      expect(first.argv.slice(1)).toEqual([path.join(directory, "app.mjs")]);
      const tampered = await exchange(
        bridgePort,
        token,
        capabilities.private.transport,
        Buffer.from("tampered"),
      );
      expect(tampered.status).toBe(403);
      const wrongTransport = await exchange(
        bridgePort,
        token,
        capabilities.private.suiteSelector,
        body,
      );
      expect(wrongTransport.status).toBe(403);
      const client = createManagedRuntimeIpcClient({
        socketPath: ready.socketPath,
        lifecycleCapability: capabilities.private.lifecycle,
      });
      const stopped = await client.execute({ operation: "stop-and-wait", commandId: randomUUID() });
      expect(stopped.state).toBe("stopped");
      expect(() => process.kill(first.pid, 0)).toThrow();
      await client.execute({ operation: "start-same-environment", commandId: randomUUID() });
      let readiness = await client.execute({
        operation: "observe-readiness",
        commandId: randomUUID(),
      });
      const deadline = Date.now() + 5000;
      while (readiness.state !== "ready" && Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Await the actual owned app's readiness after its process replacement.
        await delay(25);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each observation concerns only this owned local fixture process.
        readiness = await client.execute({
          operation: "observe-readiness",
          commandId: randomUUID(),
        });
      }
      expect(readiness.state).toBe("ready");
      const replacement = await exchange(bridgePort, token, capabilities.private.transport, body);
      expect(replacement.status).toBe(200);
      const second = observationSchema.parse(JSON.parse(replacement.body.toString()));
      expect(second.generation).toBe(2);
      expect(second.pid).not.toBe(first.pid);
      expect(second.environment).toEqual(first.environment);
      // A lost operator cannot keep the owned bridge alive until the provider TTL.
      // Expire only this exact local owner projection; the published bound stays fixed.
      const currentFile = path.join(directory, "current.json");
      const liveOwner = await readJson(currentFile, managedRuntimeReadySchema.shape.current);
      await writeFile(
        currentFile,
        JSON.stringify({ ...liveOwner, leaseExpiresAt: new Date(Date.now() - 1).toISOString() }),
      );
      await owned.closed;
      expect(() => process.kill(second.pid, 0)).toThrow();
      await expect(
        exchange(bridgePort, token, capabilities.private.transport, body),
      ).rejects.toThrow();
    } finally {
      await owned?.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(arrustedRoot === undefined || arrustedRoot.length === 0)(
  "compiled entry cancellation during actual startup closes its child and listener before readiness",
  async () => {
    const selectedArrustedRoot = z.string().min(1).parse(arrustedRoot);
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "mc-")));
    const executable = path.join(directory, "managed-runtime");
    const inputFile = path.join(directory, "runtime-input.json");
    const bin = path.join(directory, "bin");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(bin);
    let owned: Awaited<ReturnType<ReturnType<typeof createManagedOwnedChildLauncher>>> | undefined;
    try {
      await executeFile(
        process.env.BUN_BINARY ?? "bun",
        [
          "scripts/build-managed-runtime-worker.mjs",
          selectedArrustedRoot,
          executable,
          `bun-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`,
        ],
        { cwd: process.cwd(), timeout: 30_000, encoding: "utf-8" },
      );
      await writeFile(
        path.join(bin, "mise"),
        `#!${process.execPath}\nimport path from'node:path';import{readFileSync}from'node:fs';if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['run','app:runtime','run','orchard','dev']))throw Error('Unexpected controlled launch');const runtimeEnvironment=JSON.parse(readFileSync(path.join(process.env.APP_RUNTIME_STATE_DIR,'environment.json'),'utf8'));const environment={...process.env,...runtimeEnvironment};delete environment.APP_RUNTIME_STATE_DIR;process.execve(process.execPath,[process.execPath,path.resolve('app.mjs')],environment);\n`,
        { mode: 0o700 },
      );
      // The real entry's readiness HTTP request establishes this barrier. The
      // controlled child never responds, so cancellation is definitely pre-ready.
      // A fixture-owned filesystem release is emergency cleanup only, after proof.
      await writeFile(
        path.join(directory, "app.mjs"),
        `import{createServer}from'node:http';import{existsSync,writeFileSync,watch}from'node:fs';let closing=false;const server=createServer(()=>writeFileSync('startup-barrier.json',JSON.stringify({pid:process.pid,inputRemoved:!existsSync('runtime-input.json')})));const cleanup=()=>{if(closing)return;closing=true;server.closeAllConnections();server.close(()=>process.exit(0));};process.on('SIGTERM',()=>{writeFileSync('child-terminated.json',JSON.stringify({pid:process.pid,signal:'SIGTERM'}));cleanup();});watch('.',(_event,name)=>{if(name==='cleanup-request')cleanup();});server.listen(Number(process.env.PORT),'127.0.0.1');`,
      );
      const capabilities = createPrivateManagedRuntimeCapabilities();
      const { publicKey } = generateKeyPairSync("ed25519");
      const publicOrigin = "https://gateway.example";
      const appPort = await availablePort();
      const bridgePort = await availablePort();
      const input = managedRuntimeEntryInputSchema.parse({
        version: 1,
        current: {
          intentId: randomUUID(),
          approvalRef: "controlled-owner-approval",
          owner: {
            issuer: "https://builder.example/api/auth",
            audience: "https://builder.example/mcp",
            workspaceId: "workspace",
            ownerUserId: "owner",
            sessionId: "saved-session",
          },
          appId: "orchard",
          runtimeAttemptId: randomUUID(),
          fence: 1,
          sandboxId: "controlled-sandbox",
          providerSessionId: "controlled-provider-session",
          state: "starting",
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
        profile: {
          version: 1,
          appId: "orchard",
          publicOrigin,
          jwksUrl: `${publicOrigin}/_platform/jwks.json`,
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              kid: "fixture-key",
              alg: "EdDSA",
              use: "sig",
            },
          ],
        },
        actors: [{ actorId: "fixture-actor", organizationId: "fixture-organization" }],
        root: directory,
        rootDirectory: directory,
        appPort,
        bridgePort,
        appEnvironment: {
          ORCHARD_DATABASE_URL: "postgresql://controlled.invalid/same-resource",
          PLATFORM_ORIGIN: publicOrigin,
        },
        lifecycleSha256: capabilities.lifecycleSha256,
        transportSha256: capabilities.projection.transportSha256,
      });
      await writeFile(inputFile, JSON.stringify(input), { mode: 0o600, flag: "wx" });
      owned = await createManagedOwnedChildLauncher({
        executable,
        args: ["protected-managed-app-runtime", "--input-file", inputFile],
        cwd: directory,
        appEnvironment: {
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: directory,
        },
        stopTimeoutMs: 2000,
      })();
      const barrierPath = path.join(directory, "startup-barrier.json");
      await awaitFile(barrierPath, owned.closed);
      const barrier = await readJson(
        barrierPath,
        z.object({ pid: z.number().int().positive(), inputRemoved: z.boolean() }),
      );
      expect(barrier.inputRemoved).toBe(true);
      await expect(access(path.join(directory, "ready.json"))).rejects.toThrow();
      // This signals only the worker created by this fixture. Its own entry must
      // cancel and await its separately owned app group; the test never kills it.
      const exit = await owned.terminate();
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();
      expect(
        await readJson(
          path.join(directory, "child-terminated.json"),
          z.object({ pid: z.number(), signal: z.string() }),
        ),
      ).toEqual({ pid: barrier.pid, signal: "SIGTERM" });
      expect(() => process.kill(barrier.pid, 0)).toThrow();
      await expect(exchange(bridgePort, "unused", "unused", Buffer.alloc(0))).rejects.toThrow();
      await expect(exchange(appPort, "unused", "unused", Buffer.alloc(0))).rejects.toThrow();
      await expect(access(inputFile)).rejects.toThrow();
      await expect(access(path.join(directory, "ready.json"))).rejects.toThrow();
    } finally {
      // Only this controlled child recognizes this path. This does not authorize
      // a PID, command, app effect or production restart API.
      await writeFile(path.join(directory, "cleanup-request"), "cleanup");
      await owned?.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
