import {
  continuityTransportRequestSchema,
  continuityPlannedSchema,
} from "./hosted-operator-continuity-transport";
import {
  hostedContinuityRequestSchema,
  continuityStatusSchema,
  parseContinuityRequestForPlan,
} from "./hosted-operator-continuity-contract";
import type {
  HostedContinuityRequest,
  ContinuityRuntimeSelection,
} from "./hosted-operator-continuity-contract";
import {
  tenantExportTransportRequestSchema,
  tenantExportPlannedSchema,
} from "./hosted-operator-export-transport";
import {
  hostedTenantExportRequestSchema,
  tenantExportStatusSchema,
} from "./hosted-operator-export-contract";
import type { HostedTenantExportRequest } from "./hosted-operator-export-contract";
import { Agent } from "undici";
import {
  operatorHeaderProbeRequired,
  reportHostedOperatorHeaderProbes,
} from "./hosted-operator-header-probes";
import { reportHostedOperatorCallerWorkload } from "./hosted-operator-caller-workload";
import {
  createHostedOperatorConsentDiagnostic,
  reportContinuityPlanningFailure,
} from "./hosted-operator-consent-diagnostic";
import type {
  ContinuityPlanningStage,
  HostedOperatorConsentMetadata,
} from "./hosted-operator-consent-diagnostic";
import { neonAuthorizationResultSchema } from "./hosted-operator-neon-authorization";
import { z } from "zod";
import { normalActorIdentityManifestSchema } from "./hosted-operator-normal-actor-program";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { hostedRuntimeProofSchema } from "./hosted-runtime-journal";
import { resolveHostedOperatorOwnerContext } from "./hosted-operator-owner-context";
import {
  OPERATOR_EXECUTION_OBSERVATION_HEADER,
  OPERATOR_EXECUTION_OBSERVATION_PREFERENCE,
} from "./hosted-operator-execution-observation-protocol";
import type { OperatorOwnerContext, OperatorRequest } from "./hosted-operator-contract";
import {
  HostedOperatorError,
  operatorNativePreviewSchema,
  assertOperatorNativePreview,
  hostedOperatorPlanSchema,
  operatorPublicResultSchema,
  operatorAuthIdentityInputSchema,
  operatorRequestSchema,
  operatorSelectionSchema,
  restrictedOperatorEnvironment,
  sameOperatorSelection,
} from "./hosted-operator-contract";

/** Match the protected operator's function duration without changing unrelated fetches. */
export const createHostedOperatorDispatcher = (factory?: Agent.Options["factory"]) =>
  new Agent({
    bodyTimeout: 1_800_000,
    headersTimeout: 1_800_000,
    ...(factory === undefined ? {} : { factory }),
  });
const operatorDispatcher = createHostedOperatorDispatcher();

const bindingSchema = z.strictObject({
  environment: z.record(z.string(), z.string()),
  nativePreview: operatorNativePreviewSchema.optional(),
  normalActors: z
    .strictObject({
      origin: z.url(),
      identities: normalActorIdentityManifestSchema,
      files: z.record(z.string(), z.string()),
    })
    .optional(),
  operationRef: z.uuid(),
  plan: hostedOperatorPlanSchema,
  proof: hostedRuntimeProofSchema,
});
const operatorSuccessSchemas = {
  plan: operatorPublicResultSchema,
  status: operatorPublicResultSchema,
  execute: operatorPublicResultSchema,
  bindings: bindingSchema,
  "auth-identity-input": operatorAuthIdentityInputSchema,
  "neon-authorization": neonAuthorizationResultSchema,
  "resolve-preview-target": operatorSelectionSchema,
} satisfies Record<OperatorRequest["action"], z.ZodType>;
const operatorResponseDiagnostic = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Each action's closed success schema is applied before diagnostics are projected.
  value: unknown,
  action: OperatorRequest["action"],
): Pick<HostedOperatorConsentMetadata, "operatorResponse" | "operatorCode"> & {
  accessClass: NonNullable<HostedOperatorConsentMetadata["accessClass"]>;
} => {
  const blocked = operatorPublicResultSchema.safeParse(value);
  if (blocked.success && blocked.data.status === "blocked") {
    return {
      accessClass:
        blocked.data.code === "authorization_required" ? "application_auth_denied" : "other_failed",
      operatorResponse: "blocked",
      ...(blocked.data.code === undefined ? {} : { operatorCode: blocked.data.code }),
    };
  }
  if (operatorSuccessSchemas[action].safeParse(value).success) {
    return { accessClass: "ok" };
  }
  return {
    accessClass: "other_failed",
    operatorResponse: "schema_invalid",
  };
};

