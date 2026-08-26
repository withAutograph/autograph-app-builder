"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- shared CommonJS singleton */
const { randomBytes, verify } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { fstatSync, readFileSync, readSync, realpathSync } = require("node:fs");
const { resolve } = require("node:path");
const accessorSymbol = Symbol.for(
  "withAutograph.autograph-app-builder.test-capability-registry.v2",
);
const exactCapabilities = [
  "mock-model",
  "simulated-target",
  "simulated-publication",
];
const pending = new WeakMap();
const currentByProcess = new WeakMap();
const usedNonces = new Set();
const maximumFrameBytes = 4096;
const repositoryRoot = resolve(__dirname, "../..");

function exactParentArguments() {
  if (process.platform === "linux") {
    if (
      realpathSync(`/proc/${process.ppid}/exe`) !==
        realpathSync(process.execPath) ||
      realpathSync(`/proc/${process.ppid}/cwd`) !== realpathSync(repositoryRoot)
    )
      throw new Error("Structural test broker parent was invalid.");
    return readFileSync(`/proc/${process.ppid}/cmdline`, "utf8")
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
    const observed = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        ["-I", "-c", python, String(process.ppid)],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
        },
      ),
    );
    const cwd = execFileSync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(process.ppid), "-d", "cwd", "-Fn"],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    if (
      !Array.isArray(observed) ||
      observed.some((entry) => typeof entry !== "string") ||
      cwd === undefined ||
      realpathSync(cwd) !== realpathSync(repositoryRoot)
    )
      throw new Error("Structural test broker parent was invalid.");
    return observed;
  }
  throw new Error("Structural test broker inspection is unsupported.");
}

function assertTrustedBrokerParent() {
  const argv = exactParentArguments();
  const prefix = argv.slice(0, 4);
  const trustedWrapper = [
    [process.execPath, "--import", "tsx", "scripts/run-vitest.mts"],
    [process.execPath, "--import", "tsx", "scripts/run-eve-eval.mts"],
  ].some((expected) =>
    expected.every((value, index) => prefix[index] === value),
  );
  if (!trustedWrapper)
    throw new Error("Structural test broker parent was invalid.");
}

function readRootKey() {
  if (!fstatSync(3).isSocket())
    throw new Error("Structural test authorization channel was absent.");
  let source = "";
  while (!source.includes("\n")) {
    const buffer = Buffer.alloc(512);
    const count = readSync(3, buffer, 0, buffer.length, null);
    if (count <= 0)
      throw new Error("Structural test authorization root was absent.");
    source += buffer.subarray(0, count).toString("utf8");
    const newline = source.indexOf("\n");
    if (
      (newline < 0 && Buffer.byteLength(source) > maximumFrameBytes) ||
      (newline >= 0 &&
        Buffer.byteLength(source.slice(0, newline + 1)) > maximumFrameBytes)
    )
      throw new Error("Structural test authorization root was oversized.");
  }
  if (source.indexOf("\n") !== source.length - 1)
    throw new Error("Structural test authorization root was not one frame.");
  const value = JSON.parse(source);
  if (
    !exactKeys(value, ["version", "publicKey"]) ||
    value.version !== 2 ||
    typeof value.publicKey !== "string" ||
    value.publicKey.length > 512
  )
    throw new Error("Structural test authorization root was invalid.");
  return value.publicKey;
}

function exactKeys(value, keys) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
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
  });
}
function begin(processObject, context, delegatedPublicKey) {
  if (
    typeof processObject !== "object" ||
    processObject === null ||
    typeof context !== "string" ||
    context.length < 1 ||
    context.length > 1024 ||
    pending.has(processObject) ||
    currentByProcess.has(processObject)
  )
    throw new Error("Structural test authorization could not begin.");
  assertTrustedBrokerParent();
  const publicKey =
    context === "main"
      ? readRootKey()
      : typeof delegatedPublicKey === "string"
        ? delegatedPublicKey
        : undefined;
  if (publicKey === undefined)
    throw new Error("Structural test delegated root was absent.");
  const nonce = randomBytes(32).toString("hex");
  pending.set(processObject, { nonce, context, publicKey });
  return Object.freeze({ nonce, context });
}
function complete(processObject, proof) {
  const request = pending.get(processObject);
  pending.delete(processObject);
  const now = Date.now();
  if (
    request === undefined ||
    !exactKeys(proof, [
      "version",
      "nonce",
      "context",
      "authorization",
      "expiresAt",
      "capabilities",
      "publicKey",
      "signature",
    ]) ||
    proof.version !== 2 ||
    proof.nonce !== request.nonce ||
    proof.context !== request.context ||
    proof.publicKey !== request.publicKey ||
    usedNonces.has(proof.nonce) ||
    typeof proof.authorization !== "string" ||
    !/^[0-9a-f]{64}$/u.test(proof.authorization) ||
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt < now ||
    proof.expiresAt > now + 10_000 ||
    !Array.isArray(proof.capabilities) ||
    ![1, 3].includes(proof.capabilities.length) ||
    proof.capabilities.some(
      (entry, index) => entry !== exactCapabilities[index],
    ) ||
    typeof proof.publicKey !== "string" ||
    typeof proof.signature !== "string" ||
    !verify(
      null,
      Buffer.from(canonical(proof)),
      {
        key: Buffer.from(proof.publicKey, "base64"),
        format: "der",
        type: "spki",
      },
      Buffer.from(proof.signature, "base64"),
    )
  )
    throw new Error("Structural test authorization proof was invalid.");
  usedNonces.add(proof.nonce);
  const capability = Object.freeze({
    version: 1,
    id: proof.authorization,
    capabilities: Object.freeze([...proof.capabilities]),
  });
  currentByProcess.set(processObject, capability);
  if (!Object.prototype.hasOwnProperty.call(processObject, accessorSymbol))
    Object.defineProperty(processObject, accessorSymbol, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: () => currentByProcess.get(processObject),
    });
  return capability;
}
function current(processObject) {
  return currentByProcess.get(processObject);
}
function revoke(processObject, capability) {
  if (currentByProcess.get(processObject) === capability)
    currentByProcess.delete(processObject);
}
module.exports = Object.freeze({ begin, complete, current, revoke });
