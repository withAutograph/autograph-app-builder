import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  operatorHeaderProbeRequired,
  reportHostedOperatorHeaderProbes,
} from "./hosted-operator-header-probes";
import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
import type { HostedOperatorDependencyLoader } from "./hosted-operator-native";
import type { HostedOperatorConsentDiagnosticSink } from "./hosted-operator-consent-diagnostic";

const secret = "private-token";
const sessionId = "private-session";
const url = new URL("https://private-deployment.example/v1/runtime");
const base = { phase: "inline" as const, sessionId, token: secret, url };

describe("same-token transport-only header probes", () => {
  it("requires exactly HTTP403 with the allowlisted environment mismatch", () => {
    expect(
      operatorHeaderProbeRequired(
        new Response(null, {
          headers: { "x-vercel-error": "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH" },
          status: 403,
        }),
      ),
    ).toBe(true);
    for (const status of [200, 401, 404, 503]) {
      expect(
        operatorHeaderProbeRequired(
          new Response(null, {
            headers: { "x-vercel-error": "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH" },
            status,
          }),
        ),
      ).toBe(false);
    }
    expect(
      operatorHeaderProbeRequired(
        new Response(null, { headers: { "x-vercel-error": secret }, status: 403 }),
      ),
    ).toBe(false);
  });
  it("issues one GET per variant and reaches native rejection before initialization", async () => {
    const loader = vi.fn<HostedOperatorDependencyLoader>(async () => {
      await Promise.resolve();
      throw new Error("private-provider-operation");
    });
    const handler = createHostedOperatorNativeHandler({ createDependencies: loader });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const fetchResponse = vi.fn<typeof fetch>(async (target, init) => {
      expect(target).toBe(url);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return await handler(new Request(url, init));
    });
    await reportHostedOperatorHeaderProbes({ ...base, fetch: fetchResponse, sink });
    expect(fetchResponse).toHaveBeenCalledTimes(2);
    expect(loader).not.toHaveBeenCalled();
    expect(new Headers(fetchResponse.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${secret}`,
    );
    expect(new Headers(fetchResponse.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(false);
    for (const call of fetchResponse.mock.calls) {
      expect(new Headers(call[1]?.headers).get("x-vercel-trusted-oidc-idp-token")).toBe(secret);
    }
    expect(sink.mock.calls.map(([value]) => value.probeVariant)).toEqual([
      "both_headers",
      "trusted_oidc_only",
    ]);
    for (const [value] of sink.mock.calls) {
      expect(value).toMatchObject({
        httpStatus: 404,
        nativeNotFound: true,
        sessionIdHash: `sha256:${createHash("sha256").update(sessionId).digest("hex")}`,
      });
    }
    const output = JSON.stringify(sink.mock.calls);
    for (const privateValue of [secret, sessionId, url.href, "private-provider-operation"]) {
      expect(output).not.toContain(privateValue);
    }
  });
  it("projects only the allowlisted edge error without reading denied bodies", async () => {
    const response = Response.json(
      { secret },
      {
        headers: { "x-vercel-error": "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH" },
        status: 403,
      },
    );
    const read = vi.spyOn(response, "json");
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const fetchResponse = vi.fn<typeof fetch>(async () => await Promise.resolve(response));
    await reportHostedOperatorHeaderProbes({ ...base, fetch: fetchResponse, sink });
    expect(read).not.toHaveBeenCalled();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      httpStatus: 403,
      nativeNotFound: false,
      vercelError: "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
  it.each([secret, "x".repeat(129), '{"code":"not_found","secret":"private-token"}'])(
    "does not emit arbitrary or oversized bodies",
    async (body) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      const fetchResponse = vi.fn<typeof fetch>(
        async () =>
          await Promise.resolve(
            new Response(body, {
              headers: { "x-vercel-error": secret },
              status: 404,
            }),
          ),
      );
      await reportHostedOperatorHeaderProbes({ ...base, fetch: fetchResponse, sink });
      expect(sink.mock.calls[0]?.[0].nativeNotFound).toBe(false);
      expect(sink.mock.calls[0]?.[0]).not.toHaveProperty("vercelError");
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    },
  );
  it("cannot mask original denial with fetch errors or diagnostic sink errors", async () => {
    const fetchResponse = vi.fn<typeof fetch>(async () => {
      await Promise.resolve();
      throw new Error(secret);
    });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>(() => {
      throw new Error(secret);
    });
    await expect(
      reportHostedOperatorHeaderProbes({ ...base, fetch: fetchResponse, sink }),
    ).resolves.toBeUndefined();
    expect(fetchResponse).toHaveBeenCalledTimes(2);
  });
});
