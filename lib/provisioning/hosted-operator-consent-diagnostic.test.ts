import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createHostedOperatorConsentDiagnostic,
  operatorOwnerStoreImportErrorCodeSchema,
} from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  HostedOperatorConsentMetadata,
} from "./hosted-operator-consent-diagnostic";

const secret = "private-owner repo https://vercel.com/consent?pkce=private bearer-secret";
const value: HostedOperatorConsentMetadata = {
  boundary: "builder",
  outcome: "started",
  phase: "check",
  stage: "operator_request",
};

describe("closed Neon consent diagnostics", () => {
  it("accepts only closed projection flags and failure reasons without SDK fields", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    const flags = {
      deviceCodeValid: true,
      expiresAtValid: true,
      urlPresent: true,
      urlValid: true,
    };
    for (const failure of [
      "response_invalid",
      "url_missing",
      "url_invalid",
      "device_code_invalid",
      "expiry_invalid",
    ] as const) {
      report({
        ...value,
        challengeProjection: { ...flags, failure },
        stage: "provider_start_projection",
      });
    }
    report({ ...value, challengeProjection: flags, stage: "provider_start_projection" });
    expect(sink).toHaveBeenCalledTimes(6);
    for (const field of [
      "deviceCodeValid",
      "expiresAtValid",
      "urlPresent",
      "urlValid",
      "failure",
      "url",
      "request",
      "verifier",
      "body",
      "cause",
      "message",
    ]) {
      report({
        ...value,
        challengeProjection: { ...flags, [field]: secret },
        stage: "provider_start_projection",
      });
    }
    expect(sink).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
  it.each(["database", "handoff", "session", "membership"] as const)(
    "accepts only a closed %s import label and fixed Node error codes",
    (module) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      const report = createHostedOperatorConsentDiagnostic(secret, sink);
      for (const errorCode of operatorOwnerStoreImportErrorCodeSchema.options) {
        report({ ...value, ownerStoreImport: { errorCode, module }, stage: "owner_store_import" });
      }
      report({ ...value, ownerStoreImport: { module }, stage: "owner_store_import" });
      expect(sink).toHaveBeenCalledTimes(
        operatorOwnerStoreImportErrorCodeSchema.options.length + 1,
      );
      for (const field of ["module", "errorCode", "cause", "message", "path"]) {
        report({
          ...value,
          ownerStoreImport: { module, [field]: secret },
          stage: "owner_store_import",
        });
      }
      expect(sink).toHaveBeenCalledTimes(
        operatorOwnerStoreImportErrorCodeSchema.options.length + 1,
      );
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    },
  );
  it.each(["owner_configuration_parse", "owner_store_import", "owner_store_construction"] as const)(
    "accepts only fixed configuration booleans for %s",
    (stage) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      const report = createHostedOperatorConsentDiagnostic(secret, sink);
      const ownerConfiguration = {
        databasePolicyValid: false,
        databaseUrlConfigured: true,
        issuerCanonical: true,
        issuerConfigured: true,
        resourceCanonical: true,
        resourceConfigured: true,
      };
      report({ ...value, outcome: "setup_unavailable", ownerConfiguration, stage });
      expect(sink).toHaveBeenCalledOnce();
      for (const field of Object.keys(ownerConfiguration)) {
        report({
          ...value,
          ownerConfiguration: { ...ownerConfiguration, [field]: secret },
          stage,
        });
      }
      const unexpectedOwnerConfiguration = { ...ownerConfiguration, extra: secret };
      report({ ...value, ownerConfiguration: unexpectedOwnerConfiguration, stage });
      expect(sink).toHaveBeenCalledOnce();
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    },
  );
  it("reports closed metadata and a session hash without private context", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    report({ ...value, httpStatus: 403 });
    expect(sink.mock.calls[0]?.[0]).toEqual({
      ...value,
      event: "builder.hosted_neon_consent",
      httpStatus: 403,
      sessionIdHash: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
    });
    const withExtra = { ...value, extra: secret };
    report(withExtra);
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
  it("rejects hostile metadata getters and arbitrary runtime strings without throwing", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    const hostile = { ...value };
    Object.defineProperty(hostile, "stage", {
      configurable: true,
      get() {
        throw new Error(secret);
      },
    });
    expect(() => {
      report(hostile);
    }).not.toThrow();
    Object.defineProperty(hostile, "stage", { value: secret });
    report(hostile);
    expect(sink).not.toHaveBeenCalled();
  });
  it("does not await or expose throwing/rejecting diagnostic sinks", async () => {
    for (const sink of [
      () => {
        throw new Error(secret);
      },
      async () => {
        await Promise.resolve();
        throw new Error(secret);
      },
    ]) {
      const report = createHostedOperatorConsentDiagnostic(secret, sink);
      expect(() => {
        report(value);
      }).not.toThrow();
    }
    await Promise.resolve();
  });
  it("keeps default console output free of private identity and challenge values", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createHostedOperatorConsentDiagnostic(secret)(value);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });
});

it("accepts only the fixed access classes and whitelisted Vercel code", () => {
  const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  const report = createHostedOperatorConsentDiagnostic(secret, sink);
  report({
    ...value,
    accessClass: "upstream_auth_denied",
    httpStatus: 403,
    vercelError: "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
  });
  expect(sink).toHaveBeenCalledOnce();
  const hostile = { ...value, accessClass: "upstream_auth_denied" as const };
  Object.defineProperty(hostile, "vercelError", { value: secret });
  report(hostile);
  expect(sink).toHaveBeenCalledOnce();
  expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
});

it("rejects private values placed in workload diagnostic fields", () => {
  const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  const report = createHostedOperatorConsentDiagnostic(secret, sink);
  for (const field of ["failedClaim", "joseCode", "reason"]) {
    const hostile = { ...value };
    Object.defineProperty(hostile, "workloadFailure", {
      value: { reason: "verification_failed", [field]: secret },
    });
    report(hostile);
  }
  expect(sink).not.toHaveBeenCalled();
});

it("rejects arbitrary probe variants and accepts only closed transport metadata", () => {
  const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  const report = createHostedOperatorConsentDiagnostic(secret, sink);
  report({
    ...value,
    httpStatus: 404,
    nativeNotFound: true,
    probeVariant: "trusted_oidc_only",
    stage: "operator_header_probe",
  });
  const hostile = { ...value };
  Object.defineProperty(hostile, "probeVariant", { value: secret });
  report(hostile);
  expect(sink).toHaveBeenCalledOnce();
  expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
});
