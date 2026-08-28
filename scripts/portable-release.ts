import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { gzipSync } from "node:zlib";

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
export function hasCanonicalFetchRemote(
  remoteOutput: string,
  expectedRepository: string,
) {
  return remoteOutput.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/u);
    if (
      (fields.length !== 3 && fields.length !== 4) ||
      fields[2] !== "(fetch)" ||
      (fields.length === 4 && fields[3] !== "[blob:none]")
    )
      return false;
    const remoteUrl = fields[1];
    return (
      remoteUrl === expectedRepository ||
      remoteUrl === `${expectedRepository}.git`
    );
  });
}

const reservedReleaseHost = (hostname: string) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  const family = isIP(host);
  if (family === 4 && host.startsWith("127.")) return true;
  if (family === 6 && host === "::1") return true;
  if (
    ["example.com", "example.net", "example.org"].some(
      (name) => host === name || host.endsWith(`.${name}`),
    )
  )
    return true;
  return [".invalid", ".test", ".example", ".localhost", ".template"].some(
    (suffix) => host.endsWith(suffix),
  );
};

export function releaseEndpoint(value: string | undefined) {
  if (!value) throw new Error("Usage: --endpoint https://agent.example.com");
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.hostname.endsWith(".") ||
    reservedReleaseHost(endpoint.hostname)
  )
    throw new Error(
      "Endpoint must be a credential-free, deployed, literal HTTPS origin.",
    );
  return endpoint.origin;
}

export function registeredAutographToolNames(handlerSource: string) {
  const names = [
    ...handlerSource.matchAll(/server\.registerTool\(\s*"([^"]+)"/gu),
  ].map((match) => match[1]);
  if (
    names.length !== TOOL_NAMES.length ||
    new Set(names).size !== names.length ||
    names.some((name, index) => name !== TOOL_NAMES[index])
  )
    throw new Error(
      `The MCP handler must register exactly ${TOOL_NAMES.join(", ")} in order.`,
    );
  return names as unknown as typeof TOOL_NAMES;
}

const pad = (value: string, length: number) =>
  Buffer.from(value).subarray(0, length);
const write = (target: Buffer, offset: number, value: string, length: number) =>
  pad(value, length).copy(target, offset);
const octal = (value: number, length: number) =>
  `${value.toString(8).padStart(length - 1, "0")}\0`;

/** Creates a deterministic USTAR archive (sorted files, fixed modes and epoch mtimes). */
export function deterministicTar(files: ReadonlyMap<string, Uint8Array>) {
  const chunks: Buffer[] = [];
  for (const [name, content] of [...files].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (Buffer.byteLength(name) > 100)
      throw new Error(`Archive path too long: ${name}`);
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
    if (remainder) chunks.push(Buffer.alloc(512 - remainder));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

export const deterministicGzip = (value: Uint8Array) => {
  const archive = gzipSync(value, { level: 9 });
  archive.fill(0, 4, 8);
  archive[9] = 0xff;
  return archive;
};
