import { generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { z } from "zod";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const preload = pathToFileURL(
  path.resolve(import.meta.dirname, "test-capability-preload.mjs"),
).href;
const workerFixture = pathToFileURL(
  path.resolve(import.meta.dirname, "test-capability-worker-fixture.mjs"),
);
const timeoutWorkerFixture = pathToFileURL(
  path.resolve(import.meta.dirname, "test-capability-worker-timeout-fixture.mjs"),
);
const registryPath = path.resolve(repositoryRoot, "lib/testing/test-capability-registry.cjs");
const capabilityExpression = `createRequire(import.meta.url)(${JSON.stringify(registryPath)}).current(process)`;
const inspectionSource = `
  const { createRequire } = await import("node:module");
  const capability = ${capabilityExpression} ?? null;
  process.stdout.write(JSON.stringify({ capability, nodeOptions: process.env.NODE_OPTIONS ?? null }));
`;

const fullCapabilities = ["mock-model", "simulated-target", "simulated-publication"];
const capabilitySchema = z.object({
  capabilities: z.array(z.string()),
  id: z.string(),
  version: z.number(),
});
const workerResultSchema = z.object({
  appRoot: z.string().nullable(),
  capability: capabilitySchema.nullable(),
  evaluation: z.string().nullable(),
  evaluationRunId: z.string().nullable(),
  eveDev: z.string().nullable(),
  hasGateAEnvironment: z.boolean(),
  hasTransportSecret: z.boolean(),
  nestedAppRoot: z.string().nullable(),
  nestedCapability: capabilitySchema.nullable(),
  nestedEveDev: z.string().nullable(),
  nestedWorkflowBodyTimeout: z.string().nullable(),
  nestedWorkflowHeadersTimeout: z.string().nullable(),
  port: z.string().nullable(),
  sandboxRunId: z.string().nullable(),
  workflowBaseUrl: z.string().nullable(),
  workflowBodyTimeout: z.string().nullable(),
  workflowHeadersTimeout: z.string().nullable(),
});
const hostileWorkerResultSchema = z.object({
  eveDev: z.union([z.string(), z.null(), z.undefined()]).transform((value) => value ?? null),
});
const inspectionSchema = z.object({
  capability: capabilitySchema.nullable(),
  nodeOptions: z.string().nullable(),
});
interface ActiveHandle {
  constructor: { name: string };
}
const activeHandleSchema = z.object({ constructor: z.object({ name: z.string() }) });
const activeHandlesSchema = z.array(activeHandleSchema);
const getActiveHandles = () => {
  const getterValue: unknown = Object.getOwnPropertyDescriptor(process, "_getActiveHandles")?.value;
  return z.function({ input: [], output: activeHandlesSchema }).parse(getterValue)();
};
const isMessagePort = (handle: ActiveHandle) => handle.constructor.name === "MessagePort";

const inspectAmbientPreload = (environment: NodeJS.ProcessEnv) => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", inspectionSource], {
    cwd: repositoryRoot,
    encoding: "utf-8",
    env: environment,
  });
  expect(result.status, result.stderr).toBe(0);
  return inspectionSchema.parse(JSON.parse(result.stdout));
};

