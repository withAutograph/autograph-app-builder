import { createHash } from "node:crypto";
import { APIError } from "@vercel/sandbox";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HostedOperatorError, operatorPublicResultSchema } from "./hosted-operator-contract";
import {
  NormalAuthClientError,
  normalAuthClientFailureDiagnosticSchema,
} from "./hosted-operator-normal-auth-client";
import {
  createHostedOperatorConsentDiagnostic,
  reportOperatorNormalActorProofFailure,
  reportOperatorInventoryReadFailure,
  operatorOwnerStoreImportErrorCodeSchema,
  reportOperatorPlanningMismatch,
  observeOperatorPlanStage,
  observeContinuityPlanningStage,
  reportContinuityPlanningFailure,
  observeOperatorExecutionStage,
  reportOperatorExecutionFailure,
  projectAuthStartupDiagnostic,
  projectOperatorPlanningValidationInvariants,
  reportRuntimePreparationFailure,
} from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  HostedOperatorConsentMetadata,
  OperatorPlanningMismatchBoundary,
  OperatorPlanningMismatchField,
  OperatorPlanStage,
} from "./hosted-operator-consent-diagnostic";

const secret = "private-owner repo https://vercel.com/consent?pkce=private bearer-secret";
const value: HostedOperatorConsentMetadata = {
  boundary: "builder",
  outcome: "started",
  phase: "check",
  stage: "operator_request",
};

