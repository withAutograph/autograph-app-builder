/* oxlint-disable typescript/no-unsafe-member-access -- Preserve the existing untyped input and rendering boundary. */
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { fstatSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MessageChannel,
  isMainThread,
  receiveMessageOnPort,
  workerData,
} from "node:worker_threads";
import {
  captureEveWorkerEnvelope,
  eveWorkerEnvelopeKey,
  installEveWorkerEnvelope,
} from "./eve-worker-environment.mjs";
import {
  gateAEnvironmentFields,
  gateAEvalProfileKey,
  installGateAEvalProfile,
  validateGateAEvalProfile,
} from "./gate-a-eval-profile.mjs";

const authorizationFd = 3;
const maxBytes = 4096;
const timeoutMs = 10_000;
const preloadUrl = import.meta.url;
const workerPortKey = "__appBuilderStructuralTestAuthorizationV2";
const workerProfileKey = `${workerPortKey}Profile`;
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const repositoryRootStat = statSync(repositoryRoot, { bigint: true });
const invalidRootPath =
  !path.isAbsolute(repositoryRoot) || realpathSync(repositoryRoot) !== repositoryRoot;
if (
  invalidRootPath ||
  !repositoryRootStat.isDirectory() ||
  repositoryRootStat.uid !== BigInt(process.getuid?.() ?? -1) ||
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  (repositoryRootStat.mode & 0o022n) !== 0n
) {
  throw new Error("Structural test package root was not owner-bound.");
}
const require = createRequire(import.meta.url);
/** @type {typeof import("../lib/testing/test-capability-registry.cjs")} */
// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
const registry = require(path.resolve(repositoryRoot, "lib/testing/test-capability-registry.cjs"));
// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
const workerThreads = require("node:worker_threads");
const allowedWorkerEnvironment = new Set([
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_ENV",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "APP_BUILDER_EVAL_BROWSER_EXECUTABLE",
  "ARRUSTED_MANAGED_RUNTIME_TEST_ROOT",
  "BUN_BINARY",
  "APP_BUILDER_DEV_MISE_BIN",
]);
delete process.env.NODE_OPTIONS;

