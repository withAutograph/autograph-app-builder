"use strict";

/** @typedef {{ version: 2, publicKey: string }} RootKey */
/** @typedef {{ version: 2, nonce: string, context: string, authorization: string, expiresAt: number, capabilities: string[], publicKey: string, gateAEvalProfile: unknown, signature: string }} AuthorizationProof */
/** @typedef {{ context: string, nonce: string, publicKey: string }} PendingRequest */
/** @typedef {{ capabilities: readonly string[], id: string, version: 1 }} TestCapability */
const { randomBytes, verify } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { fstatSync, readFileSync, readSync, realpathSync } = require("node:fs");
const path = require("node:path");

const accessorSymbol = Symbol.for(
  "withAutograph.autograph-app-builder.test-capability-registry.v2",
);
const exactCapabilities = ["mock-model", "simulated-target", "simulated-publication"];
const pending = new WeakMap();
const currentByProcess = new WeakMap();
const usedNonces = new Set();
const maximumFrameBytes = 4096;
const invalidParentError = "Structural test broker parent was invalid.";
const invalidProofError = "Structural test authorization proof was invalid.";
const repositoryRoot = path.resolve(__dirname, "../..");

/** @param {unknown} value JSON value to parse. @returns {string[] | undefined} String array when every entry is a string. */
const parseStringArray = function parseStringArray(value) {
  if (!Array.isArray(value)) return;
  const strings = [];
  for (const entry of value) {
    if (typeof entry !== "string") return;
    strings.push(entry);
  }
  return strings;
};

