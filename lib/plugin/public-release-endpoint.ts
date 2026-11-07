import { isIP } from "node:net";

const normalizedHostname = (hostname: string) => hostname.toLowerCase().replaceAll(/^\[|\]$/gu, "");

const isLoopbackOrUnspecifiedIpv4 = (host: string) => {
  const octets = host.split(".").map(Number);
  return octets[0] === 127 || octets.every((octet) => octet === 0);
};

const mappedIpv4 = (host: string): string | undefined => {
  const match = /^::ffff:(?<high>[0-9a-f]{1,4}):(?<low>[0-9a-f]{1,4})$/u.exec(host);
  if (match) {
    const high = Number.parseInt(match[1], 16);
    const low = Number.parseInt(match[2], 16);
    return `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`;
  }
  return undefined;
};

export const isReservedPublicReleaseHostname = (hostname: string) => {
  const host = normalizedHostname(hostname);
  const family = isIP(host);
  if (host === "localhost") {
    return true;
  }
  if (family === 4 && isLoopbackOrUnspecifiedIpv4(host)) {
    return true;
  }
  if (family === 6) {
    if (host === "::" || host === "::1") {
      return true;
    }
    const mapped = mappedIpv4(host);
    if (mapped !== undefined && mapped !== "" && isLoopbackOrUnspecifiedIpv4(mapped)) {
      return true;
    }
  }
  if (
    ["example.com", "example.net", "example.org"].some(
      (name) => host === name || host.endsWith(`.${name}`),
    )
  ) {
    return true;
  }
  return [".invalid", ".test", ".example", ".localhost", ".template"].some((suffix) =>
    host.endsWith(suffix),
  );
};
