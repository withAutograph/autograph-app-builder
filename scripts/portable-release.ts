import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { isReservedPublicReleaseHostname } from "../lib/plugin/public-release-endpoint.ts";

export const TOOL_NAMES = [
  "autograph_start",
  "autograph_get",
  "autograph_send",
  "autograph_respond",
  "autograph_cancel",
] as const;

export const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");

/** Matches one exact canonical fetch remote, allowing Git's optional .git suffix. */
export function hasCanonicalFetchRemote(remoteOutput: string, expectedRepository: string) {
  return remoteOutput.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/u);
    const hasValidFieldCount = fields.length >= 3 && fields.length <= 4;
    const hasFetchMarker = fields[2] === "(fetch)";
    const hasSupportedFilter = fields.length !== 4 || fields[3] === "[blob:none]";
    if (!hasValidFieldCount || !hasFetchMarker || !hasSupportedFilter) {
      return false;
    }
    const [, remoteUrl] = fields;
    return remoteUrl === expectedRepository || remoteUrl === `${expectedRepository}.git`;
  });
}

export function releaseEndpoint(value: string | undefined) {
  if (value === undefined || value === "") {
    throw new Error("Usage: --endpoint https://agent.example.com");
  }
  const endpoint = new URL(value);
  const hasCredentials = endpoint.username !== "" || endpoint.password !== "";
  const hasSearchOrHash = endpoint.search !== "" || endpoint.hash !== "";
  const hasExtraUrlParts = endpoint.pathname !== "/" || hasSearchOrHash;
  const hasInvalidHostname =
    endpoint.hostname.endsWith(".") || isReservedPublicReleaseHostname(endpoint.hostname);
  const isInvalidOrigin = endpoint.protocol !== "https:" || value !== endpoint.origin;
  if (hasCredentials || hasExtraUrlParts || hasInvalidHostname || isInvalidOrigin) {
    throw new Error("Endpoint must be a credential-free, deployed, literal HTTPS origin.");
  }
  return endpoint.origin;
}

export function registeredAutographToolNames(handlerSource: string) {
  const names = [...handlerSource.matchAll(/server\.registerTool\(\s*"(?<name>[^"]+)"/gu)].map(
    (match) => match.groups?.name ?? "",
  );
  const hasExpectedCount = names.length === TOOL_NAMES.length;
  const hasUniqueNames = new Set(names).size === names.length;
  const hasExpectedOrder = names.every((name, index) => name === TOOL_NAMES[index]);
  if (!hasExpectedCount || !hasUniqueNames || !hasExpectedOrder) {
    throw new Error(`The MCP handler must register exactly ${TOOL_NAMES.join(", ")} in order.`);
  }
  return [...TOOL_NAMES];
}

const pad = (value: string, length: number) => Buffer.from(value).subarray(0, length);
const write = (target: Buffer, offset: number, value: string, length: number) =>
  pad(value, length).copy(target, offset);
const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;

/** Creates a deterministic USTAR archive (sorted files, fixed modes and epoch mtimes). */
export function deterministicTar(files: ReadonlyMap<string, Uint8Array>) {
  const chunks: Buffer[] = [];
  for (const [name, content] of [...files].toSorted(([a], [b]) => a.localeCompare(b))) {
    if (Buffer.byteLength(name) > 100) {
      throw new Error(`Archive path too long: ${name}`);
    }
    const header = Buffer.alloc(512);
    write(header, 0, name, 100);
    write(header, 100, octal(0o644, 8), 8);
    write(header, 108, octal(0, 8), 8);
    write(header, 116, octal(0, 8), 8);
    write(header, 124, octal(content.byteLength, 12), 12);
    write(header, 136, octal(0, 12), 12);
    header.fill(0x20, 148, 156);
    write(header, 156, "0", 1);
    write(header, 257, "ustar", 6);
    write(header, 263, "00", 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(header, 148, octal(checksum, 8), 8);
    chunks.push(header, Buffer.from(content));
    const remainder = content.byteLength % 512;
    if (remainder) {
      chunks.push(Buffer.alloc(512 - remainder));
    }
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

export const deterministicGzip = (value: Uint8Array) => {
  const archive = gzipSync(value, { level: 9 });
  archive.fill(0, 4, 8);
  archive[9] = 0xff;
  return archive;
};
