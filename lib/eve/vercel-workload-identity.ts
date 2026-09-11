import { getVercelOidcToken } from "@vercel/oidc";

import type { HostedWorkloadIdentity } from "./same-origin-http";

const MAX_TOKEN_BYTES = 8_192;

function exactToken(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_TOKEN_BYTES ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("Vercel workload identity token is unavailable.");
  }
  return value;
}

/**
 * Request-context workload identity adapter for Vercel deployments.
 *
 * Constructing the adapter reads no environment and obtains no credential.
 * Each transport call obtains the current invocation's Vercel OIDC token. The
 * same-project Eve service verifies that project-bound token directly. The user
 * principal is carried separately as Eve's closed forwarded-principal metadata.
 */
export function createVercelWorkloadIdentity(
  dependencies: {
    getToken?: () => Promise<string>;
  } = {},
): HostedWorkloadIdentity {
  const getToken = dependencies.getToken ?? getVercelOidcToken;

  return {
    async token() {
      return exactToken(await getToken());
    },
  };
}
