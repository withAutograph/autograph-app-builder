import { parseHostedDatabaseUrl } from "./postgres-connection-policy";

/** Derives the direct Neon endpoint required for session-scoped protected resource locks. */
export function parseProtectedResourceLockDatabaseUrl(value: unknown): string {
  const pooled = parseHostedDatabaseUrl(value);
  const url = new URL(pooled);
  if (!url.hostname.endsWith(".neon.tech")) {
    return pooled;
  }

  const [endpoint, ...domain] = url.hostname.split(".");
  if (endpoint === undefined || !endpoint.endsWith("-pooler") || domain.length === 0) {
    throw new Error("Protected resource locks require a pooled Neon endpoint.");
  }
  url.hostname = [endpoint.slice(0, -"-pooler".length), ...domain].join(".");
  return url.toString();
}