/** @param {ReturnType<typeof captureEveWorkerEnvelope> | undefined} eveEnvelope - Authorized Eve worker environment. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function workerEnvironment(source, eveProfile, eveEnvelope) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = { PATH: "/usr/bin:/bin" };
  for (const name of allowedWorkerEnvironment) {
    if (name !== "EVE_DEV_WORKER_APP_ROOT" && source[name] !== undefined) {
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
      environment[name] = source[name];
    }
  }
  const hasEveEnvelope = eveEnvelope !== undefined;
  environment.EVE_DEV_WORKER_APP_ROOT = hasEveEnvelope ? undefined : repositoryRoot;
  // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
  environment.EVE_DEV = undefined;
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- Preserve the worker profile truthiness check.
  if (!hasEveEnvelope && eveProfile) {
    environment.EVE_DEV = "1";
  }
  if (eveEnvelope?.bodyTimeout === "360000") {
    environment.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = eveEnvelope.bodyTimeout;
  }
  if (eveEnvelope?.headersTimeout === "360000") {
    environment.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = eveEnvelope.headersTimeout;
  }
  return environment;
}

/** @param {{version: unknown, nonce: unknown, context: unknown, authorization: unknown, expiresAt: unknown, capabilities: unknown, publicKey: unknown, gateAEvalProfile: unknown}} proof - Worker authorization fields to sign. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function canonical(proof) {
  return JSON.stringify(
    Object.fromEntries([
      ["version", proof.version],
      ["nonce", proof.nonce],
      ["context", proof.context],
      ["authorization", proof.authorization],
      ["expiresAt", proof.expiresAt],
      ["capabilities", proof.capabilities],
      ["publicKey", proof.publicKey],
      ["gateAEvalProfile", proof.gateAEvalProfile],
    ]),
  );
}
/** @param {unknown} value @param {string[]} keys */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function exactKeys(value, keys) {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).toSorted().join(",") === [...keys].toSorted().join(",")
  );
}
/** @returns {unknown} The untrusted authorization frame. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function readFdFrame() {
  let source = "";
  while (!source.includes("\n")) {
    const buffer = Buffer.alloc(512);
    const count = readSync(authorizationFd, buffer, 0, buffer.length, null);
    if (count <= 0) {
      throw new Error("Structural test authorization was absent.");
    }
    source += buffer.subarray(0, count).toString("utf-8");
    const newline = source.indexOf("\n");
    if (
      (newline === -1 && Buffer.byteLength(source) > maxBytes) ||
      (newline !== -1 && Buffer.byteLength(source.slice(0, newline + 1)) > maxBytes)
    ) {
      throw new Error("Structural test authorization was oversized.");
    }
  }
  if (source.indexOf("\n") !== source.length - 1) {
    throw new Error("Structural test authorization was not one frame.");
  }
  return JSON.parse(source);
}
/** @returns {unknown} The untrusted authorization frame. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function readPortFrame(port) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-assignment -- Preserve the existing worker and capability data boundary.; Preserve the existing dynamic value boundary.
    const value = receiveMessageOnPort(port)?.message;
    if (value !== undefined) {
      return value;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw new Error("Structural test authorization timed out.");
}
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function contextForProcess() {
  return isMainThread ? "main" : `worker:${import.meta.filename}`;
}
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function requestAuthorization() {
  const context = contextForProcess();
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
  const port =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    !isMainThread && workerData !== null && typeof workerData === "object"
      ? workerData[workerPortKey]
      : undefined;
  if (!isMainThread && port === undefined) {
    throw new Error("Structural test Worker authorization was absent.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
  const delegatedPublicKey =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    !isMainThread && workerData !== null && typeof workerData === "object"
      ? workerData[`${workerPortKey}PublicKey`]
      : undefined;
  const request = registry.begin(process, context, delegatedPublicKey);
  let response;
  if (port === undefined) {
    if (!fstatSync(authorizationFd).isSocket()) {
      throw new Error("Structural test authorization was not private IPC.");
    }
    writeSync(authorizationFd, `${JSON.stringify({ version: 2, ...request })}\n`);
    response = readFdFrame();
  } else {
    // oxlint-disable-next-line typescript/no-unsafe-call -- The delegated worker port is supplied by the existing worker protocol.
    port.postMessage({ version: 2, ...request });
    response = readPortFrame(port);
    // oxlint-disable-next-line typescript/no-unsafe-call -- Close the same delegated port after reading its response.
    port.close();
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing worker and capability data boundary.
    Reflect.deleteProperty(workerData, workerPortKey);
  }
  if (
    Buffer.byteLength(JSON.stringify(response)) > maxBytes ||
    !exactKeys(response, [
      "version",
      "nonce",
      "context",
      "authorization",
      "expiresAt",
      "capabilities",
      "publicKey",
      "gateAEvalProfile",
      "signature",
      "delegationPrivateKey",
    ])
  ) {
    throw new Error("Structural test authorization response was malformed.");
  }
  const privateKey = createPrivateKey({
    format: "der",
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing worker and capability data boundary.
    key: Buffer.from(response.delegationPrivateKey, "base64"),
    type: "pkcs8",
  });
  const derivedPublic = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
  if (derivedPublic !== response.publicKey) {
    throw new Error("Structural test delegation key did not match.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
  const proof = { ...response };
  delete proof.delegationPrivateKey;
  const capability = registry.complete(process, proof);
  return {
    capability,
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
    gateAEvalProfile: response.gateAEvalProfile,
    privateKey,
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
    publicKey: response.publicKey,
  };
}

// eslint-disable-next-line eslint/func-style, typescript/consistent-return -- Preserve optional worker filename detection. Preserve function declaration hoisting and initialization timing.
function workerFilename(value) {
  try {
    return realpathSync(value instanceof URL ? fileURLToPath(value) : String(value));
  } catch {
    /* File path cannot be resolved. */
  }
}
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function allowedWorkerPaths() {
  const paths = [
    path.resolve(repositoryRoot, "scripts/test-capability-worker-fixture.mjs"),
    path.resolve(repositoryRoot, "scripts/test-capability-worker-timeout-fixture.mjs"),
  ];
  for (const [pkg, relative] of [
    ["vitest", "dist/workers/threads.js"],
    ["eve", "dist/src/compiled/env-runner/node-worker.js"],
  ]) {
    try {
      paths.push(path.resolve(path.dirname(require.resolve(`${pkg}/package.json`)), relative));
    } catch {
      /* optional owner */
    }
  }
  return new Set(
    paths.map((workerPath) => {
      try {
        return realpathSync(workerPath);
      } catch {
        return workerPath;
      }
    }),
  );
}
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function eveRuntimeWorkerPath() {
  return realpathSync(
    path.resolve(
      path.dirname(require.resolve("eve/package.json")),
      "dist/src/compiled/env-runner/node-worker.js",
    ),
  );
}
/** @param {ReturnType<typeof createPrivateKey>} privateKey - Delegation key created by requestAuthorization. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function installWorkerBroker(capabilities, privateKey, publicKey, eveProfile, gateAEvalProfile) {
  const allowed = allowedWorkerPaths();
  const eveWorker = eveRuntimeWorkerPath();
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class AuthorizedTestWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      const exactFilename = workerFilename(filename);
      if (!allowed.has(exactFilename)) {
        // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing worker and capability data boundary.
        super(filename, options);
        return;
      }
      const channel = new MessageChannel();
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
      const existingData =
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
        typeof options.workerData === "object" && options.workerData !== null
          ? options.workerData
          : {};
      /* oxlint-disable typescript/strict-boolean-expressions -- Preserve the existing truthiness for supported values. */
      const eveEnvelope =
        eveProfile && exactFilename === eveWorker
          ? // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing worker and capability data boundary.
            captureEveWorkerEnvelope(options.env, repositoryRoot)
          : undefined;
      /* oxlint-enable typescript/strict-boolean-expressions */
      /* oxlint-disable typescript/strict-boolean-expressions -- Preserve the existing truthiness for supported values. */
      const nestedGateAEvalProfile =
        eveProfile && exactFilename === eveWorker
          ? validateGateAEvalProfile(gateAEvalProfile, repositoryRoot)
          : null;
      /* oxlint-enable typescript/strict-boolean-expressions */
      const isTimeoutFixture = exactFilename?.endsWith(
        "/scripts/test-capability-worker-timeout-fixture.mjs",
      );
      /* oxlint-disable typescript/strict-boolean-expressions -- Preserve the existing truthiness for supported values. */
      // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing worker and capability data boundary.
      super(filename, {
        ...options,
        env: {
          ...workerEnvironment(options.env ?? process.env, eveProfile, eveEnvelope),
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
          APP_BUILDER_TEST_CAPABILITY_ID: undefined,
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
          APP_BUILDER_TEST_MODEL: undefined,
          NODE_OPTIONS: isTimeoutFixture === true ? undefined : `--import=${preloadUrl}`,
        },
        execArgv: [],
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
        transferList: [...(options.transferList ?? []), channel.port2],
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
        workerData: {
          ...existingData,
          [workerPortKey]: channel.port2,
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
          [`${workerPortKey}PublicKey`]: publicKey,
          [workerProfileKey]: eveProfile ? "eve" : "vitest",
          [eveWorkerEnvelopeKey]: eveEnvelope,
          [gateAEvalProfileKey]: nestedGateAEvalProfile,
        },
      });
      /* oxlint-enable typescript/strict-boolean-expressions */
      let settled = false;
      /** @type {{ timeout: ReturnType<typeof setTimeout> | undefined }} */
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
      const timer = { timeout: undefined };
      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer.timeout !== undefined) {
          clearTimeout(timer.timeout);
        }
        channel.port1.close();
      };
      timer.timeout = setTimeout(
        () => {
          cleanup();
          void this.terminate();
        },
        isTimeoutFixture === true ? 250 : timeoutMs,
      );
      timer.timeout.unref();
      channel.port1.unref();
      this.once("error", cleanup);
      this.once("exit", cleanup);
      channel.port1.once("message", (request) => {
        const invalidRequestEnvelope =
          settled ||
          Buffer.byteLength(JSON.stringify(request)) > maxBytes ||
          !exactKeys(request, ["version", "nonce", "context"]);
        if (
          invalidRequestEnvelope ||
          request.version !== 2 ||
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
          typeof request.nonce !== "string" ||
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
          typeof request.context !== "string"
        ) {
          cleanup();
          void this.terminate();
          return;
        }
        const proof = {
          authorization: randomBytes(32).toString("hex"),
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
          capabilities,
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
          context: request.context,
          expiresAt: Date.now() + 5000,
          gateAEvalProfile: nestedGateAEvalProfile,
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
          nonce: request.nonce,
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
          publicKey,
          version: 2,
        };
        const signature = sign(null, Buffer.from(canonical(proof)), privateKey).toString("base64");
        channel.port1.postMessage({
          ...proof,
          delegationPrivateKey: privateKey
            .export({ format: "der", type: "pkcs8" })
            .toString("base64"),
          signature,
        });
        cleanup();
      });
    }
  };
  syncBuiltinESMExports();
}