describe("test capability preload", () => {
  it("uses the actual trusted wrapper lineage for this Vitest worker", async () => {
    const registryKey = Symbol.for(
      "withAutograph.autograph-app-builder.test-capability-registry.v2",
    );
    const accessorValue: unknown = Object.getOwnPropertyDescriptor(process, registryKey)?.value;
    const accessorSchema = z.function({ input: [], output: capabilitySchema });
    const accessor = accessorSchema.safeParse(accessorValue);
    const capability = accessor.success ? accessor.data() : undefined;
    expect(capability).toMatchObject({
      capabilities: fullCapabilities,
      version: 1,
    });
    const worker = new Worker(workerFixture, {
      env: {
        ...process.env,
        APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "1",
        APP_BUILDER_BRANCH_WORKTREE_ROOT: "",
        APP_BUILDER_LOCAL_ADAPTER: "1",
        APP_BUILDER_LOCAL_PUBLICATION: "1",
        APP_BUILDER_SANDBOX_IMAGE: "",
        EVE_AGENT_HOST: "http://127.0.0.1:9999",
        EVE_DEV: "1",
        EVE_DEVELOPMENT_SANDBOX_RUN_ID: "hostile-sandbox",
        EVE_DEV_WORKER_APP_ROOT: "/hostile/app-root",
        EVE_DEV_WORKFLOW_TRANSPORT_SECRET: "hostile-secret",
        EVE_EVALUATION: "1",
        EVE_EVALUATION_RUN_ID: "hostile-evaluation",
        PORT: "43123",
        REPOSITORY_LOCAL_ROOTS: "/hostile",
        WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:43123",
        WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "hostile-timeout",
        WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS: "hostile-timeout",
      },
      workerData: { spawnNested: true },
    });
    const workerMessage = await once(worker, "message");
    const result = workerResultSchema.parse(workerMessage[0]);
    await worker.terminate();
    expect(result.capability).toMatchObject({ version: 1 });
    expect(result.capability?.id).not.toBe(capability?.id);
    expect(result.appRoot).toBe(repositoryRoot);
    expect(result.eveDev).toBeNull();
    expect(result.workflowBaseUrl).toBeNull();
    expect(result.workflowBodyTimeout).toBeNull();
    expect(result.workflowHeadersTimeout).toBeNull();
    expect(result.port).toBeNull();
    expect(result.hasTransportSecret).toBe(false);
    expect(result.sandboxRunId).toBeNull();
    expect(result.evaluation).toBeNull();
    expect(result.evaluationRunId).toBeNull();
    expect(result.hasGateAEnvironment).toBe(false);
    expect(result.nestedCapability).toMatchObject({ version: 1 });
    expect(result.nestedCapability?.id).not.toBe(result.capability?.id);
    expect(result.nestedAppRoot).toBe(repositoryRoot);
    expect(result.nestedEveDev).toBeNull();
    expect(result.nestedWorkflowBodyTimeout).toBeNull();
    expect(result.nestedWorkflowHeadersTimeout).toBeNull();
    for (const hostileEveDev of [undefined, "0", "hostile"]) {
      const environment = { ...process.env, EVE_DEV: hostileEveDev };
      const hostileWorker = new Worker(workerFixture, { env: environment });
      const hostileMessage = await once(hostileWorker, "message");
      const hostileResult = hostileWorkerResultSchema.parse(hostileMessage[0]);
      await hostileWorker.terminate();
      expect(hostileResult.eveDev).toBeNull();
    }
    const beforePorts = getActiveHandles().filter(isMessagePort).length;
    const timeoutWorker = new Worker(timeoutWorkerFixture, { execArgv: [] });
    const timeoutExitEvent: unknown[] = await once(timeoutWorker, "exit");
    const [timeoutExit] = timeoutExitEvent;
    await delay(25);
    const afterPorts = getActiveHandles().filter(isMessagePort).length;
    expect(timeoutExit).not.toBe(0);
    expect(afterPorts).toBeLessThanOrEqual(beforePorts);
  }, 30_000);

  it("rejects an exact tracked preload imported solely through NODE_OPTIONS", () => {
    expect(
      inspectAmbientPreload({
        ...process.env,
        APP_BUILDER_TEST_CAPABILITY_ID: "a".repeat(64),
        APP_BUILDER_TEST_MODEL: "1",
        NODE_OPTIONS: `--import=${preload}`,
      }),
    ).toEqual({ capability: null, nodeOptions: null });
  });

  it("does not allow arbitrary code or a self-created channel to mint", () => {
    const source = `
      const { generateKeyPairSync, sign } = require("node:crypto");
      const registry = require(${JSON.stringify(registryPath)});
      let accepted = false;
      try {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const publicKeySource = publicKey.export({ format: "der", type: "spki" }).toString("base64");
        const request = registry.begin(process, "worker:forged", publicKeySource);
        const proof = { version: 2, ...request, authorization: "${"a".repeat(64)}", expiresAt: Date.now() + 1000, capabilities: ["mock-model"], publicKey: publicKeySource };
        proof.signature = sign(null, Buffer.from(JSON.stringify(proof)), privateKey).toString("base64");
        registry.complete(process, proof);
        accepted = true;
      } catch {}
      process.stdout.write(String(accepted));
    `;
    const result = spawnSync(process.execPath, ["-e", source], {
      cwd: repositoryRoot,
      encoding: "utf-8",
      env: { ...process.env, NODE_OPTIONS: null },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("false");
  });

  it("rejects a direct Vitest child with a self-created fd and root", async () => {
    const attackerKeys = generateKeyPairSync("ed25519");
    const attackerPrivateKey = attackerKeys.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const attackerPublicKey = attackerKeys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
    const source = `
      const { createPrivateKey, sign } = require("node:crypto");
      const registry = require(${JSON.stringify(registryPath)});
      let accepted = false;
      try {
        const privateKey = createPrivateKey({ key: Buffer.from(${JSON.stringify(attackerPrivateKey)}, "base64"), format: "der", type: "pkcs8" });
        const publicKeySource = ${JSON.stringify(attackerPublicKey)};
        const request = registry.begin(process, "main");
        const proof = { version: 2, ...request, authorization: "${"a".repeat(64)}", expiresAt: Date.now() + 1000, capabilities: ["mock-model"], publicKey: publicKeySource };
        proof.signature = sign(null, Buffer.from(JSON.stringify(proof)), privateKey).toString("base64");
        registry.complete(process, proof);
        accepted = true;
      } catch {}
      process.stdout.write(String(accepted));
      `;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const child = spawn(process.execPath, ["-e", source], {
        cwd: repositoryRoot,
        env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const authorization = child.stdio.at(3);
      if (!authorization || !("write" in authorization)) {
        throw new TypeError("Child authorization pipe was not created");
      }
      const authorizationErrors: string[] = [];
      authorization.on("error", (error: NodeJS.ErrnoException) => {
        authorizationErrors.push(error.code ?? error.message);
      });
      const authorizationClosed = Promise.withResolvers<undefined>();
      authorization.once("close", () => {
        authorizationClosed.resolve();
      });
      authorization.end(
        `${JSON.stringify({
          publicKey: attackerPublicKey,
          version: 2,
        })}\n`,
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf-8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf-8").on("data", (chunk) => {
        stderr += chunk;
      });
      const childExit: unknown[] = await once(child, "exit");
      const [status] = childExit;
      await authorizationClosed.promise;
      expect(status, stderr).toBe(0);
      expect(stdout).toBe("false");
      expect(authorizationErrors.every((code) => ["ECONNRESET", "EPIPE"].includes(code))).toBe(
        true,
      );
    }
  }, 15_000);

  it("does not authorize a clean Worker with claimant-created authority", () => {
    const source = `
      const { Worker } = require("node:worker_threads");
      const worker = new Worker(${JSON.stringify(`
        const { createRequire } = require("node:module");
        void import(${JSON.stringify(preload)}).then(() => {
          const registry = require(${JSON.stringify(registryPath)});
          require("node:worker_threads").parentPort.postMessage(registry.current(process) ?? null);
        });
      `)}, { eval: true, execArgv: [] });
      worker.once("message", (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); });
      worker.once("error", () => { process.stdout.write("null"); process.exit(0); });
    `;
    const result = spawnSync(process.execPath, ["-e", source], {
      cwd: repositoryRoot,
      encoding: "utf-8",
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" },
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("null");
  });
});