describe("closed Neon consent diagnostics", () => {
  it("projects only closed operator response distinctions and result codes", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    report({
      ...value,
      operatorCode: "operator_unavailable",
      operatorResponse: "blocked",
    });
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      operatorCode: "operator_unavailable",
      operatorResponse: "blocked",
    });
    for (const field of ["operatorCode", "operatorResponse"]) {
      report({ ...value, [field]: secret });
    }
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("accepts only closed environment binding request targets", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    const failure = {
      stage: "update_patch" as const,
      reason: "provider_rejected" as const,
      httpStatus: 404,
    };
    for (const requestTarget of ["environment_row", "project_settings"] as const) {
      report({ ...value, hostedEnvironmentBindingFailure: { ...failure, requestTarget } });
      expect(sink.mock.calls.at(-1)?.[0].hostedEnvironmentBindingFailure).toEqual({
        ...failure,
        requestTarget,
      });
    }
    for (const field of ["requestTarget", "providerCode", "url"]) {
      report({
        ...value,
        hostedEnvironmentBindingFailure: {
          ...failure,
          requestTarget: "environment_row",
          [field]: secret,
        },
      });
    }
    expect(sink).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it.each([
    "not_found",
    "project_not_found",
    "forbidden",
    "unauthorized",
    "integration_configuration_disabled",
    "invalid_token",
    "other",
  ] as const)(
    "retains the closed provider code %s with its request target and HTTP status",
    (providerCode) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      const report = createHostedOperatorConsentDiagnostic(secret, sink);
      const failure = {
        stage: "update_patch" as const,
        reason: "provider_rejected" as const,
        requestTarget: "project_settings" as const,
        httpStatus: 404,
        providerCode,
      };
      report({ ...value, hostedEnvironmentBindingFailure: failure });
      expect(sink.mock.calls[0]?.[0].hostedEnvironmentBindingFailure).toEqual(failure);
    },
  );

  it("projects only closed app protection observations", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    const failure = {
      stage: "update_patch" as const,
      reason: "provider_rejected" as const,
      requestTarget: "project_settings" as const,
      approvedSourcePresent: true,
      approvedPairCovered: false,
    };
    for (const trustedSourcesVisibility of ["absent", "null", "present"] as const) {
      const observed = { ...failure, trustedSourcesVisibility };
      report({ ...value, hostedEnvironmentBindingFailure: observed });
      expect(sink.mock.calls.at(-1)?.[0].hostedEnvironmentBindingFailure).toEqual(observed);
    }
    for (const field of [
      "trustedSourcesVisibility",
      "approvedSourcePresent",
      "approvedPairCovered",
      "trustedSources",
      "projectId",
    ]) {
      report({ ...value, hostedEnvironmentBindingFailure: { ...failure, [field]: secret } });
    }
    for (const invalid of [null, 0, 1, {}, []]) {
      for (const field of ["approvedSourcePresent", "approvedPairCovered"]) {
        report({ ...value, hostedEnvironmentBindingFailure: { ...failure, [field]: invalid } });
      }
    }
    expect(sink).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("projects only closed Gateway request targets and protection observations", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    const gatewayBindings = {
      mode: "bind" as const,
      stage: "write" as const,
      result: "failed" as const,
      requestTarget: "project_settings" as const,
      trustedSourcesVisibility: "absent" as const,
      missingApprovedPairCount: 2,
    };
    report({ ...value, gatewayBindings });
    expect(sink.mock.calls[0]?.[0].gatewayBindings).toEqual(gatewayBindings);
    for (const field of ["requestTarget", "trustedSourcesVisibility", "missingApprovedPairCount"]) {
      report({ ...value, gatewayBindings: { ...gatewayBindings, [field]: secret } });
    }
    for (const missingApprovedPairCount of [-1, 1.5]) {
      report({ ...value, gatewayBindings: { ...gatewayBindings, missingApprovedPairCount } });
    }
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
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

  it("accepts only closed private inventory failure descriptors", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    const inventoryReadFailure = {
      target: "gateway" as const,
      operation: "public_alias" as const,
      phase: "http_response" as const,
      httpStatus: 404,
      errorClass: "operator_error" as const,
      publicCode: "operator_unavailable" as const,
    };
    report({ ...value, inventoryReadFailure });
    expect(sink.mock.calls[0]?.[0].inventoryReadFailure).toEqual(inventoryReadFailure);
    for (const unsafe of [
      { ...inventoryReadFailure, target: "https://private.example/private-path" },
      { ...inventoryReadFailure, url: secret },
      { ...inventoryReadFailure, httpStatus: 99 },
      { ...inventoryReadFailure, errorClass: "Bearer private-token" },
    ]) {
      const invalidMetadata: HostedOperatorConsentMetadata = { ...value };
      Reflect.set(invalidMetadata, "inventoryReadFailure", unsafe);
      report(invalidMetadata);
    }
    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("ignores hostile inventory descriptors without replacing the caller failure", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const descriptor: Parameters<typeof reportOperatorInventoryReadFailure>[1] = {
      target: "inventory",
      operation: "project",
      phase: "fetch",
    };
    const hostileDescriptor = new Proxy(descriptor, {
      ownKeys() {
        throw new Error("descriptor-secret");
      },
    });
    expect(() => {
      reportOperatorInventoryReadFailure(secret, hostileDescriptor, new Error(secret), sink);
    }).not.toThrow();
    expect(sink).not.toHaveBeenCalled();
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

describe("private operator planning stage observer", () => {
  it("executes once and returns the unchanged successful value without diagnostics", async () => {
    const result = { providerPayload: secret };
    const run = vi.fn(async () => {
      await Promise.resolve();
      return result;
    });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    expect(await observeOperatorPlanStage(secret, "journal_read", run, sink)).toBe(result);
    expect(run).toHaveBeenCalledOnce();
    expect(sink).not.toHaveBeenCalled();
  });

  it("returns synchronous successful values unchanged", async () => {
    const result = { providerPayload: secret };
    const run = vi.fn(() => result);
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    expect(await observeOperatorPlanStage(secret, "worker_selection", run, sink)).toBe(result);
    expect(run).toHaveBeenCalledOnce();
    expect(sink).not.toHaveBeenCalled();
  });

  it.each([
    "28P01",
    "42501",
    "42P01",
    "42703",
    "23505",
    "40001",
    "40P01",
    "53300",
    "55000",
    "08001",
    "08006",
  ])("reports only the allowlisted own SQL state %s", async (sqlState) => {
    const rejection = new Error(secret);
    rejection.stack = secret;
    Object.defineProperty(rejection, "code", { value: sqlState });
    Object.defineProperty(rejection, "providerPayload", { value: secret });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(
      observeOperatorPlanStage(
        secret,
        "journal_read",
        () => {
          throw rejection;
        },
        sink,
      ),
    ).rejects.toBe(rejection);
    expect(sink.mock.calls[0]?.[0].planningFailure).toEqual({
      stage: "journal_read",
      errorClass: "unexpected",
      sqlState,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("omits arbitrary, inherited and getter SQL codes", async () => {
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const hostile = new Error(secret);
    Object.defineProperty(hostile, "code", { get: getter });
    const inherited = new Error(secret);
    Object.setPrototypeOf(inherited, Object.assign(new Error(secret), { code: "42501" }));
    const arbitrary = new Error(secret);
    Object.defineProperty(arbitrary, "code", { value: secret });
    await Promise.all(
      [hostile, inherited, arbitrary].map(async (rejection) => {
        const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
        await expect(
          observeOperatorPlanStage(
            secret,
            "journal_read",
            () => {
              throw rejection;
            },
            sink,
          ),
        ).rejects.toBe(rejection);
        expect(sink.mock.calls[0]?.[0].planningFailure).toEqual({
          stage: "journal_read",
          errorClass: "unexpected",
        });
        expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
      }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    "journal_read",
    "accepted_spec",
    "release_selection",
    "release_read",
    "neon_planning",
    "provider_inventory",
    "shared_auth_read",
    "auth_adoption_read",
    "auth_schema_proposal",
    "auth_schema_publish",
    "worker_selection",
    "plan_construction",
    "identity_plan_resolution",
    "plan_composition",
    "plan_validation",
    "plan_authorization",
    "plan_reservation",
    "saved_plan_read",
    "saved_plan_classification",
    "saved_plan_reexposure",
    "successor_prior_read",
    "successor_classification",
    "prior_successor_approval",
    "retained_state_read",
    "retained_approval",
    "plan_journal_update",
  ] satisfies OperatorPlanStage[])("reports only closed metadata for %s", async (planStage) => {
    const rejection = new Error(secret);
    rejection.stack = secret;
    Object.defineProperty(rejection, "providerPayload", { value: secret });
    const run = vi.fn(async () => {
      await Promise.resolve();
      throw rejection;
    });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(observeOperatorPlanStage(secret, planStage, run, sink)).rejects.toBe(rejection);
    expect(run).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledExactlyOnceWith({
      event: "builder.hosted_neon_consent",
      sessionIdHash: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
      boundary: "operator",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      planningFailure: { stage: planStage, errorClass: "unexpected" },
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("uses only the closed operator error codes", async () => {
    await Promise.all(
      operatorPublicResultSchema.shape.code.unwrap().options.map(async (code) => {
        const rejection = new HostedOperatorError(code);
        rejection.message = secret;
        rejection.stack = secret;
        const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
        await expect(
          observeOperatorPlanStage(
            secret,
            "plan_composition",
            () => {
              throw rejection;
            },
            sink,
          ),
        ).rejects.toBe(rejection);
        expect(sink.mock.calls[0]?.[0].planningFailure).toEqual({
          stage: "plan_composition",
          errorClass: "operator_error",
          code,
        });
        expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
      }),
    );
    const rejection = new HostedOperatorError("operator_unavailable");
    Object.defineProperty(rejection, "code", { value: secret });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(
      observeOperatorPlanStage(
        secret,
        "plan_validation",
        () => {
          throw rejection;
        },
        sink,
      ),
    ).rejects.toBe(rejection);
    expect(sink.mock.calls[0]?.[0].planningFailure).toEqual({
      stage: "plan_validation",
      errorClass: "operator_error",
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it.each([
    [
      "Realm identity link must match the owned Auth resource, exact issuer and canonical owner session.",
      "identity_link_scope",
    ],
    [
      "Gateway candidates must belong to the exact approved native project and branch.",
      "gateway_candidate_scope",
    ],
    ["Only an independently READY Gateway candidate may be pinned.", "gateway_candidate_scope"],
    ["Gateway rows must remain in the owned trusted project.", "gateway_environment_scope"],
    [
      "Deployment candidates must remain within their approved project and Preview branch.",
      "app_delivery_scope",
    ],
    [
      "Only an observed READY deployment of this approved delivery may be selected.",
      "app_delivery_scope",
    ],
    ["Managed environment rows must belong to this approved app operation.", "app_delivery_scope"],
    [
      "Historical app delivery must retain its actual owned project, branch and row lineage.",
      "app_delivery_scope",
    ],
  ] as const)("projects a closed label for %s", async (message, label) => {
    const rejection = new z.ZodError([
      { code: "custom", message, path: [secret], params: { providerPayload: secret } },
      { code: "custom", message, path: [secret] },
    ]);
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const run = vi.fn(() => {
      throw rejection;
    });
    await expect(observeOperatorPlanStage(secret, "plan_journal_update", run, sink)).rejects.toBe(
      rejection,
    );
    expect(run).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]?.[0].planningFailure).toEqual({
      stage: "plan_journal_update",
      errorClass: "validation_error",
      validationInvariants: [label],
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(message);
  });

  it("groups arbitrary issue text and structural errors without copying private details", () => {
    const rejection = new z.ZodError([
      { code: "custom", message: secret, path: [secret] },
      { code: "unrecognized_keys", keys: [secret], message: secret, path: [secret] },
    ]);
    expect(projectOperatorPlanningValidationInvariants(rejection)).toEqual([
      "other_custom",
      "schema_shape",
    ]);
  });

  it("ignores inherited issue metadata and never invokes accessors or coercion", () => {
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const hostile = {};
    Object.defineProperty(hostile, "issues", { get: getter });
    const issue = {};
    Object.defineProperty(issue, "code", { get: getter });
    const text = { toString: getter, [Symbol.toPrimitive]: getter };
    expect(projectOperatorPlanningValidationInvariants(hostile)).toEqual(["unknown"]);
    expect(projectOperatorPlanningValidationInvariants(Object.create({ issues: [] }))).toEqual([
      "unknown",
    ]);
    expect(projectOperatorPlanningValidationInvariants({ issues: [issue] })).toEqual(["unknown"]);
    expect(
      projectOperatorPlanningValidationInvariants({ issues: [{ code: "custom", message: text }] }),
    ).toEqual(["other_custom"]);
    expect(getter).not.toHaveBeenCalled();
  });

  it("returns unknown for hostile or revoked proxies and bounds exception inspection", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(secret);
        },
      },
    );
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const invalidLength = new Proxy([], {
      getOwnPropertyDescriptor() {
        return { value: Number.NaN, writable: true, configurable: false };
      },
    });
    for (const error of [
      hostile,
      { issues: hostile },
      { issues: revoked.proxy },
      { issues: invalidLength },
      null,
    ]) {
      expect(projectOperatorPlanningValidationInvariants(error)).toEqual(["unknown"]);
    }
    const lateGetter = vi.fn(() => {
      throw new Error(secret);
    });
    const issues = Array.from({ length: 65 }, () => ({ code: "custom", message: secret }));
    Object.defineProperty(issues, "64", { get: lateGetter });
    expect(projectOperatorPlanningValidationInvariants({ issues })).toEqual([
      "other_custom",
      "unknown",
    ]);
    expect(lateGetter).not.toHaveBeenCalled();
  });

  it("preserves journal validation errors when diagnostic sinks and loggers fail", async () => {
    const rejection = new z.ZodError([{ code: "custom", message: secret, path: [secret] }]);
    const sink = vi.fn(() => {
      throw new Error(secret);
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error(secret);
    });
    try {
      for (const diagnosticSink of [sink, undefined]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Verify each logger failure preserves the original exception.
        await expect(
          observeOperatorPlanStage(
            secret,
            "plan_journal_update",
            () => {
              throw rejection;
            },
            diagnosticSink,
          ),
        ).rejects.toBe(rejection);
      }
      expect(sink).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify([sink.mock.calls, log.mock.calls])).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });

  it("classifies validation and type errors without serializing private details", async () => {
    const parsed = z.literal("valid").safeParse(secret);
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error("Expected the invalid fixture to fail validation");
    }
    await Promise.all(
      (
        [
          [parsed.error, "validation_error"],
          [new TypeError(secret), "type_error"],
          [new Error(secret), "unexpected"],
        ] as const
      ).map(async ([rejection, errorClass]) => {
        const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
        await expect(
          observeOperatorPlanStage(
            secret,
            "plan_validation",
            () => {
              throw rejection;
            },
            sink,
          ),
        ).rejects.toBe(rejection);
        expect(sink.mock.calls[0]?.[0].planningFailure).toEqual({
          stage: "plan_validation",
          errorClass,
        });
        expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
      }),
    );
  });

  it("preserves hostile rejections without reading code or message getters", async () => {
    const rejection = new HostedOperatorError("resource_mismatch");
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    for (const field of ["code", "message", "stack", "cause", "providerPayload"]) {
      Object.defineProperty(rejection, field, { get: getter });
    }
    const proxy = new Proxy(new Error(secret), {
      getPrototypeOf() {
        throw new Error(secret);
      },
    });
    await Promise.all(
      [rejection, proxy].map(async (error) => {
        const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
        await expect(
          observeOperatorPlanStage(
            secret,
            "provider_inventory",
            () => {
              throw error;
            },
            sink,
          ),
        ).rejects.toBe(error);
        expect(sink).toHaveBeenCalledOnce();
        expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
      }),
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("preserves the rejection when sinks or the default logger fail", async () => {
    const rejection = new Error(secret);
    await Promise.all(
      [
        () => {
          throw new Error(secret);
        },
        async () => {
          await Promise.resolve();
          throw new Error(secret);
        },
      ].map(async (sink) => {
        await expect(
          observeOperatorPlanStage(
            secret,
            "plan_reservation",
            () => {
              throw rejection;
            },
            sink,
          ),
        ).rejects.toBe(rejection);
      }),
    );
    const log = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error(secret);
    });
    try {
      await expect(
        observeOperatorPlanStage(secret, "plan_reservation", () => {
          throw rejection;
        }),
      ).rejects.toBe(rejection);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
    await Promise.resolve();
  });

  it("rejects arbitrary failure fields and runtime labels", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const report = createHostedOperatorConsentDiagnostic(secret, sink);
    for (const [field, invalid] of [
      ["stage", secret],
      ["errorClass", secret],
      ["code", secret],
      ["message", secret],
    ] as const) {
      const metadata: HostedOperatorConsentMetadata = {
        ...value,
        planningFailure: { stage: "plan_validation", errorClass: "unexpected" },
      };
      Object.defineProperty(metadata.planningFailure, field, { enumerable: true, value: invalid });
      report(metadata);
    }
    expect(sink).not.toHaveBeenCalled();
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

it("preserves a plan owner authorization rejection with only the fixed private stage", async () => {
  const error = new HostedOperatorError("authorization_required");
  const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  await expect(
    observeOperatorPlanStage(
      "private-owner-session",
      "plan_owner_authorization",
      () => {
        throw error;
      },
      sink,
    ),
  ).rejects.toBe(error);
  expect(sink).toHaveBeenCalledWith(
    expect.objectContaining({
      planningFailure: {
        stage: "plan_owner_authorization",
        errorClass: "operator_error",
        code: "authorization_required",
      },
    }),
  );
});

it("preserves execution failures and redacts arbitrary error properties", async () => {
  const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  const error = Object.assign(new Error(secret), { url: secret, output: secret });
  await expect(
    observeOperatorExecutionStage(
      secret,
      "readback",
      () => {
        throw error;
      },
      sink,
      { stage: "readback", mode: "inspect", commandExit: "zero" },
    ),
  ).rejects.toBe(error);
  expect(sink.mock.calls[0]?.[0].executionFailure).toMatchObject({
    stage: "readback",
    mode: "inspect",
    commandExit: "zero",
    errorClass: "unexpected",
  });
  expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
});
it.each([
  [
    "operator_error",
    new HostedOperatorError("operator_unavailable"),
    "operator_unavailable",
    undefined,
  ],
  ["validation_error", new z.ZodError([]), undefined, undefined],
  ["type_error", new TypeError(secret), undefined, undefined],
  [
    "unexpected",
    Object.assign(new Error(secret), { code: "42501", url: secret, sql: secret, payload: secret }),
    undefined,
    "42501",
  ],
] as const)(
  "reports %s execution failures at final verifier stages with closed classification",
  (errorClass, error, code, sqlState) => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const priorCode: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    reportOperatorExecutionFailure("private-session", "final_runtime_readiness", error, sink, {
      stage: "final_runtime_readiness",
      mode: "inspect",
    });
    expect(sink.mock.calls[0]?.[0].executionFailure).toEqual({
      stage: "final_runtime_readiness",
      mode: "inspect",
      errorClass,
      ...(code === undefined ? {} : { code }),
      ...(sqlState === undefined ? {} : { sqlState }),
    });
    expect(Object.getOwnPropertyDescriptor(error, "code")?.value).toBe(priorCode);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("private-session");
  },
);
it("keeps final inventory diagnostic reporting nonthrowing for hostile failures and sinks", () => {
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error(secret);
      },
    },
  );
  expect(() => {
    reportOperatorExecutionFailure("private-session", "final_inventory_readback", hostile, () => {
      throw new Error(secret);
    });
  }).not.toThrow();
});
it("retains only a closed runtime readiness stage in execution diagnostics", () => {
  const validSink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  reportOperatorExecutionFailure(
    "private-session",
    "final_runtime_readiness",
    new Error(secret),
    validSink,
    {
      stage: "final_runtime_readiness",
      runtimeReadinessStage: "runtime_credential",
    },
  );
  expect(validSink.mock.calls[0]?.[0].executionFailure).toMatchObject({
    stage: "final_runtime_readiness",
    runtimeReadinessStage: "runtime_credential",
  });
  const invalidSink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  for (const field of ["runtimeReadinessStage"]) {
    reportOperatorExecutionFailure(
      "private-session",
      "final_runtime_readiness",
      new Error(secret),
      invalidSink,
      {
        stage: "final_runtime_readiness",
        [field]: secret,
      },
    );
  }
  expect(invalidSink).not.toHaveBeenCalled();
  expect(JSON.stringify(validSink.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(validSink.mock.calls)).not.toContain("private-session");
});
it.each([
  "final_authority",
  "final_verifier_entry",
  "final_owner_authorization",
  "final_journal_read",
  "final_proof_parse",
  "final_proof_publication",
  "resource_lease",
  "final_lease_release",
  "execution_settlement",
] as const)("keeps the original exception at the closed %s boundary", async (stage) => {
  const error = new TypeError(secret);
  const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
  await expect(
    observeOperatorExecutionStage(
      "private-session",
      stage,
      () => {
        throw error;
      },
      sink,
    ),
  ).rejects.toBe(error);
  expect(sink.mock.calls[0]?.[0].executionFailure).toEqual({ stage, errorClass: "type_error" });
  expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(sink.mock.calls)).not.toContain("private-session");
});
it("does not let a diagnostic sink failure replace the original execution failure", async () => {
  const error = new HostedOperatorError("operator_unavailable");
  await expect(
    observeOperatorExecutionStage(
      secret,
      "effect_reconciliation",
      () => {
        throw error;
      },
      () => {
        throw new Error(secret);
      },
    ),
  ).rejects.toBe(error);
});

it.each([
  [
    "module_loading",
    Object.assign(new Error(secret), { code: "ERR_MODULE_NOT_FOUND" }),
    "unexpected",
    undefined,
    "ERR_MODULE_NOT_FOUND",
  ],
  ["input_validation", new z.ZodError([]), "validation_error", undefined, undefined],
  [
    "prior_approval",
    new HostedOperatorError("resource_mismatch"),
    "operator_error",
    "resource_mismatch",
    undefined,
  ],
  ["operator_execute", new TypeError(secret), "type_error", undefined, undefined],
  ["operator_execute", new DOMException(secret, "AbortError"), "abort_error", undefined, undefined],
  [
    "prior_approval",
    new DOMException(secret, "TimeoutError"),
    "timeout_error",
    undefined,
    undefined,
  ],
] as const)(
  "reports closed preparation classification at %s without private values",
  (stage, error, errorClass, code, moduleCode) => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    reportRuntimePreparationFailure("private-session", stage, error, sink);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "builder",
        preparationFailure: {
          stage,
          errorClass,
          ...(code === undefined ? {} : { code }),
          ...(moduleCode === undefined ? {} : { moduleCode }),
        },
      }),
    );
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("private-session");
  },
);
it("keeps preparation failure reporting nonthrowing for hostile errors and throwing sinks", () => {
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      },
    },
  );
  const sink = vi.fn<HostedOperatorConsentDiagnosticSink>(() => {
    throw new Error(secret);
  });
  expect(() => {
    reportRuntimePreparationFailure("private-session", "client_resolution", hostile, sink);
  }).not.toThrow();
  expect(sink).toHaveBeenCalledWith(
    expect.objectContaining({
      preparationFailure: { stage: "client_resolution", errorClass: "unexpected" },
    }),
  );
});

it.each([
  {
    metadata: { stage: "schema_replan", domain_code: "migration_contention", private: secret },
    expected: { stage: "schema_replan", domain_code: "migration_contention" },
  },
  {
    metadata: { stage: "schema_replan", domain_code: secret },
    expected: { stage: "schema_replan" },
  },
  { metadata: { stage: secret, domain_code: "migration_contention" }, expected: undefined },
  {
    metadata: Object.defineProperty({}, "stage", {
      get() {
        throw new Error(secret);
      },
    }),
    expected: undefined,
  },
  {
    metadata: new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(secret);
        },
      },
    ),
    expected: undefined,
  },
])(
  "projects advisory Auth startup data without changing execution failure: %j",
  async ({ metadata: advisory, expected }) => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const error = new HostedOperatorError("operator_unavailable");
    const projected = projectAuthStartupDiagnostic(advisory);
    expect(projected).toEqual(expected);
    await expect(
      observeOperatorExecutionStage(
        secret,
        "worker_protocol",
        () => {
          throw error;
        },
        sink,
        {
          stage: "worker_protocol",
          workerFailure: "startup_rejected",
          ...(projected === undefined ? {} : { authStartup: projected }),
        },
      ),
    ).rejects.toBe(error);
    expect(sink.mock.calls[0]?.[0].executionFailure?.workerFailure).toBe("startup_rejected");
    expect(sink.mock.calls[0]?.[0].executionFailure?.authStartup).toEqual(expected);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  },
);
it("does not invoke advisory field getters or inspect extra properties", () => {
  const getter = vi.fn(() => {
    throw new Error(secret);
  });
  const data = { stage: "schema_options" };
  Object.defineProperty(data, "domain_code", { get: getter });
  Object.defineProperty(data, "credentials", { get: getter });
  expect(projectAuthStartupDiagnostic(data)).toEqual({ stage: "schema_options" });
  expect(getter).not.toHaveBeenCalled();
});

describe("normal actor proof failure diagnostics", () => {
  it("projects own closed response facts and discards raw metadata and exceptions", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    reportOperatorNormalActorProofFailure(
      secret,
      {
        stage: "proof_response",
        httpStatus: 401,
        cookiePresent: true,
        contentTypeValid: false,
        redirected: false,
        message: secret,
        cookie: secret,
        url: secret,
        proof: secret,
        actorId: secret,
        errorClass: secret,
      },
      new HostedOperatorError("auth_identity_required"),
      sink,
    );
    expect(sink.mock.calls[0]?.[0].normalActorProofFailure).toEqual({
      stage: "proof_response",
      httpStatus: 401,
      cookiePresent: true,
      contentTypeValid: false,
      redirected: false,
      errorClass: "operator_error",
      code: "auth_identity_required",
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
  it("omits malformed scalar values without coercion or accessor execution", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const failure = Object.defineProperties(
      { stage: "proof_response", httpStatus: 600 },
      {
        cookiePresent: { get: getter },
        redirected: { value: secret },
        contentTypeValid: { value: { toString: getter } },
      },
    );
    reportOperatorNormalActorProofFailure(secret, failure, new TypeError(secret), sink);
    expect(getter).not.toHaveBeenCalled();
    expect(sink.mock.calls[0]?.[0].normalActorProofFailure).toEqual({
      stage: "proof_response",
      errorClass: "type_error",
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
  it("contains hostile proxies, accessors, inherited stages and logger failures", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const failure of [
      null,
      undefined,
      secret,
      revoked.proxy,
      Object.create({ stage: "proof_request" }),
      Object.defineProperty({}, "stage", { get: getter }),
    ]) {
      expect(() => {
        reportOperatorNormalActorProofFailure(secret, failure, revoked.proxy, sink);
      }).not.toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    reportOperatorNormalActorProofFailure(secret, { stage: "proof_request" }, revoked.proxy, sink);
    expect(sink.mock.calls[0]?.[0].normalActorProofFailure).toEqual({
      stage: "proof_request",
      errorClass: "unexpected",
    });
    const hostileSink = () => {
      throw new Error(secret);
    };
    expect(() => {
      reportOperatorNormalActorProofFailure(
        secret,
        { stage: "proof_verify" },
        new Error(secret),
        hostileSink,
      );
    }).not.toThrow();
  });
});

describe("closed normal Auth execution diagnostics", () => {
  it("retains actual client metadata and the original rejection without inspecting private error content", async () => {
    const error = new NormalAuthClientError("auth_rejected", {
      operation: "invite_member",
      httpStatus: 403,
      authCode: "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
      retryAfterMs: 1500,
    });
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    for (const field of ["message", "cause", "body", "url", "cookie", "toJSON"]) {
      Object.defineProperty(error, field, { get: getter });
    }
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(
      observeOperatorExecutionStage(
        secret,
        "execution_settlement",
        () => {
          throw error;
        },
        sink,
      ),
    ).rejects.toBe(error);
    expect(sink.mock.calls[0]?.[0].executionFailure).toEqual({
      stage: "execution_settlement",
      errorClass: "unexpected",
      normalAuth: {
        code: "auth_rejected",
        operation: "invite_member",
        httpStatus: 403,
        authCode: "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
        retryAfterMs: 1500,
      },
    });
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it.each(normalAuthClientFailureDiagnosticSchema.shape.code.options)(
    "preserves the existing closed %s client failure code",
    (code) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      reportOperatorExecutionFailure(
        secret,
        "resource_lease",
        new NormalAuthClientError(code),
        sink,
      );
      expect(sink.mock.calls[0]?.[0].executionFailure?.normalAuth).toEqual({ code });
    },
  );

  it.each(normalAuthClientFailureDiagnosticSchema.shape.operation.unwrap().options)(
    "preserves the existing closed %s client operation",
    (operation) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      reportOperatorExecutionFailure(
        secret,
        "resource_lease",
        new NormalAuthClientError("transport_failed", { operation }),
        sink,
      );
      expect(sink.mock.calls[0]?.[0].executionFailure?.normalAuth).toEqual({
        code: "transport_failed",
        operation,
      });
    },
  );

  it.each([
    [100, 0],
    [599, Number.MAX_SAFE_INTEGER],
  ])("retains valid numeric boundary metadata (%s, %s)", (httpStatus, retryAfterMs) => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    reportOperatorExecutionFailure(
      secret,
      "resource_lease",
      new NormalAuthClientError("deadline_exceeded", { httpStatus, retryAfterMs }),
      sink,
    );
    expect(sink.mock.calls[0]?.[0].executionFailure?.normalAuth).toEqual({
      code: "deadline_exceeded",
      httpStatus,
      retryAfterMs,
    });
  });

  it("drops arbitrary and inherited optional values independently without invoking accessors", () => {
    const error = new NormalAuthClientError("invalid_response");
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    Object.defineProperty(error, "operation", { get: getter });
    Object.defineProperty(error, "httpStatus", { value: secret });
    Object.defineProperty(error, "authCode", { value: secret });
    Object.defineProperty(error, "retryAfterMs", { value: Number.POSITIVE_INFINITY });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    reportOperatorExecutionFailure(secret, "resource_lease", error, sink);
    expect(sink.mock.calls[0]?.[0].executionFailure?.normalAuth).toEqual({
      code: "invalid_response",
    });
    expect(getter).not.toHaveBeenCalled();
    const inherited = new NormalAuthClientError("auth_rejected");
    Reflect.deleteProperty(inherited, "operation");
    Reflect.deleteProperty(inherited, "httpStatus");
    const inheritedPrototype = { operation: "list_members", httpStatus: 403 };
    Object.setPrototypeOf(inheritedPrototype, NormalAuthClientError.prototype);
    Object.setPrototypeOf(inherited, inheritedPrototype);
    reportOperatorExecutionFailure(secret, "resource_lease", inherited, sink);
    expect(sink.mock.calls[1]?.[0].executionFailure?.normalAuth).toEqual({ code: "auth_rejected" });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it.each([99, 600, Number.NaN, Number.POSITIVE_INFINITY, 200.5])(
    "discards an invalid HTTP status %s",
    (httpStatus) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      reportOperatorExecutionFailure(
        secret,
        "resource_lease",
        new NormalAuthClientError("invalid_response", { operation: "list_members", httpStatus }),
        sink,
      );
      expect(sink.mock.calls[0]?.[0].executionFailure?.normalAuth).toEqual({
        code: "invalid_response",
        operation: "list_members",
      });
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "discards an invalid mutated retry interval %s",
    (retryAfterMs) => {
      const error = new NormalAuthClientError("deadline_exceeded", { httpStatus: 429 });
      Object.defineProperty(error, "retryAfterMs", { value: retryAfterMs });
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      reportOperatorExecutionFailure(secret, "resource_lease", error, sink);
      expect(sink.mock.calls[0]?.[0].executionFailure?.normalAuth).toEqual({
        code: "deadline_exceeded",
        httpStatus: 429,
      });
    },
  );

  it("does not classify unbranded objects, inherited/invalid codes or code accessors as client failures", () => {
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const accessor = new NormalAuthClientError("auth_rejected");
    Object.defineProperty(accessor, "code", { get: getter });
    const invalid = new NormalAuthClientError("auth_rejected");
    Object.defineProperty(invalid, "code", { value: secret });
    const inherited: unknown = Object.create(new NormalAuthClientError("auth_rejected"));
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    for (const error of [
      accessor,
      invalid,
      inherited,
      { name: "NormalAuthClientError", code: "auth_rejected", operation: "list_members" },
    ]) {
      reportOperatorExecutionFailure(secret, "resource_lease", error, sink);
    }
    expect(
      sink.mock.calls.every(
        ([diagnostic]) => diagnostic.executionFailure?.normalAuth === undefined,
      ),
    ).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("preserves hostile proxy failures and ignores throwing sinks without leaking or replacing errors", async () => {
    const revoked = Proxy.revocable(new NormalAuthClientError("auth_rejected"), {});
    revoked.revoke();
    const descriptorTrap = new Proxy(new NormalAuthClientError("auth_rejected"), {
      getOwnPropertyDescriptor: () => {
        throw new Error(secret);
      },
    });
    const prototypeTrap = new Proxy(new Error(secret), {
      getPrototypeOf: () => {
        throw new Error(secret);
      },
    });
    for (const error of [revoked.proxy, descriptorTrap, prototypeTrap]) {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Observe each exact hostile original rejection with its own nonthrowing diagnostic sink.
      await expect(
        observeOperatorExecutionStage(
          secret,
          "resource_lease",
          () => {
            throw error;
          },
          sink,
        ),
      ).rejects.toBe(error);
      expect(sink.mock.calls[0]?.[0].executionFailure?.normalAuth).toBeUndefined();
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
      expect(() => {
        reportOperatorExecutionFailure(secret, "resource_lease", error, () => {
          throw new Error(secret);
        });
      }).not.toThrow();
    }
  });
});

describe("closed normal actor journal-change execution marker", () => {
  it("projects only the exact owned Error message while retaining the original rejection", async () => {
    const error = new Error("normal_actor_journal_changed");
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    for (const key of ["body", "cause", "cookie", "toJSON"]) {
      Object.defineProperty(error, key, { get: getter });
    }
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(
      observeOperatorExecutionStage(
        secret,
        "resource_lease",
        () => {
          throw error;
        },
        sink,
      ),
    ).rejects.toBe(error);
    expect(sink.mock.calls[0]?.[0].executionFailure).toEqual({
      stage: "resource_lease",
      errorClass: "unexpected",
      journalFailure: "normal_actor_journal_changed",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
  it("does not project arbitrary, similar, inherited or accessor messages", () => {
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const accessor = new Error(secret);
    Object.defineProperty(accessor, "message", { get: getter });
    const inherited = new Error(secret);
    Reflect.deleteProperty(inherited, "message");
    const prototype = { message: "normal_actor_journal_changed" };
    Object.setPrototypeOf(prototype, Error.prototype);
    Object.setPrototypeOf(inherited, prototype);
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    for (const error of [
      new Error(secret),
      new Error("normal_actor_journal_changed-extra"),
      new Error(" normal_actor_journal_changed"),
      accessor,
      inherited,
      { message: "normal_actor_journal_changed" },
    ]) {
      reportOperatorExecutionFailure(secret, "resource_lease", error, sink);
    }
    expect(
      sink.mock.calls.every(
        ([diagnostic]) => diagnostic.executionFailure?.journalFailure === undefined,
      ),
    ).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
  it("contains hostile and revoked proxies and throwing sinks without reading messages or changing failures", async () => {
    const revoked = Proxy.revocable(new Error("normal_actor_journal_changed"), {});
    revoked.revoke();
    const hostile = new Proxy(new Error("normal_actor_journal_changed"), {
      getOwnPropertyDescriptor: () => {
        throw new Error(secret);
      },
    });
    for (const error of [revoked.proxy, hostile]) {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each exact hostile rejection is observed independently with its own diagnostic sink.
      await expect(
        observeOperatorExecutionStage(
          secret,
          "resource_lease",
          () => {
            throw error;
          },
          sink,
        ),
      ).rejects.toBe(error);
      expect(sink.mock.calls[0]?.[0].executionFailure?.journalFailure).toBeUndefined();
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
      expect(() => {
        reportOperatorExecutionFailure(secret, "resource_lease", error, () => {
          throw new Error(secret);
        });
      }).not.toThrow();
    }
  });
});

describe("continuity planning failure diagnostics", () => {
  it("preserves successful values and invokes the existing call once without logging", async () => {
    const result = { private: secret };
    const run = vi.fn(() => Promise.resolve(result));
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(observeContinuityPlanningStage(secret, "sandbox_resume", run, sink)).resolves.toBe(
      result,
    );
    expect(run).toHaveBeenCalledOnce();
    expect(sink).not.toHaveBeenCalled();
  });

  it.each([
    { error: new HostedOperatorError("operator_unavailable"), errorClass: "operator_error" },
    { error: new z.ZodError([]), errorClass: "validation_error" },
    { error: new TypeError(secret), errorClass: "type_error" },
    { error: new Error(secret), errorClass: "unexpected" },
  ])(
    "retains the original $errorClass rejection with only closed metadata",
    async ({ error, errorClass }) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      const run = vi.fn(() => Promise.reject(error));
      await expect(
        observeContinuityPlanningStage(secret, "port_observation", run, sink),
      ).rejects.toBe(error);
      expect(run).toHaveBeenCalledOnce();
      const diagnostic = sink.mock.calls[0]?.[0];
      expect(diagnostic?.continuityPlanningFailure).toEqual({
        stage: "port_observation",
        errorClass,
      });
      expect(diagnostic?.sessionIdHash).toBe(
        `sha256:${createHash("sha256").update(secret).digest("hex")}`,
      );
      expect(diagnostic?.boundary).toBe("operator");
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    },
  );

  it.each([200, 401, 403, 404, 409, 429, 500, 599])(
    "reports only the recognized Sandbox SDK HTTP status %s and preserves the rejection",
    async (httpStatus) => {
      const error = new APIError(new Response(secret, { status: httpStatus }), {
        message: secret,
        json: { error: { code: secret } },
        text: secret,
      });
      const getter = vi.fn(() => {
        throw new Error(secret);
      });
      for (const key of ["message", "name", "code", "json", "text", "cause"]) {
        Object.defineProperty(error, key, { get: getter });
      }
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      const controller = new AbortController();
      await expect(
        observeContinuityPlanningStage(
          secret,
          "sandbox_resume",
          () => Promise.reject(error),
          sink,
          controller.signal,
        ),
      ).rejects.toBe(error);
      expect(sink.mock.calls[0]?.[0].continuityPlanningFailure).toEqual({
        stage: "sandbox_resume",
        errorClass: "sandbox_api_error",
        httpStatus,
        signalAborted: false,
      });
      expect(getter).not.toHaveBeenCalled();
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    },
  );

  it("distinguishes cancellation from an unknown resume failure without changing either rejection", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException(secret, "AbortError");
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(
      observeContinuityPlanningStage(
        secret,
        "sandbox_resume",
        () => Promise.reject(error),
        sink,
        controller.signal,
      ),
    ).rejects.toBe(error);
    expect(sink.mock.calls[0]?.[0].continuityPlanningFailure).toEqual({
      stage: "sandbox_resume",
      errorClass: "abort_error",
      signalAborted: true,
    });
    const unknown = new Error(secret);
    await expect(
      observeContinuityPlanningStage(
        secret,
        "sandbox_resume",
        () => Promise.reject(unknown),
        sink,
        controller.signal,
      ),
    ).rejects.toBe(unknown);
    expect(sink.mock.calls[1]?.[0].continuityPlanningFailure).toEqual({
      stage: "sandbox_resume",
      errorClass: "unexpected",
      signalAborted: true,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("keeps other planning stages unchanged for SDK errors and cancellation", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const controller = new AbortController();
    controller.abort();
    reportContinuityPlanningFailure(
      secret,
      "dispatcher_planning",
      new APIError(new Response(secret, { status: 403 })),
      sink,
      controller.signal,
    );
    reportContinuityPlanningFailure(
      secret,
      "port_observation",
      new DOMException(secret, "AbortError"),
      sink,
      controller.signal,
    );
    expect(sink.mock.calls.map(([diagnostic]) => diagnostic.continuityPlanningFailure)).toEqual([
      { stage: "dispatcher_planning", errorClass: "unexpected" },
      { stage: "port_observation", errorClass: "unexpected" },
    ]);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it.each(["tool_plan_request", "client_transport"] as const)(
    "reports %s on the builder boundary",
    (stage) => {
      const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
      reportContinuityPlanningFailure(secret, stage, new Error(secret), sink);
      expect(sink.mock.calls[0]?.[0].boundary).toBe("builder");
      expect(sink.mock.calls[0]?.[0].continuityPlanningFailure).toEqual({
        stage,
        errorClass: "unexpected",
      });
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    },
  );

  it("does not read error messages, names, codes, causes or private details", async () => {
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const error = new Error(secret);
    for (const key of ["name", "message", "code", "cause", "url", "headers", "body"]) {
      Object.defineProperty(error, key, { get: getter });
    }
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(
      observeContinuityPlanningStage(
        secret,
        "prepared_runtime",
        () => {
          throw error;
        },
        sink,
      ),
    ).rejects.toBe(error);
    expect(getter).not.toHaveBeenCalled();
    expect(sink.mock.calls[0]?.[0].continuityPlanningFailure).toEqual({
      stage: "prepared_runtime",
      errorClass: "unexpected",
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("preserves hostile rejections and ignores a failing diagnostic sink", async () => {
    const revoked = Proxy.revocable(new Error(secret), {});
    revoked.revoke();
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    await expect(
      observeContinuityPlanningStage(
        secret,
        "dispatcher_planning",
        () => {
          throw revoked.proxy;
        },
        sink,
      ),
    ).rejects.toBe(revoked.proxy);
    expect(sink.mock.calls[0]?.[0].continuityPlanningFailure).toEqual({
      stage: "dispatcher_planning",
      errorClass: "unexpected",
    });
    const error = new Error(secret);
    await expect(
      observeContinuityPlanningStage(
        secret,
        "sandbox_resume",
        () => {
          throw error;
        },
        () => {
          throw new Error(secret);
        },
      ),
    ).rejects.toBe(error);
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("rejects extra error details at the closed diagnostic sink", () => {
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>();
    const failure = {
      stage: "port_observation" as const,
      errorClass: "unexpected" as const,
      details: secret,
    };
    createHostedOperatorConsentDiagnostic(
      secret,
      sink,
    )({ ...value, continuityPlanningFailure: failure });
    expect(sink).not.toHaveBeenCalled();
  });
});
