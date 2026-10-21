/**
 * Keep the already verified request workload on this Sandbox management client.
 * The SDK may refresh its own token before fetch; this adapter neither refreshes
 * that carrier nor changes the SDK's project/team query. Child command/file
 * handles retain this client. Foreign and interactive destinations are untouched.
 */
export const createHostedOperatorSandboxFetch =
  (token: () => string, fetchImpl: typeof fetch = fetch): typeof fetch =>
  async (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : input);
    } catch {
      // Preserve the underlying fetch's handling of unsupported/relative inputs.
      return await fetchImpl(input, init);
    }
    const trustedOrigin =
      url.origin === "https://vercel.com" && url.username === "" && url.password === "";
    const managementPath =
      url.pathname === "/api/v2/sandboxes" || url.pathname.startsWith("/api/v2/sandboxes/");
    if (!trustedOrigin || !managementPath) {
      return await fetchImpl(input, init);
    }
    // Native fetch replaces Request headers when init.headers is supplied.
    let sourceHeaders = init?.headers;
    if (sourceHeaders === undefined && input instanceof Request) {
      sourceHeaders = input.headers;
    }
    const headers = new Headers(sourceHeaders);
    headers.set("authorization", `Bearer ${token()}`);
    return await fetchImpl(input, {
      ...init,
      headers,
      // A management response may be surfaced as APIError, never followed with this bearer.
      redirect: "manual",
    });
  };
