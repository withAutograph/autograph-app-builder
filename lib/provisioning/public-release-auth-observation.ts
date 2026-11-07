import { createPublicKey } from "node:crypto";
import { z } from "zod";
import type { PublicReleaseInvocation } from "./public-release-handler";
import { publicReleaseRuntimeBindingDigest } from "./public-release-contract";
import type { PublicReleasePlan } from "./public-release-contract";

const publicKeySchema = z.object({
  crv: z.literal("Ed25519"),
  kty: z.literal("OKP"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
const publicJwkSchema = publicKeySchema
  .extend({
    alg: z.literal("EdDSA").optional(),
    key_ops: z.array(z.string()).optional(),
    kid: z.string().optional(),
    use: z.literal("sig").optional(),
  })
  .strict();
const fail = () => new Error("public_release_auth_observation_unavailable");

/** Anonymous public delivery observation; login, assignment and persistence remain separate acceptance. */
export const createPublicReleaseAuthObservation =
  (input: {
    assertCurrent: (invocation: PublicReleaseInvocation, plan: PublicReleasePlan) => Promise<void>;
    readPrivateValues: (
      invocation: PublicReleaseInvocation,
      plan: PublicReleasePlan,
    ) => Promise<Record<string, string>>;
    fetch?: typeof fetch;
  }) =>
  async (invocation: PublicReleaseInvocation, plan: PublicReleasePlan): Promise<boolean> => {
    const check = async () => {
      invocation.signal.throwIfAborted();
      await input.assertCurrent(invocation, plan);
      invocation.signal.throwIfAborted();
    };
    await check();
    const values = await input.readPrivateValues(invocation, plan);
    await check();
    if (
      values.PLATFORM_PUBLIC_ORIGIN !== plan.publicOrigin ||
      values.BETTER_AUTH_URL !== plan.publicOrigin ||
      values.PLATFORM_AUTH_DEPLOYMENT_PROFILE !== "isolated-development" ||
      values.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY === undefined
    ) {
      throw fail();
    }
    const expected = publicKeySchema.parse(
      createPublicKey(values.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY).export({ format: "jwk" }),
    );
    // This small anonymous metadata protocol is bounded independently of app/source workload size.
    const read = async (path: string) => {
      await check();
      const response = await (input.fetch ?? fetch)(new URL(path, plan.publicOrigin), {
        credentials: "omit",
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "manual",
        signal: invocation.signal,
      });
      await check();
      if (
        response.status !== 200 ||
        response.headers.get("content-type")?.toLowerCase().includes("application/json") !== true ||
        response.body === null
      ) {
        await response.body?.cancel();
        return { status: "unavailable" as const };
      }
      const reader = response.body.getReader();
      const buffers: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          invocation.signal.throwIfAborted();
          // oxlint-disable-next-line eslint/no-await-in-loop -- Metadata body is consumed with backpressure and a bounded protocol envelope.
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          bytes += chunk.value.byteLength;
          if (bytes > 65_536) {
            throw fail();
          }
          buffers.push(chunk.value);
        }
        await check();
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Remote JSON is parsed by the exact protocol schema at each call site.
        const data: unknown = JSON.parse(Buffer.concat(buffers).toString("utf-8"));
        return { data, status: "observed" as const };
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    };
    const health = await read("/_platform/health");
    if (
      health.status !== "observed" ||
      !z.object({ status: z.literal("ok") }).safeParse(health.data).success
    ) {
      return false;
    }
    if (plan.purpose !== undefined) {
      const proof = z
        .object({ runtimeBindingDigest: z.string().regex(/^[a-f0-9]{64}$/u) })
        .safeParse(health.data);
      if (
        !proof.success ||
        proof.data.runtimeBindingDigest !== publicReleaseRuntimeBindingDigest(plan)
      ) {
        return false;
      }
    }
    const keys = await read("/_platform/jwks.json");
    if (keys.status !== "observed") {
      return false;
    }
    const parsed = z.object({ keys: z.array(publicJwkSchema) }).safeParse(keys.data);
    if (!parsed.success || !parsed.data.keys.some((key) => key.x === expected.x)) {
      return false;
    }
    const auth = await read("/api/auth/ok");
    await check();
    return (
      auth.status === "observed" && z.object({ ok: z.literal(true) }).safeParse(auth.data).success
    );
  };