let installed;
try {
  const authorization = requestAuthorization();
  const eveProfile = isMainThread
    ? process.env.EVE_DEV_WORKER_APP_ROOT === repositoryRoot
    : workerData?.[workerProfileKey] === "eve";
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
  const eveEnvelope = workerData?.[eveWorkerEnvelopeKey];
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
  const workerGateAEvalProfile = workerData?.[gateAEvalProfileKey];
  if (
    !isMainThread &&
    JSON.stringify(workerGateAEvalProfile) !== JSON.stringify(authorization.gateAEvalProfile)
  ) {
    throw new Error("The delegated Gate A eval profile did not match.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
  const gateAEvalProfileToInstall = isMainThread
    ? authorization.gateAEvalProfile
    : workerGateAEvalProfile;
  if (eveProfile) {
    installGateAEvalProfile(process.env, gateAEvalProfileToInstall, repositoryRoot);
  } else {
    for (const name of gateAEnvironmentFields) {
      Reflect.deleteProperty(process.env, name);
    }
  }
  if (!isMainThread) {
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing worker and capability data boundary.
    Reflect.deleteProperty(workerData, gateAEvalProfileKey);
  }
  if (eveEnvelope !== undefined) {
    installEveWorkerEnvelope(process.env, eveEnvelope, repositoryRoot);
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing worker and capability data boundary.
    Reflect.deleteProperty(workerData, eveWorkerEnvelopeKey);
  } else if (eveProfile) {
    process.env.EVE_DEV = "1";
  } else {
    for (const name of [
      "EVE_DEV",
      "WORKFLOW_LOCAL_BASE_URL",
      "PORT",
      "EVE_DEV_WORKFLOW_TRANSPORT_SECRET",
      "EVE_DEVELOPMENT_SANDBOX_RUN_ID",
      "EVE_EVALUATION",
      "EVE_EVALUATION_RUN_ID",
    ]) {
      Reflect.deleteProperty(process.env, name);
    }
  }
  installed = authorization.capability;
  process.env.APP_BUILDER_TEST_CAPABILITY_ID = installed.id;
  process.env.APP_BUILDER_TEST_MODEL = "1";
  installWorkerBroker(
    installed.capabilities,
    authorization.privateKey,
    authorization.publicKey,
    eveProfile,
    authorization.gateAEvalProfile,
  );
} catch {
  if (installed !== undefined) {
    registry.revoke(process, installed);
  }
  delete process.env.APP_BUILDER_TEST_CAPABILITY_ID;
  delete process.env.APP_BUILDER_TEST_MODEL;
}
