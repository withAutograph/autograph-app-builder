import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createHostedOperatorConsentDiagnostic,
  operatorOwnerStoreImportErrorCodeSchema,
  reportOperatorPlanningMismatch,
} from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  HostedOperatorConsentMetadata,
  OperatorPlanningMismatchBoundary,
  OperatorPlanningMismatchField,
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

describe("operator planning mismatch diagnostics", () => {
  const fields: OperatorPlanningMismatchField[] = [
    "application_missing",
    "app_project",
    "app_branch",
    "team",
    "project_separation",
    "gateway_branch",
    "app_environment",
    "gateway_environment",
    "project_identity",
    "project_owner",
    "deployment_project",
    "deployment_identity",
    "deployment_owner",
    "deployment_ready",
    "deployment_environment",
    "deployment_branch",
    "deployment_missing",
    "public_origin",
    "gateway_origin",
    "plan_action",
    "plan_selection",
    "gateway_plan",
  ];

  it.each([
    "application_selection",
    "inventory_configuration",
    "inventory_project",
    "inventory_deployment",
    "gateway_origin",
    "plan_result",
  ] as const)("reports fixed labels and a session hash at %s", (boundary) => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    reportOperatorPlanningMismatch(
      secret,
      boundary,
      Object.fromEntries(fields.map((field) => [field, true])),
      sink,
    );
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      event: "builder.hosted_neon_consent",
      sessionIdHash: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
      boundary: "operator",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      planningMismatch: { boundary },
    });
    expect(new Set(sink.mock.calls[0]?.[0].planningMismatch?.fields)).toEqual(new Set(fields));
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("collects only true known labels without accessing unknown values", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const failed = { team: true, app_project: false, payload: secret };
    Object.defineProperty(failed, "gateway_origin", { value: secret });
    Object.defineProperty(failed, secret, {
      get() {
        throw new Error(secret);
      },
    });
    reportOperatorPlanningMismatch(secret, "inventory_configuration", failed, sink);
    expect(sink.mock.calls[0]?.[0].planningMismatch).toEqual({
      boundary: "inventory_configuration",
      fields: ["team"],
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    reportOperatorPlanningMismatch(secret, "plan_result", {}, sink);
    reportOperatorPlanningMismatch(secret, "plan_result", { plan_action: false }, sink);
    const inherited: Partial<Record<OperatorPlanningMismatchField, boolean>> = {};
    Object.setPrototypeOf(inherited, { team: true });
    reportOperatorPlanningMismatch(secret, "plan_result", inherited, sink);
    expect(sink).toHaveBeenCalledOnce();
  });

  it("rejects private or unknown labels in the strict metadata", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    for (const [field, invalid] of [
      ["boundary", secret],
      ["fields", [secret]],
      ["payload", secret],
    ] as const) {
      const metadata: HostedOperatorConsentMetadata = {
        ...value,
        planningMismatch: { boundary: "plan_result", fields: ["team"] },
      };
      Object.defineProperty(metadata.planningMismatch, field, { enumerable: true, value: invalid });
      report(metadata);
    }
    const selection = { boundary: "plan_result" } satisfies {
      boundary: OperatorPlanningMismatchBoundary;
    };
    Object.defineProperty(selection, "boundary", { value: secret });
    reportOperatorPlanningMismatch(secret, selection.boundary, { team: true }, sink);
    expect(sink).not.toHaveBeenCalled();
  });

  it("does not throw or expose hostile getters or proxies", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const hostile: Partial<Record<OperatorPlanningMismatchField, boolean>> = {};
    Object.defineProperty(hostile, "team", {
      get() {
        throw new Error(secret);
      },
    });
    const target: Partial<Record<OperatorPlanningMismatchField, boolean>> = {};
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    });
    const invalid = { failed: {} } satisfies {
      failed: Partial<Record<OperatorPlanningMismatchField, boolean>>;
    };
    Object.defineProperty(invalid, "failed", { value: null });
    for (const failed of [hostile, proxy, invalid.failed]) {
      expect(() => {
        reportOperatorPlanningMismatch(secret, "inventory_configuration", failed, sink);
      }).not.toThrow();
    }
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    const metadata: HostedOperatorConsentMetadata = {
      ...value,
      planningMismatch: { boundary: "plan_result", fields: ["team"] },
    };
    Object.defineProperty(metadata.planningMismatch, "boundary", {
      get() {
        throw new Error(secret);
      },
    });
    expect(() => {
      report(metadata);
    }).not.toThrow();
    expect(sink).not.toHaveBeenCalled();
  });

  it("does not throw for sink or console failures", async () => {
    for (const sink of [
      () => {
        throw new Error(secret);
      },
      async () => {
        await Promise.resolve();
        throw new Error(secret);
      },
    ]) {
      expect(() => {
        reportOperatorPlanningMismatch(secret, "plan_result", { plan_action: true }, sink);
      }).not.toThrow();
    }
    const log = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error(secret);
    });
    try {
      expect(() => {
        reportOperatorPlanningMismatch(secret, "plan_result", { plan_action: true });
      }).not.toThrow();
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
    await Promise.resolve();
  });
});
