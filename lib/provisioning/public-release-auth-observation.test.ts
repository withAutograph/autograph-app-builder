/* oxlint-disable eslint/require-await -- Test ports preserve production async authority checks. */
import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createPublicReleaseAuthObservation } from "./public-release-auth-observation";
import { plan } from "./public-release-test-fixture";

const pair = generateKeyPairSync("ed25519");
const fixture = () => {
  let revoked = false;
  const invocation = {
    authority: plan.authority,
    sessionId: plan.selection.sessionId,
    callId: "approval",
    signal: new AbortController().signal,
  };
  const fetcher = vi.fn<typeof fetch>(async (resource, init) => {
    const input = z.union([z.string(), z.instanceof(URL), z.instanceof(Request)]).parse(resource);
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(plan.publicOrigin);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (url.pathname === "/_platform/health") {
      return Response.json({ status: "ok" });
    }
    if (url.pathname === "/_platform/jwks.json") {
      return Response.json({ keys: [pair.publicKey.export({ format: "jwk" })] });
    }
    if (url.pathname === "/api/auth/ok") {
      return Response.json({ ok: true });
    }
    throw new Error("unexpected path");
  });
  const observe = createPublicReleaseAuthObservation({
    assertCurrent: async () => {
      if (revoked) {
        throw new Error("owner revoked");
      }
    },
    readPrivateValues: async () => ({
      PLATFORM_PUBLIC_ORIGIN: plan.publicOrigin,
      BETTER_AUTH_URL: plan.publicOrigin,
      PLATFORM_AUTH_DEPLOYMENT_PROFILE: "isolated-development",
      PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY: pair.privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
    }),
    fetch: fetcher,
  });
  return {
    observe,
    invocation,
    fetcher,
    revoke: () => {
      revoked = true;
    },
  };
};
it("observes anonymous Gateway, exact published public key and BetterAuth without claiming user acceptance", async () => {
  const f = fixture();
  expect(await f.observe(f.invocation, plan)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
});
it("does not follow a Vercel login redirect", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    new Response(null, { status: 307, headers: { location: "https://vercel.com/login" } }),
  );
  expect(await f.observe(f.invocation, plan)).toBe(false);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it("does not adopt a foreign Gateway key or private-key response", async () => {
  const f = fixture();
  f.fetcher
    .mockResolvedValueOnce(Response.json({ status: "ok" }))
    .mockResolvedValueOnce(
      Response.json({ keys: [generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" })] }),
    );
  expect(await f.observe(f.invocation, plan)).toBe(false);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  const g = fixture();
  g.fetcher
    .mockResolvedValueOnce(Response.json({ status: "ok" }))
    .mockResolvedValueOnce(Response.json({ keys: [pair.privateKey.export({ format: "jwk" })] }));
  expect(await g.observe(g.invocation, plan)).toBe(false);
});
it("rechecks owner authority after network awaits", async () => {
  const f = fixture();
  f.fetcher.mockImplementationOnce(async () => {
    f.revoke();
    return Response.json({ status: "ok" });
  });
  await expect(f.observe(f.invocation, plan)).rejects.toThrow("owner revoked");
  expect(f.fetcher).toHaveBeenCalledOnce();
});
