import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const identityDomain = "autograph-app-builder-ghcr-keyring-v2";
const registry = "https://ghcr.io";
const githubHost = "github.com";
const githubOrganization = "withAutograph";
const maximumCredentialBytes = 4096;
const maximumGhOutputBytes = 256 * 1024;
const ghTimeoutMs = 10_000;

export function readBoundedInput(fd: number, maximumBytes: number): Buffer {
  const input = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  try {
    for (;;) {
      const count = readSync(fd, input, offset, input.length - offset, null);
      if (count === 0) return Buffer.from(input.subarray(0, offset));
      offset += count;
      if (offset > maximumBytes)
        throw new Error("Credential input exceeded the closed size limit.");
    }
  } finally {
    input.fill(0);
  }
}

export function ghcrIdentityDigest(
  username: string,
  provenanceDigest: string,
  secret: Uint8Array,
): string {
  if (!/^[a-f0-9]{64}$/u.test(provenanceDigest))
    throw new Error("GHCR provenance digest is invalid.");
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

export function assertBoundGhcrPayload(
  payload: string,
  expectedUsername: string,
  expectedProvenanceDigest: string,
  expectedIdentityDigest: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("GHCR provider returned malformed output.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("GHCR provider returned malformed output.");
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "Secret,ServerURL,Username" ||
    record.ServerURL !== registry ||
    record.Username !== expectedUsername ||
    typeof record.Secret !== "string" ||
    !/^[A-Za-z0-9_]{20,4096}$/u.test(record.Secret)
  )
    throw new Error("GHCR provider identity did not match approval.");
  const secret = Buffer.from(record.Secret, "ascii");
  const observed = Buffer.from(
    ghcrIdentityDigest(expectedUsername, expectedProvenanceDigest, secret),
    "hex",
  );
  const expected = Buffer.from(expectedIdentityDigest, "hex");
  try {
    if (
      observed.length !== 32 ||
      expected.length !== 32 ||
      !timingSafeEqual(observed, expected)
    )
      throw new Error("GHCR provider identity drifted after approval.");
  } finally {
    secret.fill(0);
    observed.fill(0);
    expected.fill(0);
  }
}

export function assertVerifiedGhcrLoginPayload(
  payload: string,
  expectedUsername: string,
  expectedProvenanceDigest: string,
  expectedIdentityDigest: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("GitHub keyring verification returned malformed output.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("GitHub keyring verification returned malformed output.");
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "Username,identityDigest,provenanceDigest" ||
    record.Username !== expectedUsername ||
    record.provenanceDigest !== expectedProvenanceDigest ||
    record.identityDigest !== expectedIdentityDigest
  )
    throw new Error("GitHub keyring verification did not match approval.");
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

export function parseGhAuthStatus(
  payload: string,
  expectedUsername: string,
): GhStatusRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("GitHub authentication status was malformed.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).join(",") !== "hosts"
  )
    throw new Error("GitHub authentication status was malformed.");
  const hosts = (parsed as { hosts?: unknown }).hosts;
  if (
    typeof hosts !== "object" ||
    hosts === null ||
    Array.isArray(hosts) ||
    Object.keys(hosts).join(",") !== githubHost
  )
    throw new Error("GitHub authentication status was malformed.");
  const records = (hosts as Record<string, unknown>)[githubHost];
  if (!Array.isArray(records) || records.length !== 1)
    throw new Error("GitHub authentication status was ambiguous.");
  const record = records[0];
  if (typeof record !== "object" || record === null || Array.isArray(record))
    throw new Error("GitHub authentication status was malformed.");
  const value = record as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
      "active,gitProtocol,host,login,scopes,state,tokenSource" ||
    value.active !== true ||
    value.gitProtocol !== "https" ||
    value.host !== githubHost ||
    value.login !== expectedUsername ||
    value.state !== "success" ||
    value.tokenSource !== "keyring" ||
    typeof value.scopes !== "string"
  )
    throw new Error("GitHub keyring identity did not match approval.");
  const scopes = new Set(
    value.scopes
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  if (!scopes.has("write:packages"))
    throw new Error("GitHub keyring identity lacks package-write authority.");
  return value as GhStatusRecord;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error("GHCR binding environment is incomplete.");
  return value;
}

function exactGithubCli(): string {
  const path = requiredEnvironment("APP_BUILDER_IMAGE_GH_BIN");
  const expectedSha256 = requiredEnvironment("APP_BUILDER_GH_SHA256");
  if (!isAbsolute(path) || realpathSync(path) !== path)
    throw new Error("GitHub CLI executable is invalid.");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("GitHub CLI executable is invalid.");
  if (
    createHash("sha256").update(readFileSync(path)).digest("hex") !==
    expectedSha256
  )
    throw new Error("GitHub CLI executable drifted after approval.");
  return path;
}

export function githubConfigDigest(configRoot: string): string {
  if (!isAbsolute(configRoot) || realpathSync(configRoot) !== configRoot)
    throw new Error("GitHub configuration root is invalid.");
  const uid = process.getuid?.();
  const rootStat = lstatSync(configRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    uid === undefined ||
    rootStat.uid !== uid ||
    (rootStat.mode & 0o022) !== 0
  )
    throw new Error("GitHub configuration root is unsafe.");
  const records: string[] = [];
  for (const name of ["config.yml", "hosts.yml"] as const) {
    const path = join(configRoot, name);
    if (realpathSync(path) !== path)
      throw new Error("GitHub configuration file is unsafe.");
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("GitHub configuration file is unsafe.");
    const bytes = readFileSync(path);
    try {
      if (/^\s*(?:oauth_token|token)\s*:/imu.test(bytes.toString("utf8")))
        throw new Error("Plaintext GitHub credentials are not eligible.");
      records.push(
        `${name}\0${createHash("sha256").update(bytes).digest("hex")}`,
      );
    } finally {
      bytes.fill(0);
    }
  }
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

export function assertGithubStateRoot(stateRoot: string): void {
  if (
    !isAbsolute(stateRoot) ||
    !existsSync(stateRoot) ||
    realpathSync(stateRoot) !== stateRoot
  )
    throw new Error("GitHub state root is invalid.");
  const uid = process.getuid?.();
  const rootStat = lstatSync(stateRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    uid === undefined ||
    rootStat.uid !== uid ||
    (rootStat.mode & 0o777) !== 0o700
  )
    throw new Error("GitHub state root is unsafe.");

  const rootEntries = readdirSync(stateRoot, { withFileTypes: true });
  if (rootEntries.length === 0) return;
  if (
    rootEntries.length !== 1 ||
    rootEntries[0]?.name !== "gh" ||
    !rootEntries[0].isDirectory() ||
    rootEntries[0].isSymbolicLink()
  )
    throw new Error("GitHub state root has unexpected contents.");
  const ghRoot = join(stateRoot, "gh");
  if (realpathSync(ghRoot) !== ghRoot)
    throw new Error("GitHub state root contains a symbolic link.");
  const ghStat = lstatSync(ghRoot);
  if (ghStat.uid !== uid || (ghStat.mode & 0o022) !== 0)
    throw new Error("GitHub state root is unsafe.");

  const ghEntries = readdirSync(ghRoot, { withFileTypes: true });
  if (ghEntries.length === 0) return;
  if (
    ghEntries.length !== 1 ||
    ghEntries[0]?.name !== "device-id" ||
    !ghEntries[0].isFile() ||
    ghEntries[0].isSymbolicLink()
  )
    throw new Error("GitHub state root has unexpected contents.");
  const deviceId = join(ghRoot, "device-id");
  if (realpathSync(deviceId) !== deviceId)
    throw new Error("GitHub state root contains a symbolic link.");
  const deviceStat = lstatSync(deviceId);
  if (
    deviceStat.uid !== uid ||
    deviceStat.nlink !== 1 ||
    (deviceStat.mode & 0o022) !== 0 ||
    deviceStat.size === 0 ||
    deviceStat.size > 256
  )
    throw new Error("GitHub state root is unsafe.");
}

export function githubStateDigest(stateRoot: string): string {
  assertGithubStateRoot(stateRoot);
  const deviceId = join(stateRoot, "gh", "device-id");
  if (!existsSync(deviceId))
    return createHash("sha256").update("empty").digest("hex");
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

function githubEnvironment(): NodeJS.ProcessEnv {
  const configRoot = requiredEnvironment("APP_BUILDER_GH_CONFIG_DIR");
  const expectedDigest = requiredEnvironment("APP_BUILDER_GH_CONFIG_DIGEST");
  const stateRoot = requiredEnvironment("APP_BUILDER_GH_STATE_DIR");
  if (githubConfigDigest(configRoot) !== expectedDigest)
    throw new Error("GitHub configuration drifted after approval.");
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

function assertExpectedGithubState(): void {
  const stateRoot = requiredEnvironment("APP_BUILDER_GH_STATE_DIR");
  const expectedDigest = process.env.APP_BUILDER_GH_STATE_DIGEST;
  assertGithubStateRoot(stateRoot);
  if (expectedDigest === undefined) return;
  if (
    !/^[a-f0-9]{64}$/u.test(expectedDigest) ||
    githubStateDigest(stateRoot) !== expectedDigest
  )
    throw new Error("GitHub state drifted after approval.");
}

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
    if (child.pid === undefined) return;
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
    } else stdout.push(copy);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const copy = Buffer.from(chunk);
    outputBytes += copy.length;
    if (outputBytes > maximumGhOutputBytes) {
      overflow = true;
      copy.fill(0);
      terminate();
    } else stderr.push(copy);
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, ghTimeoutMs);
  try {
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      child.once("error", rejectStatus);
      child.once("close", (code) => resolveStatus(code ?? -1));
    });
    if (timedOut || overflow || status !== 0)
      throw new Error("GitHub credential read-back failed.");
    assertExpectedGithubState();
    return Buffer.concat(stdout);
  } finally {
    clearTimeout(timeout);
    for (const chunk of stdout) chunk.fill(0);
    for (const chunk of stderr) chunk.fill(0);
  }
}

