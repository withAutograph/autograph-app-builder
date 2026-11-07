/* oxlint-disable promise/avoid-new -- Controlled listeners and owned child completion expose Node event-to-Promise interfaces. */
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

const promisifyExecFile: (fn: typeof execFile) => typeof execFile.__promisify__ = promisify;
const executeFile = promisifyExecFile(execFile);
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
        headers: {
          authorization: `Bearer ${transport}`,
          "content-length": String(body.length),
          "x-platform-managed-suite": "must-not-reach-app",
          "x-platform-principal": token,
          "x-vercel-oidc-token": "controlled-transport-secret",
          "x-vercel-trusted-oidc-idp-token": "controlled-transport-secret-two",
        },
        hostname: "127.0.0.1",
        method: "POST",
        path: "/orchard/action?view=one",
        port,
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part) => {
          parts.push(Buffer.from(z.instanceof(Uint8Array).parse(part)));
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve({ body: Buffer.concat(parts), status: response.statusCode ?? 0 });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
const observationSchema = z.object({
  argv: z.array(z.string()),
  body: z.string(),
  environment: z.record(z.string(), z.string()),
  generation: z.number().int().positive(),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  method: z.string(),
  pid: z.number().int().positive(),
  target: z.string(),
  verified: z.object({
    actorId: z.string(),
    grants: z.array(z.object({ fenceGeneration: z.number(), role: z.string() })),
    organizationId: z.string(),
  }),
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

// The first shim dispatches the maintained repository launcher unchanged. Only
// its final app-specific task is a controlled fixture, never the env loader.
const installRepositoryRuntimeShim = async (directory: string, selectedArrustedRoot: string) => {
  const bun = process.env.BUN_BINARY ?? "bun";
  const resolved = await executeFile(bun, ["-e", "process.stdout.write(process.execPath)"], {
    encoding: "utf-8",
  });
  const script = path.join(selectedArrustedRoot, ".config/mise/scripts/repository/app-runtime.ts");
  await writeFile(
    path.join(directory, "bin", "mise"),
    `#!${process.execPath}\nimport{existsSync,writeFileSync,readFileSync,statSync}from'node:fs';import path from'node:path';const directory=${JSON.stringify(directory)};const args=process.argv.slice(2);if(JSON.stringify(args)===JSON.stringify(['run','app:runtime','run','orchard','dev'])){const stateDirectory=process.env.APP_RUNTIME_STATE_DIR;const environmentPath=path.join(stateDirectory,'environment.json');writeFileSync(path.join(directory,'launch.json'),JSON.stringify({inputRemoved:!existsSync(path.join(directory,'runtime-input.json')),argv:args,stateDirectory,stateMode:statSync(stateDirectory).mode&0o777,environmentMode:statSync(environmentPath).mode&0o777,runtimeEnvironment:JSON.parse(readFileSync(environmentPath,'utf8'))}));process.execve(${JSON.stringify(resolved.stdout)},[${JSON.stringify(resolved.stdout)},${JSON.stringify(script)},...args.slice(2)],process.env);}else if(JSON.stringify(args)===JSON.stringify(['run','//apps/orchard:dev'])){writeFileSync(path.join(directory,'terminal.json'),JSON.stringify({cwd:process.cwd(),argv:args,environment:process.env}));process.chdir(directory);process.execve(${JSON.stringify(process.execPath)},[${JSON.stringify(process.execPath)},path.join(directory,'app.mjs')],process.env);}else throw Error('Unexpected repository runtime task');\n`,
    { mode: 0o700 },
  );
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
          encoding: "utf-8",
          timeout: 30_000,
        },
      );
      const build: unknown = JSON.parse(built.stdout);
      expect(
        z.object({ bytes: z.number().positive(), sha256: z.string() }).parse(build).sha256,
      ).toBe(
        createHash("sha256")
          .update(await readFile(executable))
          .digest("hex"),
      );
      await installRepositoryRuntimeShim(directory, selectedArrustedRoot);
      // Generic app fixture, with the maintained app-side verifier bundled from
      // the selected repository. Neither generated app source nor roles are copied.
      await writeFile(
        path.join(directory, "app.ts"),
        `import{createServer}from'node:http';import{readFileSync,writeFileSync}from'node:fs';import{createManagedGatewayVerification}from ${JSON.stringify(path.join(selectedArrustedRoot, "packages/platform-microfrontends/src/policy/managed-gateway-verification.ts"))};import{verifyZoneRequestPrincipal}from ${JSON.stringify(path.join(selectedArrustedRoot, "packages/platform-microfrontends/src/policy/zone-ingress.ts"))};const profile=JSON.parse(process.env.PLATFORM_MANAGED_GATEWAY_PUBLIC_PROFILE!);const boundary=JSON.parse(process.env.PLATFORM_APP_BOUNDARY!);if(boundary.verification.publicOrigin!==process.env.PLATFORM_PUBLIC_ORIGIN)throw Error('Public boundary origin differs');const verification=createManagedGatewayVerification({profile,appId:'orchard',publicOrigin:process.env.PLATFORM_PUBLIC_ORIGIN!,jwksUrl:profile.jwksUrl});const owner=process.ppid;let generation=1;try{generation=JSON.parse(readFileSync('app-generation.json','utf8')).generation+1}catch{};writeFileSync('app-generation.json',JSON.stringify({generation,pid:process.pid}));setInterval(()=>{if(process.ppid!==owner)process.exit(0)},100).unref();createServer(async(req,res)=>{if(req.url==='/'){res.end('ready');return;}try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const headers=new Headers();for(const[name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);const principal=await verifyZoneRequestPrincipal({...verification,headers,method:req.method!,path:req.url!});res.end(JSON.stringify({verified:{actorId:principal.sub,organizationId:principal.organizationId,grants:principal.appActorGrants},generation,pid:process.pid,method:req.method,target:req.url,body:Buffer.concat(chunks).toString('base64'),headers:req.headers,environment:process.env,argv:process.argv}));}catch{res.statusCode=403;res.end('App principal denied');}}).listen(Number(process.env.PORT),'127.0.0.1');`,
      );
      await executeFile(
        bun,
        [
          "build",
          path.join(directory, "app.ts"),
          "--target=node",
          "--outfile",
          path.join(directory, "app.mjs"),
        ],
        { cwd: selectedArrustedRoot, encoding: "utf-8", timeout: 30_000 },
      );
      const capabilities = createPrivateManagedRuntimeCapabilities();
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicOrigin = "https://gateway-preview.example";
      const nativeOrigin = "https://gateway-immutable.example";
      const appPort = await availablePort();
      const bridgePort = await availablePort();
      const current = {
        appId: "orchard",
        approvalRef: "controlled-owner-approval",
        fence: 1,
        intentId: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        owner: {
          audience: "https://builder.example/mcp",
          issuer: "https://builder.example/api/auth",
          ownerUserId: "owner",
          sessionId: "saved-session",
          workspaceId: "workspace",
        },
        providerSessionId: "controlled-provider-session",
        runtimeAttemptId: randomUUID(),
        sandboxId: "controlled-sandbox",
        state: "starting",
      };
      const input = managedRuntimeEntryInputSchema.parse({
        actors: [{ actorId: "fixture-actor", organizationId: "fixture-organization" }],
        appEnvironment: {
          ORCHARD_DATABASE_URL: "postgresql://controlled.invalid/same-resource",
          PLATFORM_APP_BOUNDARY: JSON.stringify({
            appId: "orchard",
            mode: "protected-gateway-v1",
            runtime: {
              database: "orchard",
              environment: "hosted",
              hostname: "controlled.invalid",
              port: 5432,
              runtimeRole: "orchard_runtime",
            },
            verification: { jwksUrl: `${nativeOrigin}/_platform/jwks.json`, publicOrigin },
            version: 1,
          }),
          PLATFORM_JWKS_URL: `${nativeOrigin}/_platform/jwks.json`,
          PLATFORM_ORIGIN: nativeOrigin,
          PLATFORM_PUBLIC_ORIGIN: publicOrigin,
        },
        appPort,
        bridgePort,
        current,
        lifecycleSha256: capabilities.lifecycleSha256,
        profile: {
          appId: "orchard",
          jwksUrl: `${publicOrigin}/_platform/jwks.json`,
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              alg: "EdDSA",
              kid: "fixture-key",
              use: "sig",
            },
          ],
          publicOrigin,
          version: 1,
        },
        root: directory,
        rootDirectory: directory,
        transportSha256: capabilities.projection.transportSha256,
        version: 1,
      });
      const inputText = JSON.stringify(input);
      for (const bearer of Object.values(capabilities.private)) {
        expect(inputText).not.toContain(bearer);
      }
      await writeFile(inputFile, inputText, { flag: "wx", mode: 0o600 });
      owned = await createManagedOwnedChildLauncher({
        appEnvironment: {
          BETTER_AUTH_SECRET: "worker-only-auth-secret",
          HOME: directory,
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          PLATFORM_AUTH_DATABASE_URL: "postgresql://worker-only.invalid/auth",
          PLATFORM_MANAGED_GATEWAY_PUBLIC_PROFILE: "worker-only-untrusted-profile",
          VERCEL_OIDC_TOKEN: "worker-only-provider-token",
        },
        args: ["protected-managed-app-runtime", "--input-file", inputFile],
        cwd: directory,
        executable,
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
            environmentMode: z.number(),
            inputRemoved: z.boolean(),
            runtimeEnvironment: z.record(z.string(), z.string()),
            stateDirectory: z.string(),
            stateMode: z.number(),
          }),
        ),
      ).toMatchObject({
        environmentMode: 0o600,
        inputRemoved: true,
        runtimeEnvironment: {
          ...input.appEnvironment,
          PLATFORM_MANAGED_GATEWAY_PUBLIC_PROFILE: JSON.stringify(input.profile),
        },
        stateDirectory: path.join(input.rootDirectory, "app-state"),
        stateMode: 0o700,
      });
      await expect(access(inputFile)).rejects.toThrow();
      const body = Buffer.from('{"content":"租户😀"}\n');
      const header = Buffer.from(
        JSON.stringify({ alg: "EdDSA", kid: "fixture-key", typ: "JWT" }),
      ).toString("base64url");
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(
        JSON.stringify({
          appActorGrants: [{ fenceGeneration: 1, role: "fixture_operator" }],
          aud: "orchard",
          bodySha256: createHash("sha256").update(body).digest("base64url"),
          customerId: "fixture-organization",
          exp: timestamp + 60,
          iat: timestamp,
          iss: publicOrigin,
          jti: randomUUID(),
          method: "POST",
          organizationId: "fixture-organization",
          organizationRole: "member",
          path: "/orchard/action?view=one",
          sub: "fixture-actor",
        }),
      ).toString("base64url");
      const signingInput = `${header}.${payload}`;
      const token = `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
      const accepted = await exchange(bridgePort, token, capabilities.private.transport, body);
      expect(accepted.status).toBe(200);
      const first = observationSchema.parse(JSON.parse(accepted.body.toString()));
      expect(first).toMatchObject({
        body: body.toString("base64"),
        generation: 1,
        method: "POST",
        target: "/orchard/action?view=one",
      });
      expect(first.verified).toEqual({
        actorId: "fixture-actor",
        grants: [{ fenceGeneration: 1, role: "fixture_operator" }],
        organizationId: "fixture-organization",
      });
      const terminal = await readJson(
        path.join(directory, "terminal.json"),
        z.object({
          argv: z.array(z.string()),
          cwd: z.string(),
          environment: z.record(z.string(), z.string()),
        }),
      );
      expect(terminal.cwd).toBe(selectedArrustedRoot);
      expect(terminal.argv).toEqual(["run", "//apps/orchard:dev"]);
      expect(terminal.environment.MISE_ENV?.split(",")).toContain("app-validation");
      expect(terminal.environment.APP_RUNTIME_STATE_DIR).toBeUndefined();
      expect(first.headers.authorization).toBeUndefined();
      expect(first.headers["x-platform-managed-suite"]).toBeUndefined();
      expect(first.headers["x-vercel-oidc-token"]).toBeUndefined();
      expect(first.headers["x-vercel-trusted-oidc-idp-token"]).toBeUndefined();
      for (const bearer of Object.values(capabilities.private)) {
        expect(JSON.stringify(first.environment)).not.toContain(bearer);
      }
      expect(first.environment.APP_RUNTIME_STATE_DIR).toBeUndefined();
      expect(first.environment.PLATFORM_ORIGIN).toBe(nativeOrigin);
      expect(first.environment.PLATFORM_PUBLIC_ORIGIN).toBe(publicOrigin);
      expect(first.environment.PLATFORM_ORIGIN).not.toBe(first.environment.PLATFORM_PUBLIC_ORIGIN);
      expect(
        JSON.parse(first.environment.PLATFORM_MANAGED_GATEWAY_PUBLIC_PROFILE ?? "null"),
      ).toEqual(input.profile);
      expect(first.environment.VERCEL_OIDC_TOKEN).toBeUndefined();
      expect(first.environment.BETTER_AUTH_SECRET).toBeUndefined();
      expect(first.environment.PLATFORM_AUTH_DATABASE_URL).toBeUndefined();
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
        lifecycleCapability: capabilities.private.lifecycle,
        socketPath: ready.socketPath,
      });
      const stopped = await client.execute({ commandId: randomUUID(), operation: "stop-and-wait" });
      expect(stopped.state).toBe("stopped");
      expect(() => process.kill(first.pid, 0)).toThrow();
      await client.execute({ commandId: randomUUID(), operation: "start-same-environment" });
      let readiness = await client.execute({
        commandId: randomUUID(),
        operation: "observe-readiness",
      });
      const deadline = Date.now() + 5000;
      while (readiness.state !== "ready" && Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Await the actual owned app's readiness after its process replacement.
        await delay(25);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each observation concerns only this owned local fixture process.
        readiness = await client.execute({
          commandId: randomUUID(),
          operation: "observe-readiness",
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
      await rm(directory, { force: true, recursive: true });
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
        { cwd: process.cwd(), encoding: "utf-8", timeout: 30_000 },
      );
      await installRepositoryRuntimeShim(directory, selectedArrustedRoot);
      // The real entry's readiness HTTP request establishes this barrier. The
      // controlled child never responds, so cancellation is definitely pre-ready.
      // A fixture-owned filesystem release is emergency cleanup only, after proof.
      await writeFile(
        path.join(directory, "app.mjs"),
        `import{createServer}from'node:http';import{existsSync,writeFileSync,watch}from'node:fs';let closing=false;const server=createServer(()=>writeFileSync('startup-barrier.json',JSON.stringify({pid:process.pid,inputRemoved:!existsSync('runtime-input.json')})));const cleanup=()=>{if(closing)return;closing=true;server.closeAllConnections();server.close(()=>process.exit(0));};process.on('SIGTERM',()=>{writeFileSync('child-terminated.json',JSON.stringify({pid:process.pid,signal:'SIGTERM'}));cleanup();});watch('.',(_event,name)=>{if(name==='cleanup-request')cleanup();});server.listen(Number(process.env.PORT),'127.0.0.1');`,
      );
      const capabilities = createPrivateManagedRuntimeCapabilities();
      const { publicKey } = generateKeyPairSync("ed25519");
      const publicOrigin = "https://gateway-preview.example";
      const nativeOrigin = "https://gateway-immutable.example";
      const appPort = await availablePort();
      const bridgePort = await availablePort();
      const input = managedRuntimeEntryInputSchema.parse({
        actors: [{ actorId: "fixture-actor", organizationId: "fixture-organization" }],
        appEnvironment: {
          ORCHARD_DATABASE_URL: "postgresql://controlled.invalid/same-resource",
          PLATFORM_APP_BOUNDARY: JSON.stringify({
            appId: "orchard",
            mode: "protected-gateway-v1",
            runtime: {
              database: "orchard",
              environment: "hosted",
              hostname: "controlled.invalid",
              port: 5432,
              runtimeRole: "orchard_runtime",
            },
            verification: { jwksUrl: `${nativeOrigin}/_platform/jwks.json`, publicOrigin },
            version: 1,
          }),
          PLATFORM_JWKS_URL: `${nativeOrigin}/_platform/jwks.json`,
          PLATFORM_ORIGIN: nativeOrigin,
          PLATFORM_PUBLIC_ORIGIN: publicOrigin,
        },
        appPort,
        bridgePort,
        current: {
          appId: "orchard",
          approvalRef: "controlled-owner-approval",
          fence: 1,
          intentId: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
          owner: {
            audience: "https://builder.example/mcp",
            issuer: "https://builder.example/api/auth",
            ownerUserId: "owner",
            sessionId: "saved-session",
            workspaceId: "workspace",
          },
          providerSessionId: "controlled-provider-session",
          runtimeAttemptId: randomUUID(),
          sandboxId: "controlled-sandbox",
          state: "starting",
        },
        lifecycleSha256: capabilities.lifecycleSha256,
        profile: {
          appId: "orchard",
          jwksUrl: `${publicOrigin}/_platform/jwks.json`,
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              alg: "EdDSA",
              kid: "fixture-key",
              use: "sig",
            },
          ],
          publicOrigin,
          version: 1,
        },
        root: directory,
        rootDirectory: directory,
        transportSha256: capabilities.projection.transportSha256,
        version: 1,
      });
      await writeFile(inputFile, JSON.stringify(input), { flag: "wx", mode: 0o600 });
      owned = await createManagedOwnedChildLauncher({
        appEnvironment: {
          HOME: directory,
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        },
        args: ["protected-managed-app-runtime", "--input-file", inputFile],
        cwd: directory,
        executable,
        stopTimeoutMs: 2000,
      })();
      const barrierPath = path.join(directory, "startup-barrier.json");
      await awaitFile(barrierPath, owned.closed);
      const barrier = await readJson(
        barrierPath,
        z.object({ inputRemoved: z.boolean(), pid: z.number().int().positive() }),
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
      await rm(directory, { force: true, recursive: true });
    }
  },
  60_000,
);
