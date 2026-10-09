import { createHostedOperatorConsentDiagnostic } from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  HostedOperatorConsentMetadata,
} from "./hosted-operator-consent-diagnostic";
import { z } from "zod";
import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import {
  getTokenResponse,
  startAuthorization,
  UserAuthorizationRequiredError,
  NoValidTokenError,
} from "@vercel/connect";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorConsentOwner } from "./hosted-operator-consent-owner";

const connector = "mcp.neon.tech/neon-preview-operator";
const httpsOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
const identity = z.strictObject({
  audience: z.url(),
  environment: z.enum(["development", "preview", "production"]),
  issuer: z.url(),
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
  subject: z.string().min(1),
});
export const neonAuthorizationConfigurationSchema = z
  .strictObject({
    builderCallbackOrigin: httpsOrigin,
    builderWorkload: identity,
    operatorWorkload: identity
      .omit({ subject: true })
      .extend({ environment: z.literal("preview") }),
  })
  .refine(
    (value) =>
      value.builderWorkload.ownerId === value.operatorWorkload.ownerId &&
      value.builderWorkload.projectId !== value.operatorWorkload.projectId,
  );
export type NeonAuthorizationConfiguration = z.infer<typeof neonAuthorizationConfigurationSchema>;
export const neonAuthorizationInputSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.enum(["check", "complete"]) }),
  z.strictObject({ callbackUrl: z.url(), phase: z.literal("start") }),
]);
export const neonAuthorizationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ expiresAt: z.number().positive(), status: z.literal("ready") }),
  z.strictObject({ status: z.literal("authorization-required") }),
  z.strictObject({
    challenge: z.strictObject({
      displayName: z.literal("Connect Neon"),
      expiresAt: z.iso.datetime({ offset: true }).optional(),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return url.origin === "https://vercel.com" && !url.username && !url.password;
      }),
      userCode: z.string().optional(),
    }),
    status: z.literal("authorization-started"),
  }),
]);
export type NeonAuthorizationInput = z.infer<typeof neonAuthorizationInputSchema>;
export type NeonAuthorizationResult = z.infer<typeof neonAuthorizationResultSchema>;

/** Consent setup is independent of app releases, database branches and Sandbox images. */
export const readNeonAuthorizationConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const configuration = neonAuthorizationConfigurationSchema.parse(
    JSON.parse(environment.PROTECTED_HOSTED_OPERATOR_AUTHORIZATION_CONFIGURATION ?? "null"),
  );
  createOperatorWorkloadVerifier(configuration.builderWorkload);
  return configuration;
};

/** Provider state owns PKCE and consent. Only the public challenge crosses the operator boundary. */
export interface HostedOperatorNeonAuthorizationIo {
  getOidc: typeof getVercelOidcToken;
  verifyOidc: (
    token: string,
    options: Parameters<typeof verifyVercelOidcToken>[1],
  ) => Promise<void>;
  getTokenResponse: typeof getTokenResponse;
  startAuthorization: typeof startAuthorization;
}

const defaultIo: HostedOperatorNeonAuthorizationIo = {
  getOidc: getVercelOidcToken,
  getTokenResponse,
  startAuthorization,
  verifyOidc: async (token, options) => {
    await verifyVercelOidcToken(token, options);
  },
};

export const createHostedOperatorNeonAuthorization =
  (
    input: {
      configuration: NeonAuthorizationConfiguration;
      diagnosticSink?: HostedOperatorConsentDiagnosticSink;
      assertCurrentOwner: (context: HostedOperatorConsentOwner) => Promise<void>;
    },
    io: HostedOperatorNeonAuthorizationIo = defaultIo,
  ) =>
  async (
    context: HostedOperatorConsentOwner,
    request: NeonAuthorizationInput,
  ): Promise<NeonAuthorizationResult> => {
    const report = createHostedOperatorConsentDiagnostic(
      context.ownerContext.sessionId,
      input.diagnosticSink,
    );
    let stage: HostedOperatorConsentMetadata["stage"] = "configuration";
    const emit = (outcome: HostedOperatorConsentMetadata["outcome"]) => {
      report({ boundary: "operator", outcome, phase: request.phase, stage });
    };
    const begin = (next: HostedOperatorConsentMetadata["stage"]) => {
      stage = next;
      emit("started");
    };
    try {
      begin("configuration");
      const configuration = neonAuthorizationConfigurationSchema.parse(input.configuration);
      const parsed = neonAuthorizationInputSchema.parse(request);
      const current = structuredClone(context);
      emit("verified");
      const assertCurrent = async () => {
        begin("current_owner");
        await input.assertCurrentOwner(current);
        emit("verified");
      };
      await assertCurrent();
      begin("operator_oidc");
      const token = await io.getOidc();
      await io.verifyOidc(token, configuration.operatorWorkload);
      emit("verified");
      await assertCurrent();
      const params = {
        resources: ["https://mcp.neon.tech/mcp"],
        scopes: ["read", "write"],
        subject: {
          id: current.authority.ownerUserId,
          issuer: current.authority.issuer,
          type: "user" as const,
        },
      };
      if (parsed.phase === "start") {
        begin("callback");
        const callback = new URL(parsed.callbackUrl);
        if (
          callback.origin !== configuration.builderCallbackOrigin ||
          callback.username ||
          callback.password ||
          callback.hash
        ) {
          throw new HostedOperatorError("authorization_required");
        }
        emit("verified");
        begin("provider_start");
        const response = await io.startAuthorization(connector, params, {
          callbackUrl: callback.href,
          deviceCode: true,
          vercelToken: token,
          webhook: callback.href,
        });
        await assertCurrent();
        stage = "provider_start";
        const challenge: Extract<
          NeonAuthorizationResult,
          { status: "authorization-started" }
        >["challenge"] = { displayName: "Connect Neon", url: response.url };
        if (response.deviceCode !== undefined) {
          challenge.userCode = response.deviceCode;
        }
        if (response.expiresAt !== undefined) {
          challenge.expiresAt = new Date(response.expiresAt).toISOString();
        }
        const result = neonAuthorizationResultSchema.parse({
          challenge,
          status: "authorization-started",
        });
        emit("challenge_started");
        return result;
      }
      try {
        begin("provider_token");
        const response = await io.getTokenResponse(connector, params, {
          forceRefresh: true,
          vercelToken: token,
        });
        await assertCurrent();
        stage = "provider_token";
        // The provider bearer is deliberately discarded, not persisted or forwarded to Builder/Eve.
        const result = neonAuthorizationResultSchema.parse({
          expiresAt: response.expiresAt,
          status: "ready",
        });
        emit("ready");
        return result;
      } catch (error) {
        await assertCurrent();
        stage = "provider_token";
        if (error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError) {
          emit("consent_required");
          return { status: "authorization-required" };
        }
        throw new HostedOperatorError("operator_unavailable");
      }
    } catch (error) {
      emit(
        error instanceof HostedOperatorError && error.code === "authorization_required"
          ? "operator_access_denied"
          : "setup_unavailable",
      );
      throw error;
    }
  };
