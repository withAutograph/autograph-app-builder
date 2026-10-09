import type { OperatorCallerWorkloadDependencies } from "./hosted-operator-caller-workload";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { reportHostedOperatorCallerWorkload } from "./hosted-operator-caller-workload";
import type { HostedOperatorConsentDiagnosticSink } from "./hosted-operator-consent-diagnostic";

type VerifyToken = NonNullable<OperatorCallerWorkloadDependencies["verifyToken"]>;

const secret = "private-bearer-token";
const sessionId = "private-saved-session";
const environment = {
  VERCEL_ENV: "preview",
  VERCEL_OIDC_TOKEN: secret,
  VERCEL_ORG_ID: "private-expected-team",
  VERCEL_PROJECT_ID: "private-expected-project",
  VERCEL_TARGET_ENV: "production",
};
const payload = {
  environment: "production",
  owner_id: environment.VERCEL_ORG_ID,
  project_id: environment.VERCEL_PROJECT_ID,
};
const base = { httpStatus: 403, phase: "inline" as const, sessionId, token: secret };

describe("closed caller workload diagnostics after upstream denial", () => {
  it("observes the exact sent token with public SDK APIs and strict project scope", async () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const verifyToken = vi.fn<VerifyToken>(async () => await Promise.resolve({ payload }));
    await reportHostedOperatorCallerWorkload({
      ...base,
      dependencies: {
        getContext: () => ({ headers: { "x-vercel-oidc-token": secret } }),
        verifyToken,
      },
      environment,
      sink,
    });
    expect(verifyToken).toHaveBeenCalledWith(secret, {
      environment: ["development", "preview", "production"],
      ownerId: environment.VERCEL_ORG_ID,
      projectId: environment.VERCEL_PROJECT_ID,
    });
    expect(sink.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        callerWorkload: {
          environmentMatches: true,
          projectMatches: true,
          runtimeEnvironment: "production",
          signatureVerified: true,
          source: "request_context",
          teamMatches: true,
          tokenEnvironment: "production",
          verification: "verified",
        },
        sessionIdHash: `sha256:${createHash("sha256").update(sessionId).digest("hex")}`,
        stage: "caller_workload",
      }),
    );
    const output = JSON.stringify(sink.mock.calls);
    for (const privateValue of [
      secret,
      sessionId,
      environment.VERCEL_PROJECT_ID,
      environment.VERCEL_ORG_ID,
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });
  it.each(["preview", "development"])(
    "observes verified %s without changing the token",
    async (tokenEnvironment) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      const verifyToken = vi.fn<VerifyToken>(
        async () =>
          await Promise.resolve({
            payload: { ...payload, environment: tokenEnvironment },
          }),
      );
      await reportHostedOperatorCallerWorkload({
        ...base,
        dependencies: { getContext: () => ({}), verifyToken },
        environment,
        sink,
      });
      expect(sink.mock.calls[0]?.[0].callerWorkload).toEqual(
        expect.objectContaining({
          environmentMatches: false,
          signatureVerified: true,
          source: "environment",
          tokenEnvironment,
        }),
      );
      expect(verifyToken.mock.calls[0]?.[0]).toBe(secret);
    },
  );
  it("does not claim verification or matches when the exact expected project is missing", async () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const verifyToken = vi.fn<VerifyToken>(async () => await Promise.resolve({ payload }));
    await reportHostedOperatorCallerWorkload({
      ...base,
      dependencies: { getContext: () => ({}), verifyToken },
      environment: { VERCEL_ENV: "production" },
      sink,
    });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(sink.mock.calls[0]?.[0].callerWorkload).toEqual({
      runtimeEnvironment: "production",
      source: "unknown",
      verification: "unavailable",
    });
  });
  it("keeps a bad token and verification errors private and cannot replace denial", async () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const verifyToken = vi.fn<VerifyToken>(async () => {
      await Promise.resolve();
      throw new Error(`private-claim-value ${secret}`);
    });
    await expect(
      reportHostedOperatorCallerWorkload({
        ...base,
        dependencies: { getContext: () => ({}), verifyToken },
        environment,
        sink,
      }),
    ).resolves.toBeUndefined();
    expect(sink.mock.calls[0]?.[0].callerWorkload).toEqual({
      runtimeEnvironment: "production",
      source: "environment",
      verification: "failed",
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("private-claim-value");
  });
  it("does not invent a team match or expose context failures", async () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const verifyToken = vi.fn<VerifyToken>(async () => await Promise.resolve({ payload }));
    await reportHostedOperatorCallerWorkload({
      ...base,
      dependencies: {
        getContext: () => {
          throw new Error(secret);
        },
        verifyToken,
      },
      environment: { VERCEL_ENV: "production", VERCEL_PROJECT_ID: environment.VERCEL_PROJECT_ID },
      sink,
    });
    expect(sink.mock.calls[0]?.[0].callerWorkload).toEqual(
      expect.objectContaining({
        projectMatches: true,
        source: "unknown",
        verification: "verified",
      }),
    );
    expect(sink.mock.calls[0]?.[0].callerWorkload).not.toHaveProperty("teamMatches");
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
  it("does not propagate a diagnostic sink failure", async () => {
    await expect(
      reportHostedOperatorCallerWorkload({
        ...base,
        dependencies: { getContext: () => ({}) },
        environment: {},
        sink: () => {
          throw new Error(secret);
        },
      }),
    ).resolves.toBeUndefined();
  });
});
