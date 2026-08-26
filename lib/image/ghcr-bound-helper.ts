import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const identityDomain = "autograph-app-builder-ghcr-identity-v1";
const registry = "https://ghcr.io";
const maximumHelperOutputBytes = 4 * 1024 * 1024;

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
  secret: Uint8Array,
): string {
  return createHash("sha256")
    .update(identityDomain)
    .update("\0")
    .update(username)
    .update("\0")
    .update(secret)
    .digest("hex");
}

export function assertBoundGhcrPayload(
  payload: string,
  expectedUsername: string,
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
    record.Secret.length === 0
  )
    throw new Error("GHCR provider identity did not match approval.");
  const observed = Buffer.from(
    ghcrIdentityDigest(expectedUsername, Buffer.from(record.Secret)),
    "hex",
  );
  const expected = Buffer.from(expectedIdentityDigest, "hex");
  if (
    observed.length !== 32 ||
    expected.length !== 32 ||
    !timingSafeEqual(observed, expected)
  )
    throw new Error("GHCR provider identity drifted after approval.");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error("GHCR binding environment is incomplete.");
  return value;
}

function run(): void {
  if (process.argv.length !== 3 || process.argv[2] !== "get")
    throw new Error("Only the Docker credential get protocol is supported.");
  const request = readBoundedInput(0, 256).toString("utf8").trim();
  if (request !== "ghcr.io" && request !== registry)
    throw new Error("GHCR provider request named an unsupported registry.");

  const helper = requiredEnvironment("APP_BUILDER_IMAGE_GHCR_HELPER_BIN");
  const expectedHelperSha256 = requiredEnvironment(
    "APP_BUILDER_GHCR_HELPER_SHA256",
  );
  if (!isAbsolute(helper) || !lstatSync(helper).isFile())
    throw new Error("GHCR provider executable is invalid.");
  if (
    createHash("sha256").update(readFileSync(helper)).digest("hex") !==
    expectedHelperSha256
  )
    throw new Error("GHCR provider executable drifted after approval.");

  const result = spawnSync(helper, ["get"], {
    encoding: "utf8",
    input: `${registry}\n`,
    maxBuffer: maximumHelperOutputBytes,
    env: {
      HOME: requiredEnvironment("HOME"),
      LANG: "C",
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0)
    throw new Error("GHCR provider lookup failed.");
  assertBoundGhcrPayload(
    result.stdout,
    requiredEnvironment("APP_BUILDER_GHCR_USERNAME"),
    requiredEnvironment("APP_BUILDER_GHCR_IDENTITY_DIGEST"),
  );
  process.stdout.write(result.stdout);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    run();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "GHCR provider failed."}\n`,
    );
    process.exitCode = 1;
  }
}
