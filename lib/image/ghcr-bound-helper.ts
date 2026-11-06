import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const identityDomain = "autograph-app-builder-ghcr-keyring-v2";
const registry = "https://ghcr.io";
const githubHost = "github.com";
const githubOrganization = "withAutograph";
const maximumCredentialBytes = 4096;
const maximumGhOutputBytes = 256 * 1024;
const ghTimeoutMs = 10_000;
const malformedAuthStatus = "GitHub authentication status was malformed.";
const writePackagesScope = "write:packages";
const unexpectedStateContents = "GitHub state root has unexpected contents.";
const rejectedIdentity = "GitHub keyring identity did not match approval.";
const ghcrIdentityMismatch = "GHCR provider identity did not match approval.";
const unsafeGitHubState = "GitHub state root is unsafe.";
const invalidStateContents = unexpectedStateContents;

interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = boolean | JsonObject | null | number | string | JsonValue[];

const jsonStringSchema = z.string();

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && !Array.isArray(value) && typeof value === "object";

const parseJsonObject = (payload: string, errorMessage: string): JsonObject => {
  let parsed: JsonValue;
  try {
    const decoded: unknown = JSON.parse(payload);
    if (
      decoded === null ||
      Array.isArray(decoded) ||
      Object.getPrototypeOf(decoded) !== Object.prototype
    ) {
      throw new Error(errorMessage);
    }
    // SAFETY: JSON.parse produced a plain object, so its own enumerable values are JSON values.
    parsed = decoded;
  } catch {
    throw new Error(errorMessage);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(errorMessage);
  }
  return parsed;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function readBoundedInput(fd: number, maximumBytes: number): Buffer {
  const input = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  try {
    for (;;) {
      const count = readSync(fd, input, offset, input.length - offset, null);
      if (count === 0) {
        return Buffer.from(input.subarray(0, offset));
      }
      offset += count;
      if (offset > maximumBytes) {
        throw new Error("Credential input exceeded the closed size limit.");
      }
    }
  } finally {
    input.fill(0);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ghcrIdentityDigest(
  username: string,
  provenanceDigest: string,
  secret: Uint8Array,
): string {
  if (!/^[a-f0-9]{64}$/u.test(provenanceDigest)) {
    throw new Error("GHCR provenance digest is invalid.");
  }
  return createHash("sha256")
    .update(identityDomain)
    .update("\0")
    .update(provenanceDigest)
    .update("\0")
    .update(username)
    .update("\0")
    .update(secret)
    .digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertBoundGhcrPayload(
  payload: string,
  expectedUsername: string,
  expectedProvenanceDigest: string,
  expectedIdentityDigest: string,
): void {
  const record = parseJsonObject(payload, "GHCR provider returned malformed output.");
  const secretValue = record.Secret;
  if (Object.keys(record).toSorted().join(",") !== "Secret,ServerURL,Username") {
    throw new Error(ghcrIdentityMismatch);
  }
  if (record.ServerURL !== registry || record.Username !== expectedUsername) {
    throw new Error(ghcrIdentityMismatch);
  }
  const parsedSecret = jsonStringSchema.safeParse(secretValue);
  if (!parsedSecret.success) {
    throw new TypeError(ghcrIdentityMismatch);
  }
  if (!/^[A-Za-z0-9_]{20,4096}$/u.test(parsedSecret.data)) {
    throw new Error(ghcrIdentityMismatch);
  }
  const secret = Buffer.from(parsedSecret.data, "ascii");
  const observed = Buffer.from(
    ghcrIdentityDigest(expectedUsername, expectedProvenanceDigest, secret),
    "hex",
  );
  const expected = Buffer.from(expectedIdentityDigest, "hex");
  try {
    if (observed.length !== 32 || expected.length !== 32 || !timingSafeEqual(observed, expected)) {
      throw new Error("GHCR provider identity drifted after approval.");
    }
  } finally {
    secret.fill(0);
    observed.fill(0);
    expected.fill(0);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertVerifiedGhcrLoginPayload(
  payload: string,
  expectedUsername: string,
  expectedProvenanceDigest: string,
  expectedIdentityDigest: string,
): void {
  const record = parseJsonObject(payload, "GitHub keyring verification returned malformed output.");
  if (
    Object.keys(record).toSorted().join(",") !== "Username,identityDigest,provenanceDigest" ||
    record.Username !== expectedUsername ||
    record.provenanceDigest !== expectedProvenanceDigest ||
    record.identityDigest !== expectedIdentityDigest
  ) {
    throw new Error("GitHub keyring verification did not match approval.");
  }
}

type GhStatusRecord = Readonly<{
  active: true;
  gitProtocol: "https";
  host: "github.com";
  login: string;
  scopes: string;
  state: "success";
  tokenSource: "keyring";
}>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseGhAuthStatus(payload: string, expectedUsername: string): GhStatusRecord {
  const parsed = parseJsonObject(payload, malformedAuthStatus);
  if (Object.keys(parsed).join(",") !== "hosts") {
    throw new Error(malformedAuthStatus);
  }
  const { hosts } = parsed;
  if (!isJsonObject(hosts) || Object.keys(hosts).join(",") !== githubHost) {
    throw new Error(malformedAuthStatus);
  }
  const records = hosts[githubHost];
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error("GitHub authentication status was ambiguous.");
  }
  const record = records.at(0);
  if (record === undefined || !isJsonObject(record)) {
    throw new Error(malformedAuthStatus);
  }
  const value = record;
  const scopesValue = value.scopes;
  if (
    Object.keys(value).toSorted().join(",") !==
    "active,gitProtocol,host,login,scopes,state,tokenSource"
  ) {
    throw new TypeError(rejectedIdentity);
  }
  if (value.active !== true || value.gitProtocol !== "https" || value.host !== githubHost) {
    throw new Error(rejectedIdentity);
  }
  if (
    value.login !== expectedUsername ||
    value.state !== "success" ||
    value.tokenSource !== "keyring"
  ) {
    throw new Error(rejectedIdentity);
  }
  const parsedScopes = jsonStringSchema.safeParse(scopesValue);
  if (!parsedScopes.success) {
    throw new TypeError(rejectedIdentity);
  }
  const scopes = new Set(
    parsedScopes.data
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  if (!scopes.has(writePackagesScope)) {
    throw new Error("GitHub keyring identity lacks package-write authority.");
  }
  return {
    active: true,
    gitProtocol: "https",
    host: githubHost,
    login: expectedUsername,
    scopes: parsedScopes.data,
    state: "success",
    tokenSource: "keyring",
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error("GHCR binding environment is incomplete.");
  }
  return value;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function exactGithubCli(): string {
  const path = requiredEnvironment("APP_BUILDER_IMAGE_GH_BIN");
  const expectedSha256 = requiredEnvironment("APP_BUILDER_GH_SHA256");
  if (!nodePath.isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error("GitHub CLI executable is invalid.");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("GitHub CLI executable is invalid.");
  }
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== expectedSha256) {
    throw new Error("GitHub CLI executable drifted after approval.");
  }
  return path;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function githubConfigDigest(configRoot: string): string {
  if (!nodePath.isAbsolute(configRoot) || realpathSync(configRoot) !== configRoot) {
    throw new Error("GitHub configuration root is invalid.");
  }
  const uid = process.getuid?.();
  const rootStat = lstatSync(configRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    uid === undefined ||
    rootStat.uid !== uid
  ) {
    throw new Error("GitHub configuration root is unsafe.");
  }
  if ((rootStat.mode & 0o022) !== 0) {
    throw new Error("GitHub configuration root is unsafe.");
  }
  const records: string[] = [];
  for (const name of ["config.yml", "hosts.yml"] as const) {
    const path = nodePath.join(configRoot, name);
    if (realpathSync(path) !== path) {
      throw new Error("GitHub configuration file is unsafe.");
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error("GitHub configuration file is unsafe.");
    }
    const bytes = readFileSync(path);
    try {
      if (/^\s*(?:oauth_token|token)\s*:/imu.test(bytes.toString("utf-8"))) {
        throw new Error("Plaintext GitHub credentials are not eligible.");
      }
      records.push(`${name}\0${createHash("sha256").update(bytes).digest("hex")}`);
    } finally {
      bytes.fill(0);
    }
  }
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertGithubStateRoot(stateRoot: string): void {
  if (
    !nodePath.isAbsolute(stateRoot) ||
    !existsSync(stateRoot) ||
    realpathSync(stateRoot) !== stateRoot
  ) {
    throw new Error("GitHub state root is invalid.");
  }
  const uid = process.getuid?.();
  const rootStat = lstatSync(stateRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    uid === undefined ||
    rootStat.uid !== uid
  ) {
    throw new Error(unsafeGitHubState);
  }
  if ((rootStat.mode & 0o777) !== 0o700) {
    throw new Error(unsafeGitHubState);
  }

  const rootEntries = readdirSync(stateRoot, { withFileTypes: true });
  if (rootEntries.length === 0) {
    return;
  }
  const [rootEntry] = rootEntries;
  if (rootEntries.length !== 1 || rootEntry?.name !== "gh") {
    throw new Error(unexpectedStateContents);
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error(unexpectedStateContents);
  }
  const ghRoot = nodePath.join(stateRoot, "gh");
  if (realpathSync(ghRoot) !== ghRoot) {
    throw new Error("GitHub state root contains a symbolic link.");
  }
  const ghStat = lstatSync(ghRoot);
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  if (ghStat.uid !== uid || (ghStat.mode & 0o022) !== 0) {
    throw new Error(unsafeGitHubState);
  }

  const ghEntries = readdirSync(ghRoot, { withFileTypes: true });
  if (ghEntries.length === 0) {
    return;
  }
  const [ghEntry] = ghEntries;
  if (ghEntries.length !== 1 || ghEntry?.name !== "device-id") {
    throw new Error(invalidStateContents);
  }
  if (!ghEntry.isFile() || ghEntry.isSymbolicLink()) {
    throw new Error(invalidStateContents);
  }
  const deviceId = nodePath.join(ghRoot, "device-id");
  if (realpathSync(deviceId) !== deviceId) {
    throw new Error("GitHub state root contains a symbolic link.");
  }
  const deviceStat = lstatSync(deviceId);
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  if (deviceStat.uid !== uid || deviceStat.nlink !== 1 || (deviceStat.mode & 0o022) !== 0) {
    throw new Error(unsafeGitHubState);
  }
  if (deviceStat.size === 0 || deviceStat.size > 256) {
    throw new Error("GitHub state root is unsafe.");
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function githubStateDigest(stateRoot: string): string {
  assertGithubStateRoot(stateRoot);
  const deviceId = nodePath.join(stateRoot, "gh", "device-id");
  if (!existsSync(deviceId)) {
    return createHash("sha256").update("empty").digest("hex");
  }
  const bytes = readFileSync(deviceId);
  try {
    return createHash("sha256")
      .update("gh/device-id\0")
      .update(createHash("sha256").update(bytes).digest("hex"))
      .digest("hex");
  } finally {
    bytes.fill(0);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function githubEnvironment(): NodeJS.ProcessEnv {
  const configRoot = requiredEnvironment("APP_BUILDER_GH_CONFIG_DIR");
  const expectedDigest = requiredEnvironment("APP_BUILDER_GH_CONFIG_DIGEST");
  const stateRoot = requiredEnvironment("APP_BUILDER_GH_STATE_DIR");
  if (githubConfigDigest(configRoot) !== expectedDigest) {
    throw new Error("GitHub configuration drifted after approval.");
  }
  assertGithubStateRoot(stateRoot);
  return {
    GH_CONFIG_DIR: configRoot,
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
    LANG: "C",
    LC_ALL: "C",
    NODE_ENV: "production",
    NO_COLOR: "1",
    PATH: "/usr/bin:/bin",
    XDG_STATE_HOME: stateRoot,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function assertExpectedGithubState(): void {
  const stateRoot = requiredEnvironment("APP_BUILDER_GH_STATE_DIR");
  const expectedDigest = process.env.APP_BUILDER_GH_STATE_DIGEST;
  assertGithubStateRoot(stateRoot);
  if (expectedDigest === undefined) {
    return;
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest) || githubStateDigest(stateRoot) !== expectedDigest) {
    throw new Error("GitHub state drifted after approval.");
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function runBoundedGh(args: readonly string[]): Promise<Buffer> {
  const executable = exactGithubCli();
  assertExpectedGithubState();
  const child = spawn(executable, [...args], {
    detached: false,
    env: githubEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let overflow = false;
  const terminate = () => {
    if (child.pid === undefined) {
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    const copy = Buffer.from(chunk);
    outputBytes += copy.length;
    if (outputBytes > maximumGhOutputBytes) {
      overflow = true;
      copy.fill(0);
      terminate();
    } else {
      stdout.push(copy);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const copy = Buffer.from(chunk);
    outputBytes += copy.length;
    if (outputBytes > maximumGhOutputBytes) {
      overflow = true;
      copy.fill(0);
      terminate();
    } else {
      stderr.push(copy);
    }
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, ghTimeoutMs);
  try {
    const closeEvent: [number | null, NodeJS.Signals | null] = await once(child, "close");
    const status = closeEvent[0] ?? -1;
    if (timedOut || overflow || status !== 0) {
      throw new Error("GitHub credential read-back failed.");
    }
    assertExpectedGithubState();
    return Buffer.concat(stdout);
  } finally {
    clearTimeout(timeout);
    for (const chunk of stdout) {
      chunk.fill(0);
    }
    for (const chunk of stderr) {
      chunk.fill(0);
    }
  }
}

// Keep token parsing private to this credential boundary.
// oxlint-disable-next-line unicorn/consistent-function-scoping
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function parseExactToken(raw: Buffer): Buffer {
  let end = raw.length;
  if (end > 0 && raw[end - 1] === 0x0a) {
    end -= 1;
  }
  if (end > 0 && raw[end - 1] === 0x0d) {
    end -= 1;
  }
  const token = Buffer.from(raw.subarray(0, end));
  // Keep token validation local to the parser.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const validByte = (byte: number) => {
    if (byte >= 0x30 && byte <= 0x39) {
      return true;
    }
    if (byte >= 0x41 && byte <= 0x5a) {
      return true;
    }
    if (byte === 0x5f) {
      return true;
    }
    return byte >= 0x61 && byte <= 0x7a;
  };
  if (token.length < 20 || token.length > maximumCredentialBytes) {
    token.fill(0);
    throw new Error("GitHub credential read-back was malformed.");
  }
  if (token.some((byte) => !validByte(byte))) {
    token.fill(0);
    throw new Error("GitHub credential read-back was malformed.");
  }
  return token;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readApprovedKeyringToken(username: string): Promise<Buffer> {
  const status = await runBoundedGh([
    "auth",
    "status",
    "--active",
    "--hostname",
    githubHost,
    "--json",
    "hosts",
  ]);
  try {
    parseGhAuthStatus(status.toString("utf-8"), username);
  } finally {
    status.fill(0);
  }
  const raw = await runBoundedGh(["auth", "token", "--hostname", githubHost, "--user", username]);
  try {
    return parseExactToken(raw);
  } finally {
    raw.fill(0);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function verifyNamespace(username: string): Promise<void> {
  const [user, membership] = await Promise.all([
    runBoundedGh(["api", "/user", "--jq", ".login"]),
    runBoundedGh([
      "api",
      `/user/memberships/orgs/${githubOrganization}`,
      "--jq",
      "[.state,.role,.organization.login] | @tsv",
    ]),
  ]);
  try {
    const actualUser = user.toString("utf-8").trim();
    const actualMembership = membership.toString("utf-8").trim();
    if (actualUser !== username || actualMembership !== `active\tadmin\t${githubOrganization}`) {
      throw new Error("GitHub namespace authority did not match approval.");
    }
  } finally {
    user.fill(0);
    membership.fill(0);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function writeCredential(username: string, token: Buffer): Promise<void> {
  assertExpectedGithubState();
  const prefix = Buffer.from(
    `{"ServerURL":"${registry}","Username":"${username}","Secret":"`,
    "utf-8",
  );
  const suffix = Buffer.from('"}\n', "utf-8");
  const payload = Buffer.concat([prefix, token, suffix]);
  try {
    await pipeline(Readable.from([payload]), process.stdout, { end: false });
  } finally {
    prefix.fill(0);
    suffix.fill(0);
    payload.fill(0);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function writeVerifiedLogin(
  username: string,
  provenanceDigest: string,
  identityDigest: string,
): Promise<void> {
  assertExpectedGithubState();
  const payload = Buffer.from(
    `${JSON.stringify({
      Username: username,
      identityDigest,
      provenanceDigest,
    })}\n`,
    "utf-8",
  );
  try {
    await pipeline(Readable.from([payload]), process.stdout, { end: false });
  } finally {
    payload.fill(0);
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function run(): Promise<void> {
  const { 2: mode } = process.argv;
  if (process.argv.length !== 3 || (mode !== "get" && mode !== "verify-login")) {
    throw new Error("Only the closed GHCR credential protocols are supported.");
  }
  if (mode === "get") {
    requiredEnvironment("APP_BUILDER_GH_STATE_DIGEST");
    const request = readBoundedInput(0, 256).toString("utf-8").trim();
    if (request !== "ghcr.io" && request !== registry) {
      throw new Error("GHCR provider request named an unsupported registry.");
    }
  } else if (process.env.APP_BUILDER_GH_STATE_DIGEST !== undefined) {
    throw new Error("Initial GHCR login cannot inherit approved state.");
  }
  const username = requiredEnvironment("APP_BUILDER_GHCR_USERNAME");
  const provenanceDigest = requiredEnvironment("APP_BUILDER_GHCR_PROVENANCE_DIGEST");
  const expectedDigest = requiredEnvironment("APP_BUILDER_GHCR_IDENTITY_DIGEST");
  const token = await readApprovedKeyringToken(username);
  try {
    const observed = Buffer.from(ghcrIdentityDigest(username, provenanceDigest, token), "hex");
    const expected = Buffer.from(expectedDigest, "hex");
    try {
      if (
        observed.length !== 32 ||
        expected.length !== 32 ||
        !timingSafeEqual(observed, expected)
      ) {
        throw new Error("GitHub keyring credential drifted after approval.");
      }
    } finally {
      observed.fill(0);
      expected.fill(0);
    }
    if (mode === "verify-login") {
      const rawApproved = readBoundedInput(0, maximumCredentialBytes);
      let approved: Buffer;
      try {
        approved = parseExactToken(rawApproved);
      } finally {
        rawApproved.fill(0);
      }
      try {
        if (approved.length !== token.length || !timingSafeEqual(approved, token)) {
          throw new Error("GitHub keyring credential drifted after approval.");
        }
      } finally {
        approved.fill(0);
      }
      await verifyNamespace(username);
      await writeVerifiedLogin(username, provenanceDigest, expectedDigest);
    } else {
      await writeCredential(username, token);
    }
  } finally {
    token.fill(0);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "GHCR provider failed."}\n`);
    process.exitCode = 1;
  }
}
