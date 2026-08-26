import { generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const preload = pathToFileURL(
  resolve(import.meta.dirname, "test-capability-preload.mjs"),
).href;
const workerFixture = pathToFileURL(
  resolve(import.meta.dirname, "test-capability-worker-fixture.mjs"),
);
const timeoutWorkerFixture = pathToFileURL(
  resolve(import.meta.dirname, "test-capability-worker-timeout-fixture.mjs"),
);
const registryPath = resolve(
  repositoryRoot,
  "lib/testing/test-capability-registry.cjs",
);
const capabilityExpression = `createRequire(import.meta.url)(${JSON.stringify(registryPath)}).current(process)`;
const inspectionSource = `
  const { createRequire } = await import("node:module");
  const capability = ${capabilityExpression} ?? null;
  process.stdout.write(JSON.stringify({ capability, nodeOptions: process.env.NODE_OPTIONS ?? null }));
`;

const fullCapabilities = [
  "mock-model",
  "simulated-target",
  "simulated-publication",
];
function inspectAmbientPreload(environment: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", inspectionSource],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    capability: unknown;
    nodeOptions: string | null;
  };
}

describe("test capability preload", () => {
  it("uses the actual trusted wrapper lineage for this Vitest worker", async () => {
    const accessor = (
      process as unknown as Record<symbol, (() => unknown) | undefined>
    )[
      Symbol.for(
        "withAutograph.autograph-app-builder.test-capability-registry.v2",
      )
    ];
    const capability = accessor?.() as
      { id: string; version: number; capabilities: string[] } | undefined;
    expect(capability).toMatchObject({
      version: 1,
      capabilities: fullCapabilities,
    });
    const worker = new Worker(workerFixture, {
      workerData: { spawnNested: true },
      env: { ...process.env, EVE_DEV_WORKER_APP_ROOT: "/hostile/app-root" },
    });
    const result = await new Promise<{
      capability: typeof capability;
      appRoot: string | null;
      nestedCapability: typeof capability;
      nestedAppRoot: string | null;
    }>((resolveMessage, reject) => {
      worker.once("message", resolveMessage);
      worker.once("error", reject);
    });
    await worker.terminate();
    expect(result.capability).toMatchObject({ version: 1 });
    expect(result.capability?.id).not.toBe(capability?.id);
    expect(result.appRoot).toBe(repositoryRoot);
    expect(result.nestedCapability).toMatchObject({ version: 1 });
    expect(result.nestedCapability?.id).not.toBe(result.capability?.id);
    expect(result.nestedAppRoot).toBe(repositoryRoot);
    const activeHandles = () =>
      (
        process as unknown as { _getActiveHandles(): readonly unknown[] }
      )._getActiveHandles();
    const isMessagePort = (handle: unknown) =>
      typeof handle === "object" &&
      handle !== null &&
      handle.constructor.name === "MessagePort";
    const beforePorts = activeHandles().filter(isMessagePort).length;
    const timeoutWorker = new Worker(timeoutWorkerFixture, { execArgv: [] });
    const timeoutExit = await new Promise<number>((resolveExit, reject) => {
      timeoutWorker.once("exit", resolveExit);
      timeoutWorker.once("error", reject);
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    const afterPorts = activeHandles().filter(isMessagePort).length;
    expect(timeoutExit).not.toBe(0);
    expect(afterPorts).toBeLessThanOrEqual(beforePorts);
  });

  it("rejects an exact tracked preload imported solely through NODE_OPTIONS", () => {
    expect(
      inspectAmbientPreload({
        ...process.env,
        NODE_OPTIONS: `--import=${preload}`,
        APP_BUILDER_TEST_MODEL: "1",
        APP_BUILDER_TEST_CAPABILITY_ID: "a".repeat(64),
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
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: undefined },
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
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" },
      });
      const authorization = child.stdio[3] as Duplex;
      const authorizationErrors: string[] = [];
      authorization.on("error", (error: NodeJS.ErrnoException) => {
        authorizationErrors.push(error.code ?? error.message);
      });
      const authorizationClosed = new Promise<void>((resolveClose) => {
        authorization.once("close", resolveClose);
      });
      authorization.end(
        `${JSON.stringify({
          version: 2,
          publicKey: attackerPublicKey,
        })}\n`,
      );
      let stdout = "";
      let stderr = "";
      child.stdout
        ?.setEncoding("utf8")
        .on("data", (chunk) => (stdout += chunk));
      child.stderr
        ?.setEncoding("utf8")
        .on("data", (chunk) => (stderr += chunk));
      const status = await new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });
      await authorizationClosed;
      expect(status, stderr).toBe(0);
      expect(stdout).toBe("false");
      expect(
        authorizationErrors.every((code) =>
          ["ECONNRESET", "EPIPE"].includes(code),
        ),
      ).toBe(true);
    }
  });

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
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" },
      timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("null");
  });
});
