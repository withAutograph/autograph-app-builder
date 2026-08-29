import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
} from "node:crypto";
import {
  fstatSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
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
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRootStat = statSync(repositoryRoot, { bigint: true });
if (
  !isAbsolute(repositoryRoot) ||
  realpathSync(repositoryRoot) !== repositoryRoot ||
  !repositoryRootStat.isDirectory() ||
  repositoryRootStat.uid !== BigInt(process.getuid?.() ?? -1) ||
  (repositoryRootStat.mode & BigInt(0o022)) !== BigInt(0)
)
  throw new Error("Structural test package root was not owner-bound.");
const require = createRequire(import.meta.url);
const registry = require(
  resolve(repositoryRoot, "lib/testing/test-capability-registry.cjs"),
);
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
]);
delete process.env.NODE_OPTIONS;

function workerEnvironment(source, eveProfile, eveEnvelope) {
  const environment = { PATH: "/usr/bin:/bin" };
  for (const name of allowedWorkerEnvironment)
    if (name !== "EVE_DEV_WORKER_APP_ROOT" && source[name] !== undefined)
      environment[name] = source[name];
  const hasEveEnvelope = eveEnvelope !== undefined;
  environment.EVE_DEV_WORKER_APP_ROOT = hasEveEnvelope
    ? undefined
    : repositoryRoot;
  environment.EVE_DEV = hasEveEnvelope
    ? undefined
    : eveProfile
      ? "1"
      : undefined;
  if (eveEnvelope?.bodyTimeout === "360000")
    environment.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = eveEnvelope.bodyTimeout;
  return environment;
}