function parseExactToken(raw: Buffer): Buffer {
  let end = raw.length;
  if (end > 0 && raw[end - 1] === 0x0a) end -= 1;
  if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
  const token = Buffer.from(raw.subarray(0, end));
  const validByte = (byte: number) =>
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    byte === 0x5f ||
    (byte >= 0x61 && byte <= 0x7a);
  if (
    token.length < 20 ||
    token.length > maximumCredentialBytes ||
    token.some((byte) => !validByte(byte))
  ) {
    token.fill(0);
    throw new Error("GitHub credential read-back was malformed.");
  }
  return token;
}

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
    parseGhAuthStatus(status.toString("utf8"), username);
  } finally {
    status.fill(0);
  }
  const raw = await runBoundedGh([
    "auth",
    "token",
    "--hostname",
    githubHost,
    "--user",
    username,
  ]);
  try {
    return parseExactToken(raw);
  } finally {
    raw.fill(0);
  }
}

async function verifyNamespace(username: string): Promise<void> {
  const user = await runBoundedGh(["api", "/user", "--jq", ".login"]);
  const membership = await runBoundedGh([
    "api",
    `/user/memberships/orgs/${githubOrganization}`,
    "--jq",
    "[.state,.role,.organization.login] | @tsv",
  ]);
  try {
    if (
      user.toString("utf8").trim() !== username ||
      membership.toString("utf8").trim() !==
        `active\tadmin\t${githubOrganization}`
    )
      throw new Error("GitHub namespace authority did not match approval.");
  } finally {
    user.fill(0);
    membership.fill(0);
  }
}