/** Private execution transport failure; the original error is retained only as cause. */
// oxlint-disable-next-line unicorn/custom-error-definition -- This private error name is part of the workflow guard contract.
export class HostedOperatorTransportUnknown extends Error {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Retain only as a non-logged cause for guarded workflow classification.
  constructor(cause: unknown) {
    super("Hosted operator execution transport outcome is unknown", { cause });
    this.name = "HostedOperatorTransportUnknown";
  }
}

export const isHostedOperatorTransportUnknown = (
  error: unknown,
): error is HostedOperatorTransportUnknown => error instanceof HostedOperatorTransportUnknown;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Runtime classification uses only Error.name and AbortSignal state.
const isCancellation = (error: unknown, signal?: AbortSignal) =>
  signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
/** Server-only client. An unconfigured service never falls back to an installer Sandbox. */
export const createHostedOperatorClient = (input: {
  endpoint: string;
  token: () => Promise<string>;
  ownerContext?: OperatorOwnerContext | null;
  sessionId?: string;
  fetch?: typeof fetch;
  allowLoopback?: boolean;
}) => {
  const url = new URL(input.endpoint);
  const loopback =
    input.allowLoopback === true && url.protocol === "http:" && url.hostname === "127.0.0.1";
  const validEndpoint = [
    url.protocol === "https:" || loopback,
    url.username === "",
    url.password === "",
    url.pathname === "/",
    url.search === "",
    url.hash === "",
  ];
  if (validEndpoint.includes(false)) {
    throw new HostedOperatorError("protected_operator_required");
  }
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- This is the single request boundary for auth, response, and transport outcomes.
  const send = async (request: OperatorRequest, signal?: AbortSignal) => {
    const bodyInput =
      input.ownerContext === undefined || input.ownerContext === null
        ? request
        : { ...request, ownerContext: input.ownerContext };
    const body = operatorRequestSchema.parse(bodyInput);
    const isConsentRequest = body.action === "neon-authorization";
    const diagnosticSessionId =
      body.action === "neon-authorization" || body.action === "resolve-preview-target"
        ? body.sessionId
        : body.selection.sessionId;
    const diagnosticPhase = isConsentRequest ? body.phase : "inline";
    const report = createHostedOperatorConsentDiagnostic(diagnosticSessionId);
    report({
      boundary: "builder",
      stage: "operator_request",
      outcome: "started",
      phase: diagnosticPhase,
      operatorAction: body.action,
    });
    const token = await input.token();
    const options: RequestInit & { dispatcher: Agent } = {
      body: JSON.stringify(body),
      dispatcher: operatorDispatcher,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": token,
        ...(body.action === "status" || body.action === "execute"
          ? { [OPERATOR_EXECUTION_OBSERVATION_HEADER]: OPERATOR_EXECUTION_OBSERVATION_PREFERENCE }
          : {}),
      },
      method: "POST",
      redirect: "error",
      signal,
    };
    let response: Response;
    try {
      response = await (input.fetch ?? fetch)(new URL("/v1/runtime", url), options);
    } catch (error) {
      if (
        (body.action === "execute" || body.action === "status") &&
        !isCancellation(error, signal)
      ) {
        throw new HostedOperatorTransportUnknown(error);
      }
      throw error;
    }
    const emit = (
      accessClass: NonNullable<HostedOperatorConsentMetadata["accessClass"]>,
      detail?: Pick<HostedOperatorConsentMetadata, "operatorResponse" | "operatorCode">,
    ) => {
      const vercelError = response.headers.get("x-vercel-error");
      let outcome: HostedOperatorConsentMetadata["outcome"] = "operator_access_denied";
      if (accessClass === "ok") {
        outcome = "verified";
      }
      if (accessClass === "other_failed") {
        outcome = "setup_unavailable";
      }
      const metadata: HostedOperatorConsentMetadata = {
        accessClass,
        boundary: "builder",
        operatorAction: body.action,
        httpStatus: response.status,
        outcome,
        phase: diagnosticPhase,
        stage: "operator_request",
        ...detail,
      };
      if (vercelError === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH") {
        metadata.vercelError = "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH";
      }
      report(metadata);
    };
    if (!response.ok) {
      emit(
        response.status === 401 || response.status === 403
          ? "upstream_auth_denied"
          : "other_failed",
      );
      if (response.status === 401 || response.status === 403) {
        await reportHostedOperatorCallerWorkload({
          httpStatus: response.status,
          phase: diagnosticPhase,
          sessionId: diagnosticSessionId,
          token,
        });
      }
      if (operatorHeaderProbeRequired(response)) {
        await reportHostedOperatorHeaderProbes({
          fetch: input.fetch ?? fetch,
          phase: diagnosticPhase,
          sessionId: diagnosticSessionId,
          signal,
          token,
          url: new URL("/v1/runtime", url),
        });
      }
      throw new HostedOperatorError(
        response.status === 401 || response.status === 403
          ? "authorization_required"
          : "operator_unavailable",
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      emit("other_failed", { operatorResponse: "decode_failed" });
      if (
        (body.action === "execute" || body.action === "status") &&
        error instanceof TypeError &&
        !isCancellation(error, signal)
      ) {
        throw new HostedOperatorTransportUnknown(error);
      }
      throw error;
    }
    const { accessClass, ...detail } = operatorResponseDiagnostic(value, body.action);
    emit(accessClass, detail);
    return value;
  };
  const sendExport = async (
    request: z.input<typeof tenantExportTransportRequestSchema>,
    signal?: AbortSignal,
  ) => {
    const body = tenantExportTransportRequestSchema.parse(request);
    const token = await input.token();
    const options: RequestInit & { dispatcher: Agent } = {
      dispatcher: operatorDispatcher,
      method: "POST",
      body: JSON.stringify(body),
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": token,
      },
    };
    let result: Response;
    try {
      result = await (input.fetch ?? fetch)(new URL("/v1/runtime", url), options);
    } catch (error) {
      if (body.action === "export" && !isCancellation(error, signal)) {
        throw new HostedOperatorTransportUnknown(error);
      }
      throw error;
    }
    if (!result.ok) {
      throw new HostedOperatorError("operator_unavailable");
    }
    let value: unknown;
    try {
      value = await result.json();
    } catch (error) {
      if (body.action === "export" && !isCancellation(error, signal)) {
        throw new HostedOperatorTransportUnknown(error);
      }
      throw error;
    }
    const blocked = operatorPublicResultSchema.safeParse(value);
    if (blocked.success) {
      throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
    }
    return value;
  };
  const sendContinuity = async <T>(
    request: z.input<typeof continuityTransportRequestSchema>,
    resultSchema: z.ZodType<T>,
    signal?: AbortSignal,
    // oxlint-disable-next-line sonarjs/cognitive-complexity -- Failure-only diagnostics retain the existing cancellation, transport-unknown, and response-validation branches.
  ): Promise<T> => {
    let stage: ContinuityPlanningStage = "client_request_validation";
    try {
      const body = continuityTransportRequestSchema.parse(request);
      stage = "client_token_resolution";
      const token = await input.token();
      const options: RequestInit & { dispatcher: Agent } = {
        dispatcher: operatorDispatcher,
        method: "POST",
        body: JSON.stringify(body),
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-vercel-trusted-oidc-idp-token": token,
        },
      };
      let result: Response;
      stage = "client_transport";
      try {
        result = await (input.fetch ?? fetch)(new URL("/v1/runtime", url), options);
      } catch (error) {
        if (body.action === "continuity" && !isCancellation(error, signal)) {
          throw new HostedOperatorTransportUnknown(error);
        }
        throw error;
      }
      stage = "client_response_status";
      if (!result.ok) {
        if (result.status === 401 || result.status === 403) {
          throw new HostedOperatorError("authorization_required");
        }
        if (body.action === "continuity") {
          throw new HostedOperatorTransportUnknown(new HostedOperatorError("operator_unavailable"));
        }
        throw new HostedOperatorError("operator_unavailable");
      }
      stage = "client_response_decode";
      let value: unknown;
      try {
        value = await result.json();
      } catch (error) {
        if (body.action === "continuity" && !isCancellation(error, signal)) {
          throw new HostedOperatorTransportUnknown(error);
        }
        throw error;
      }
      stage = "client_response_validation";
      const blocked = operatorPublicResultSchema.safeParse(value);
      if (blocked.success) {
        throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
      }
      try {
        return resultSchema.parse(value);
      } catch (error) {
        if (body.action === "continuity" && !isCancellation(error, signal)) {
          throw new HostedOperatorTransportUnknown(error);
        }
        throw error;
      }
    } catch (error) {
      try {
        if (request.action === "continuity-plan") {
          reportContinuityPlanningFailure(request.selection.sessionId, stage, error);
        }
      } catch {
        /* Diagnostic context lookup must preserve the original failure. */
      }
      throw error;
    }
  };
  const exportOwner = () => {
    if (input.ownerContext === undefined || input.ownerContext === null) {
      throw new HostedOperatorError("authorization_required");
    }
    return input.ownerContext;
  };
  return {
    async planContinuity(
      selection: z.infer<typeof operatorSelectionSchema>,
      runtime: ContinuityRuntimeSelection,
      idempotencyKey: string,
      signal?: AbortSignal,
    ) {
      const result = await sendContinuity(
        {
          action: "continuity-plan",
          selection,
          runtime,
          idempotencyKey,
          ownerContext: exportOwner(),
        },
        continuityPlannedSchema,
        signal,
      );
      parseContinuityRequestForPlan(result.request, result.plan);
      // Bind the returned approval to the requested owned runtime, without pinning source content.
      const matchesRequestedRuntime = [
        sameOperatorSelection(selection, result.plan.preparedPlan.selection),
        result.plan.runtime.sandboxId === runtime.sandboxId,
        result.plan.runtime.root === runtime.root,
        result.status.intentId === result.plan.intentId,
        result.status.planRef === result.plan.planRef,
      ].every(Boolean);
      if (!matchesRequestedRuntime) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return result;
    },
    async continuityStatus(intentId: string, signal?: AbortSignal) {
      const result = await sendContinuity(
        { action: "continuity-status", intentId, ownerContext: exportOwner() },
        continuityStatusSchema,
        signal,
      );
      if (
        result.intentId !== intentId ||
        result.planRef !== `_protected-operator/continuity-plans/${intentId}`
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return result;
    },
    async continuityApproval(request: HostedContinuityRequest, signal?: AbortSignal) {
      return await sendContinuity(
        {
          ...hostedContinuityRequestSchema.parse(request),
          action: "continuity-approval",
          ownerContext: exportOwner(),
        },
        z.strictObject({ approved: z.boolean() }),
        signal,
      );
    },
    async runContinuity(request: HostedContinuityRequest, callId: string, signal?: AbortSignal) {
      const result = await sendContinuity(
        { ...hostedContinuityRequestSchema.parse(request), callId, ownerContext: exportOwner() },
        continuityStatusSchema,
        signal,
      );
      if (
        result.planRef !== request.planRef ||
        result.intentId !== request.planRef.split("/").at(-1)
      ) {
        throw new HostedOperatorTransportUnknown(new HostedOperatorError("resource_mismatch"));
      }
      return result;
    },
    async planTenantExport(
      selection: z.infer<typeof operatorSelectionSchema>,
      customer: string | { kind: "owner-organization" },
      idempotencyKey: string,
      signal?: AbortSignal,
    ) {
      return tenantExportPlannedSchema.parse(
        await sendExport(
          {
            action: "export-plan",
            selection,
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This public client accepts its typed raw-ID or semantic-selection union; transport validation remains at the server boundary.
            ...(typeof customer === "string"
              ? { customerId: customer }
              : { customerScope: customer.kind }),
            idempotencyKey,
            ownerContext: exportOwner(),
          },
          signal,
        ),
      );
    },
    async readTenantExport(exportId: string, signal?: AbortSignal) {
      return tenantExportPlannedSchema.parse(
        await sendExport({ action: "export-read", exportId, ownerContext: exportOwner() }, signal),
      );
    },
    async tenantExportStatus(exportId: string, signal?: AbortSignal) {
      return tenantExportStatusSchema.parse(
        await sendExport(
          { action: "export-status", exportId, ownerContext: exportOwner() },
          signal,
        ),
      );
    },
    async tenantExportApproval(request: HostedTenantExportRequest, signal?: AbortSignal) {
      return z.strictObject({ approved: z.boolean() }).parse(
        await sendExport(
          {
            ...hostedTenantExportRequestSchema.parse(request),
            action: "export-approval",
            ownerContext: exportOwner(),
          },
          signal,
        ),
      );
    },
    async exportTenantData(
      request: HostedTenantExportRequest,
      callId: string,
      signal?: AbortSignal,
    ) {
      return tenantExportStatusSchema.parse(
        await sendExport(
          {
            ...hostedTenantExportRequestSchema.parse(request),
            callId,
            ownerContext: exportOwner(),
          },
          signal,
        ),
      );
    },
    async authIdentityInput(
      request: Extract<OperatorRequest, { action: "auth-identity-input" }>,
      signal?: AbortSignal,
    ) {
      const raw = await send(request, signal);
      const blocked = operatorPublicResultSchema.safeParse(raw);
      if (blocked.success) {
        throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
      }
      const value = operatorAuthIdentityInputSchema.parse(raw);
      if (
        value.operationRef !== request.operationRef ||
        value.sessionId !== request.selection.sessionId
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return value;
    },
    async bindings(
      request: Extract<OperatorRequest, { action: "bindings" }>,
      signal?: AbortSignal,
    ) {
      const raw = await send(request, signal);
      const blocked = operatorPublicResultSchema.safeParse(raw);
      if (blocked.success) {
        throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
      }
      const value = bindingSchema.parse(raw);
      if (
        value.operationRef !== request.operationRef ||
        !sameOperatorSelection(request.selection, value.plan.selection) ||
        value.proof.releaseId !== value.plan.release.id ||
        value.proof.manifestSha256 !== value.plan.release.sha256
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      if (value.nativePreview) {
        assertOperatorNativePreview(value.nativePreview, value.plan, request.operationRef);
      }
      if (value.normalActors && value.normalActors.origin !== value.nativePreview?.publicOrigin) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return {
        ...value,
        environment: restrictedOperatorEnvironment(
          value.plan,
          value.environment,
          input.ownerContext?.authority,
        ),
      };
    },
    async neonAuthorization(
      request: Extract<OperatorRequest, { action: "neon-authorization" }>,
      signal?: AbortSignal,
    ) {
      try {
        const raw = await send(request, signal);
        const blocked = operatorPublicResultSchema.safeParse(raw);
        if (blocked.success) {
          throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
        }
        return neonAuthorizationResultSchema.parse(raw);
      } catch (error) {
        if (error instanceof HostedOperatorError) {
          throw error;
        }
        throw new HostedOperatorError("operator_unavailable");
      }
    },
    async resolvePreviewTarget(
      request: Extract<OperatorRequest, { action: "resolve-preview-target" }>,
      signal?: AbortSignal,
    ) {
      const raw = await send(request, signal);
      const blocked = operatorPublicResultSchema.safeParse(raw);
      if (blocked.success) {
        throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
      }
      const selection = operatorSelectionSchema.parse(raw);
      if (selection.appId !== request.appId || selection.sessionId !== request.sessionId) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return selection;
    },
    ownerContext: input.ownerContext,
    async request(
      request: Exclude<
        OperatorRequest,
        | { action: "bindings" | "auth-identity-input" | "neon-authorization" }
        | { action: "resolve-preview-target" }
      >,
      signal?: AbortSignal,
    ) {
      return operatorPublicResultSchema.parse(await send(request, signal));
    },
    sessionId: input.sessionId,
  };
};
export const hostedOperatorClientForSession = async (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Eve supplies unknown auth; exactForwardedSessionAuthority parses it at this boundary.
  sessionAuth: unknown,
  adapterSessionId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const report = createHostedOperatorConsentDiagnostic(adapterSessionId);
  let stage: HostedOperatorConsentMetadata["stage"] = "configuration";
  const emit = (outcome: HostedOperatorConsentMetadata["outcome"]) => {
    report({ boundary: "builder", outcome, phase: "inline", stage });
  };
  emit("started");
  try {
    const endpoint = environment.HOSTED_RUNTIME_OPERATOR_URL;
    if (endpoint === undefined || endpoint === "") {
      throw new HostedOperatorError("protected_operator_required");
    }
    emit("verified");
    stage = "owner_authority";
    emit("started");
    const { authority, principal } = exactForwardedSessionAuthority(sessionAuth, {
      realmContinuation: { adapterSessionId },
    });
    emit("verified");
    stage = "owner_context";
    emit("started");
    const ownerContext = await resolveHostedOperatorOwnerContext({
      adapterSessionId,
      authority,
      environment,
      principal,
      sessionAuth,
    });
    emit("verified");
    stage = "client_construction";
    emit("started");
    const client = createHostedOperatorClient({
      endpoint,
      ownerContext,
      sessionId: ownerContext.sessionId,
      token: createVercelWorkloadIdentity().token,
    });
    emit("verified");
    return client;
  } catch (error) {
    emit(
      error instanceof HostedOperatorError && error.code === "authorization_required"
        ? "operator_access_denied"
        : "setup_unavailable",
    );
    throw error;
  }
};
