import { exchangeVercelOidcToken, getVercelOidcToken } from "@vercel/oidc";

import type { HostedWorkloadIdentity } from "./hosted-http";

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
 * Each transport call obtains the current invocation's Vercel OIDC token and
 * exchanges it for the exact configured gateway audience. The user principal
 * is deliberately not used as workload authority or included in the exchange.
 */
export function createVercelWorkloadIdentity(
  dependencies: {
    getToken?: () => Promise<string>;
    exchangeToken?: (input: {
      token: string;
      audience: string;
    }) => Promise<string>;
  } = {},
): HostedWorkloadIdentity {
  const getToken = dependencies.getToken ?? getVercelOidcToken;
  const exchangeToken =
    dependencies.exchangeToken ?? ((input) => exchangeVercelOidcToken(input));

  return {
    async token({ audience }) {
      const sourceToken = exactToken(await getToken());
      return exactToken(await exchangeToken({ token: sourceToken, audience }));
    },
  };
}