async function writeCredential(username: string, token: Buffer): Promise<void> {
  assertExpectedGithubState();
  const prefix = Buffer.from(
    `{"ServerURL":"${registry}","Username":"${username}","Secret":"`,
    "utf8",
  );
  const suffix = Buffer.from('"}\n', "utf8");
  const payload = Buffer.concat([prefix, token, suffix]);
  try {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      process.stdout.write(payload, (error) =>
        error === undefined || error === null
          ? resolveWrite()
          : rejectWrite(error),
      );
    });
  } finally {
    prefix.fill(0);
    suffix.fill(0);
    payload.fill(0);
  }
}

async function writeVerifiedLogin(
  username: string,
  provenanceDigest: string,
  identityDigest: string,
): Promise<void> {
  assertExpectedGithubState();
  const payload = Buffer.from(
    JSON.stringify({
      Username: username,
      identityDigest,
      provenanceDigest,
    }) + "\n",
    "utf8",
  );
  try {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      process.stdout.write(payload, (error) =>
        error === undefined || error === null
          ? resolveWrite()
          : rejectWrite(error),
      );
    });
  } finally {
    payload.fill(0);
  }
}

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== "get" && mode !== "verify-login"))
    throw new Error("Only the closed GHCR credential protocols are supported.");
  if (mode === "get") {
    requiredEnvironment("APP_BUILDER_GH_STATE_DIGEST");
    const request = readBoundedInput(0, 256).toString("utf8").trim();
    if (request !== "ghcr.io" && request !== registry)
      throw new Error("GHCR provider request named an unsupported registry.");
  } else if (process.env.APP_BUILDER_GH_STATE_DIGEST !== undefined) {
    throw new Error("Initial GHCR login cannot inherit approved state.");
  }
  const username = requiredEnvironment("APP_BUILDER_GHCR_USERNAME");
  const provenanceDigest = requiredEnvironment(
    "APP_BUILDER_GHCR_PROVENANCE_DIGEST",
  );
  const expectedDigest = requiredEnvironment(
    "APP_BUILDER_GHCR_IDENTITY_DIGEST",
  );
  const token = await readApprovedKeyringToken(username);
  try {
    const observed = Buffer.from(
      ghcrIdentityDigest(username, provenanceDigest, token),
      "hex",
    );
    const expected = Buffer.from(expectedDigest, "hex");
    try {
      if (
        observed.length !== 32 ||
        expected.length !== 32 ||
        !timingSafeEqual(observed, expected)
      )
        throw new Error("GitHub keyring credential drifted after approval.");
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
        if (
          approved.length !== token.length ||
          !timingSafeEqual(approved, token)
        )
          throw new Error("GitHub keyring credential drifted after approval.");
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

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "GHCR provider failed."}\n`,
    );
    process.exitCode = 1;
  }
}