/** @returns {string[]} Exact command-line arguments of the verified parent process. */
const exactParentArguments = function exactParentArguments() {
  if (process.platform === "linux") {
    if (
      realpathSync(`/proc/${process.ppid}/exe`) !== realpathSync(process.execPath) ||
      realpathSync(`/proc/${process.ppid}/cwd`) !== realpathSync(repositoryRoot)
    ) {
      throw new Error(invalidParentError);
    }
    return readFileSync(`/proc/${process.ppid}/cmdline`, "utf-8")
      .split("\0")
      .filter((entry) => entry.length > 0);
  }
  if (process.platform === "darwin") {
    const python = [
      "import ctypes,json,struct,sys",
      "libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
      "pid=int(sys.argv[1])",
      "mib=(ctypes.c_int*3)(1,49,pid)",
      "size=ctypes.c_size_t(0)",
      "assert libc.sysctl(mib,3,None,ctypes.byref(size),None,0)==0",
      "buf=ctypes.create_string_buffer(size.value)",
      "assert libc.sysctl(mib,3,buf,ctypes.byref(size),None,0)==0",
      "data=buf.raw[:size.value]",
      "argc=struct.unpack_from('i',data)[0]",
      "parts=data[4:].split(b'\\0')[1:]",
      "parts=parts[next(i for i,v in enumerate(parts) if v):]",
      "print(json.dumps([v.decode('utf-8') for v in parts[:argc]]))",
    ].join(";");
    /** @type {unknown} */
    const rawObserved = JSON.parse(
      execFileSync("/usr/bin/python3", ["-I", "-c", python, String(process.ppid)], {
        encoding: "utf-8",
        env: { LC_ALL: "C", NODE_ENV: "test", PATH: "/usr/bin:/bin" },
      }),
    );
    const cwd = execFileSync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(process.ppid), "-d", "cwd", "-Fn"],
      {
        encoding: "utf-8",
        env: { LC_ALL: "C", NODE_ENV: "test", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    const observed = parseStringArray(rawObserved);
    if (
      observed === undefined ||
      cwd === undefined ||
      realpathSync(cwd) !== realpathSync(repositoryRoot)
    ) {
      throw new Error(invalidParentError);
    }
    return observed;
  }
  throw new Error("Structural test broker inspection is unsupported.");
};

const assertTrustedBrokerParent = function assertTrustedBrokerParent() {
  const argv = exactParentArguments();
  const prefix = argv.slice(0, 4);
  const trustedWrapper = [
    [process.execPath, "--import", "tsx", "scripts/run-vitest.mts"],
    [process.execPath, "--import", "tsx", "scripts/run-eve-eval.mts"],
  ].some((expected) => expected.every((value, index) => prefix[index] === value));
  if (!trustedWrapper) {
    throw new Error(invalidParentError);
  }
};

/** @param {unknown} value Object candidate. @param {string[]} keys Expected own keys. */
const exactKeys = function exactKeys(value, keys) {
  return (
    isRecord(value) && Object.keys(value).toSorted().join(",") === [...keys].toSorted().join(",")
  );
};

const readRootKey = function readRootKey() {
  if (!fstatSync(3).isSocket()) {
    throw new Error("Structural test authorization channel was absent.");
  }
  let source = "";
  while (!source.includes("\n")) {
    const buffer = Buffer.alloc(512);
    const count = readSync(3, buffer, 0, buffer.length, null);
    if (count <= 0) {
      throw new Error("Structural test authorization root was absent.");
    }
    source += buffer.subarray(0, count).toString("utf-8");
    const newline = source.indexOf("\n");
    if (
      (newline === -1 && Buffer.byteLength(source) > maximumFrameBytes) ||
      (newline !== -1 && Buffer.byteLength(source.slice(0, newline + 1)) > maximumFrameBytes)
    ) {
      throw new Error("Structural test authorization root was oversized.");
    }
  }
  if (source.indexOf("\n") !== source.length - 1) {
    throw new Error("Structural test authorization root was not one frame.");
  }
  /** @type {unknown} */
  const value = JSON.parse(source);
  if (
    !exactKeys(value, ["version", "publicKey"]) ||
    value.version !== 2 ||
    typeof value.publicKey !== "string" ||
    value.publicKey.length > 512
  ) {
    throw new Error("Structural test authorization root was invalid.");
  }
  return value.publicKey;
};

/** @param {AuthorizationProof} proof Parsed authorization proof. */
const canonical = function canonical(proof) {
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
};
/** @param {NodeJS.Process} processObject @param {string} context @param {string | undefined} delegatedPublicKey */
const begin = function begin(processObject, context, delegatedPublicKey) {
  if (
    context.length < 1 ||
    context.length > 1024 ||
    pending.has(processObject) ||
    currentByProcess.has(processObject)
  ) {
    throw new Error("Structural test authorization could not begin.");
  }
  assertTrustedBrokerParent();
  let publicKey;
  if (context === "main") {
    publicKey = readRootKey();
  } else if (delegatedPublicKey !== undefined) {
    publicKey = delegatedPublicKey;
  }
  if (publicKey === undefined) {
    throw new Error("Structural test delegated root was absent.");
  }
  const nonce = randomBytes(32).toString("hex");
  pending.set(processObject, { context, nonce, publicKey });
  return Object.freeze({ context, nonce });
};
/** @param {unknown} input Untrusted JSON payload. @returns {AuthorizationProof | undefined} Parsed proof when all fields match the contract. */
const parseAuthorizationProof = function parseAuthorizationProof(input) {
  if (
    !exactKeys(input, [
      "version",
      "nonce",
      "context",
      "authorization",
      "expiresAt",
      "capabilities",
      "publicKey",
      "gateAEvalProfile",
      "signature",
    ])
  )
    return;
  if (!isRecord(input)) return;
  return parseProofFields(input);
};
/** @param {Record<string, unknown>} input Record with required proof keys. @returns {AuthorizationProof | undefined} Parsed proof with validated field types. */
const parseProofFields = function parseProofFields(input) {
  if (!isString(input.nonce) || !isString(input.context) || !isString(input.authorization)) return;
  if (!isNumber(input.expiresAt) || !isStringArray(input.capabilities)) return;
  if (!isString(input.publicKey) || !isString(input.signature) || input.version !== 2) return;
  return {
    authorization: input.authorization,
    capabilities: input.capabilities,
    context: input.context,
    expiresAt: input.expiresAt,
    gateAEvalProfile: input.gateAEvalProfile,
    nonce: input.nonce,
    publicKey: input.publicKey,
    signature: input.signature,
    version: 2,
  };
};
/** @param {PendingRequest} request Pending authorization request. @param {AuthorizationProof} proof Parsed authorization proof. @param {number} now Current time in milliseconds. @returns {boolean} Whether the proof meets request and validity constraints. */
const validProofRequest = function validProofRequest(request, proof, now) {
  const matchesRequest =
    proof.nonce === request.nonce &&
    proof.context === request.context &&
    proof.publicKey === request.publicKey;
  const validTime =
    Number.isSafeInteger(proof.expiresAt) &&
    proof.expiresAt >= now &&
    proof.expiresAt <= now + 10_000;
  const validCapabilities =
    [0, 1, 3].includes(proof.capabilities.length) &&
    proof.capabilities.every((entry, index) => entry === exactCapabilities[index]);
  return (
    proof.version === 2 &&
    !usedNonces.has(proof.nonce) &&
    /^[0-9a-f]{64}$/u.test(proof.authorization) &&
    matchesRequest &&
    validTime &&
    validCapabilities
  );
};
/** @param {AuthorizationProof} proof Parsed proof whose signature is checked. @returns {boolean} Whether its signature verifies. */
const validProofSignature = function validProofSignature(proof) {
  return Boolean(
    verify(
      null,
      Buffer.from(canonical(proof)),
      { format: "der", key: Buffer.from(proof.publicKey, "base64"), type: "spki" },
      Buffer.from(proof.signature, "base64"),
    ),
  );
};
/** @param {NodeJS.Process} processObject Process receiving the proof. @param {unknown} input Untrusted authorization payload. @returns {TestCapability} Validated capability. */
const complete = function complete(processObject, input) {
  const request = pending.get(processObject);
  pending.delete(processObject);
  const proof = parseAuthorizationProof(input);
  const now = Date.now();
  if (
    request === undefined ||
    proof === undefined ||
    !validProofRequest(request, proof, now) ||
    !validProofSignature(proof)
  )
    throw new Error(invalidProofError);
  usedNonces.add(proof.nonce);
  const capability = Object.freeze({
    capabilities: Object.freeze([...proof.capabilities]),
    id: proof.authorization,
    version: 1,
  });
  currentByProcess.set(processObject, capability);
  if (!Object.hasOwn(processObject, accessorSymbol))
    Object.defineProperty(processObject, accessorSymbol, {
      configurable: false,
      enumerable: false,
      value: () => currentByProcess.get(processObject),
      writable: false,
    });
  return capability;
};

const current = function current(processObject) {
  return currentByProcess.get(processObject);
};
/** @param {NodeJS.Process} processObject @param {TestCapability} capability */
const revoke = function revoke(processObject, capability) {
  if (currentByProcess.get(processObject) === capability) {
    currentByProcess.delete(processObject);
  }
};
module.exports = Object.freeze({ begin, complete, current, revoke });
