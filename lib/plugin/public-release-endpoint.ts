import { isIP } from "node:net";

const normalizedHostname = (hostname: string) =>
  hostname.toLowerCase().replace(/^\[|\]$/g, "");

const isLoopbackOrUnspecifiedIpv4 = (host: string) => {
  const octets = host.split(".").map(Number);
  return octets[0] === 127 || octets.every((octet) => octet === 0);
};

const mappedIpv4 = (host: string) => {
  const match = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (!match) return undefined;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
};

export const isReservedPublicReleaseHostname = (hostname: string) => {
  const host = normalizedHostname(hostname);
  const family = isIP(host);
  if (host === "localhost") return true;
  if (family === 4 && isLoopbackOrUnspecifiedIpv4(host)) return true;
  if (family === 6) {
    if (host === "::" || host === "::1") return true;
    const mapped = mappedIpv4(host);
    if (mapped && isLoopbackOrUnspecifiedIpv4(mapped)) return true;
  }
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