function canonical(proof) {
  return JSON.stringify({
    version: proof.version,
    nonce: proof.nonce,
    context: proof.context,
    authorization: proof.authorization,
    expiresAt: proof.expiresAt,
    capabilities: proof.capabilities,
    publicKey: proof.publicKey,
    gateAEvalProfile: proof.gateAEvalProfile,
  });
}
function exactKeys(value, keys) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function readFdFrame() {
  let source = "";
  while (!source.includes("\n")) {
    const buffer = Buffer.alloc(512);
    const count = readSync(authorizationFd, buffer, 0, buffer.length, null);
    if (count <= 0)
      throw new Error("Structural test authorization was absent.");
    source += buffer.subarray(0, count).toString("utf8");
    const newline = source.indexOf("\n");
    if (
      (newline < 0 && Buffer.byteLength(source) > maxBytes) ||
      (newline >= 0 &&
        Buffer.byteLength(source.slice(0, newline + 1)) > maxBytes)
    )
      throw new Error("Structural test authorization was oversized.");
  }
  if (source.indexOf("\n") !== source.length - 1)
    throw new Error("Structural test authorization was not one frame.");
  return JSON.parse(source);
}
function readPortFrame(port) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = receiveMessageOnPort(port)?.message;
    if (value !== undefined) return value;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw new Error("Structural test authorization timed out.");
}
function contextForProcess() {
  return isMainThread ? "main" : `worker:${fileURLToPath(import.meta.url)}`;
}
function requestAuthorization() {
  const context = contextForProcess();
  const port =
    !isMainThread && workerData && typeof workerData === "object"
      ? workerData[workerPortKey]
      : undefined;
  if (!isMainThread && port === undefined)
    throw new Error("Structural test Worker authorization was absent.");
  const delegatedPublicKey =
    !isMainThread && workerData && typeof workerData === "object"
      ? workerData[`${workerPortKey}PublicKey`]
      : undefined;
  const request = registry.begin(process, context, delegatedPublicKey);
  let response;
  if (port !== undefined) {
    port.postMessage({ version: 2, ...request });
    response = readPortFrame(port);
    port.close();
    delete workerData[workerPortKey];
  } else {
    if (!fstatSync(authorizationFd).isSocket())
      throw new Error("Structural test authorization was not private IPC.");
    writeSync(
      authorizationFd,
      `${JSON.stringify({ version: 2, ...request })}\n`,
    );
    response = readFdFrame();
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
  )
    throw new Error("Structural test authorization response was malformed.");
  const privateKey = createPrivateKey({
    key: Buffer.from(response.delegationPrivateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const derivedPublic = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
  if (derivedPublic !== response.publicKey)
    throw new Error("Structural test delegation key did not match.");
  const proof = { ...response };
  delete proof.delegationPrivateKey;
  const capability = registry.complete(process, proof);
  return {
    capability,
    privateKey,
    publicKey: response.publicKey,
    gateAEvalProfile: response.gateAEvalProfile,
  };
}

function workerFilename(value) {
  try {
    return realpathSync(
      value instanceof URL ? fileURLToPath(value) : String(value),
    );
  } catch {
    return undefined;
  }
}
function allowedWorkerPaths() {
  const paths = [
    resolve(repositoryRoot, "scripts/test-capability-worker-fixture.mjs"),
    resolve(
      repositoryRoot,
      "scripts/test-capability-worker-timeout-fixture.mjs",
    ),
  ];
  for (const [pkg, relative] of [
    ["vitest", "dist/workers/threads.js"],
    ["eve", "dist/src/compiled/env-runner/node-worker.js"],
  ]) {
    try {
      paths.push(
        resolve(dirname(require.resolve(`${pkg}/package.json`)), relative),
      );
    } catch {
      /* optional owner */
    }
  }
  return new Set(
    paths.map((path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    }),
  );
}
function eveRuntimeWorkerPath() {
  return realpathSync(
    resolve(
      dirname(require.resolve("eve/package.json")),
      "dist/src/compiled/env-runner/node-worker.js",
    ),
  );
}
function installWorkerBroker(
  capabilities,
  privateKey,
  publicKey,
  eveProfile,
  gateAEvalProfile,
) {
  const allowed = allowedWorkerPaths();
  const eveWorker = eveRuntimeWorkerPath();
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class AuthorizedTestWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      const exactFilename = workerFilename(filename);
      if (!allowed.has(exactFilename)) {
        super(filename, options);
        return;
      }
      const channel = new MessageChannel();
      const existingData =
        typeof options.workerData === "object" && options.workerData !== null
          ? options.workerData
          : {};
      const eveEnvelope =
        eveProfile && exactFilename === eveWorker
          ? captureEveWorkerEnvelope(options.env, repositoryRoot)
          : undefined;
      const nestedGateAEvalProfile =
        eveProfile && exactFilename === eveWorker
          ? validateGateAEvalProfile(gateAEvalProfile, repositoryRoot)
          : null;
      const isTimeoutFixture = exactFilename?.endsWith(
        "/scripts/test-capability-worker-timeout-fixture.mjs",
      );
      super(filename, {
        ...options,
        workerData: {
          ...existingData,
          [workerPortKey]: channel.port2,
          [`${workerPortKey}PublicKey`]: publicKey,
          [workerProfileKey]: eveProfile ? "eve" : "vitest",
          [eveWorkerEnvelopeKey]: eveEnvelope,
          [gateAEvalProfileKey]: nestedGateAEvalProfile,
        },
        transferList: [...(options.transferList ?? []), channel.port2],
        execArgv: [],
        env: {
          ...workerEnvironment(
            options.env ?? process.env,
            eveProfile,
            eveEnvelope,
          ),
          NODE_OPTIONS: isTimeoutFixture ? undefined : `--import=${preloadUrl}`,
          APP_BUILDER_TEST_MODEL: undefined,
          APP_BUILDER_TEST_CAPABILITY_ID: undefined,
        },
      });
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        channel.port1.close();
      };
      const timeout = setTimeout(
        () => {
          cleanup();
          void this.terminate();
        },
        isTimeoutFixture ? 250 : timeoutMs,
      );
      timeout.unref();
      channel.port1.unref();
      this.once("error", cleanup);
      this.once("exit", cleanup);
      channel.port1.once("message", (request) => {
        if (
          settled ||
          Buffer.byteLength(JSON.stringify(request)) > maxBytes ||
          !exactKeys(request, ["version", "nonce", "context"]) ||
          request.version !== 2 ||
          typeof request.nonce !== "string" ||
          typeof request.context !== "string"
        ) {
          cleanup();
          void this.terminate();
          return;
        }
        const proof = {
          version: 2,
          nonce: request.nonce,
          context: request.context,
          authorization: randomBytes(32).toString("hex"),
          expiresAt: Date.now() + 5_000,
          capabilities,
          publicKey,
          gateAEvalProfile: nestedGateAEvalProfile,
        };
        const signature = sign(
          null,
          Buffer.from(canonical(proof)),
          privateKey,
        ).toString("base64");
        channel.port1.postMessage({
          ...proof,
          signature,
          delegationPrivateKey: privateKey
            .export({ format: "der", type: "pkcs8" })
            .toString("base64"),
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
  const eveEnvelope = workerData?.[eveWorkerEnvelopeKey];
  const workerGateAEvalProfile = workerData?.[gateAEvalProfileKey];
  if (
    !isMainThread &&
    JSON.stringify(workerGateAEvalProfile) !==
      JSON.stringify(authorization.gateAEvalProfile)
  )
    throw new Error("The delegated Gate A eval profile did not match.");
  const gateAEvalProfileToInstall = isMainThread
    ? authorization.gateAEvalProfile
    : workerGateAEvalProfile;
  if (eveProfile)
    installGateAEvalProfile(
      process.env,
      gateAEvalProfileToInstall,
      repositoryRoot,
    );
  else for (const name of gateAEnvironmentFields) delete process.env[name];
  if (!isMainThread) delete workerData[gateAEvalProfileKey];
  if (eveEnvelope !== undefined) {
    installEveWorkerEnvelope(process.env, eveEnvelope, repositoryRoot);
    delete workerData[eveWorkerEnvelopeKey];
  } else if (eveProfile) process.env.EVE_DEV = "1";
  else {
    for (const name of [
      "EVE_DEV",
      "WORKFLOW_LOCAL_BASE_URL",
      "PORT",
      "EVE_DEV_WORKFLOW_TRANSPORT_SECRET",
      "EVE_DEVELOPMENT_SANDBOX_RUN_ID",
      "EVE_EVALUATION",
      "EVE_EVALUATION_RUN_ID",
    ])
      delete process.env[name];
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
  if (installed !== undefined) registry.revoke(process, installed);
  delete process.env.APP_BUILDER_TEST_CAPABILITY_ID;
  delete process.env.APP_BUILDER_TEST_MODEL;
}
