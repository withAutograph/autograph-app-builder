import { getContext, verifyVercelOidcToken } from "@vercel/oidc";
import type { VercelOidcPayload } from "@vercel/oidc";
import {
  createHostedOperatorConsentDiagnostic,
  operatorCallerWorkloadSchema,
} from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  HostedOperatorConsentMetadata,
  OperatorCallerWorkload,
} from "./hosted-operator-consent-diagnostic";

type VerifyToken = (
  token: string,
  options: Parameters<typeof verifyVercelOidcToken>[1],
) => Promise<{ payload: Pick<VercelOidcPayload, "environment" | "owner_id" | "project_id"> }>;

export interface OperatorCallerWorkloadDependencies {
  getContext?: typeof getContext;
  verifyToken?: VerifyToken;
}
interface CallerInput {
  dependencies?: OperatorCallerWorkloadDependencies;
  environment?: Readonly<Record<string, string | undefined>>;
  httpStatus: number;
  phase: HostedOperatorConsentMetadata["phase"];
  sessionId: string;
  sink?: HostedOperatorConsentDiagnosticSink;
  token: string;
}
const tokenSource = (
  input: CallerInput,
  environment: Readonly<Record<string, string | undefined>>,
): OperatorCallerWorkload["source"] => {
  try {
    if (
      (input.dependencies?.getContext ?? getContext)().headers?.["x-vercel-oidc-token"] ===
      input.token
    ) {
      return "request_context";
    }
    return environment.VERCEL_OIDC_TOKEN === input.token ? "environment" : "unknown";
  } catch {
    return "unknown";
  }
};
const verifiedProjection = (
  payload: Pick<VercelOidcPayload, "environment" | "owner_id" | "project_id">,
  projectId: string,
  ownerId: string | undefined,
  runtimeEnvironment: OperatorCallerWorkload["runtimeEnvironment"],
): Partial<OperatorCallerWorkload> => {
  const result: Partial<OperatorCallerWorkload> = {
    projectMatches: payload.project_id === projectId,
    signatureVerified: true,
    verification: "verified",
  };
  const tokenEnvironment = operatorCallerWorkloadSchema.shape.tokenEnvironment.safeParse(
    payload.environment,
  );
  if (tokenEnvironment.success && tokenEnvironment.data !== undefined) {
    result.tokenEnvironment = tokenEnvironment.data;
  }
  if (ownerId !== undefined && ownerId !== "") {
    result.teamMatches = payload.owner_id === ownerId;
  }
  if (runtimeEnvironment !== undefined && result.tokenEnvironment !== undefined) {
    result.environmentMatches = runtimeEnvironment === result.tokenEnvironment;
  }
  return result;
};
const verifyCaller = async (
  input: CallerInput,
  environment: Readonly<Record<string, string | undefined>>,
  observed: OperatorCallerWorkload,
): Promise<OperatorCallerWorkload> => {
  const projectId = environment.VERCEL_PROJECT_ID;
  if (projectId === undefined || projectId === "") {
    return observed;
  }
  try {
    const options: Parameters<typeof verifyVercelOidcToken>[1] = {
      // Environments are accepted only for observation; neither sending nor authorization uses this result.
      environment: ["development", "preview", "production"],
      projectId,
    };
    const ownerId = environment.VERCEL_ORG_ID;
    if (ownerId !== undefined && ownerId !== "") {
      options.ownerId = ownerId;
    }
    const result = await (input.dependencies?.verifyToken ?? verifyVercelOidcToken)(
      input.token,
      options,
    );
    return {
      ...observed,
      ...verifiedProjection(result.payload, projectId, ownerId, observed.runtimeEnvironment),
    };
  } catch {
    return { ...observed, verification: "failed" };
  }
};
/** Observe only the exact token already sent after an upstream denial. This never authorizes a request. */
export const reportHostedOperatorCallerWorkload = async (input: CallerInput): Promise<void> => {
  try {
    const environment = input.environment ?? process.env;
    const observed: OperatorCallerWorkload = {
      source: tokenSource(input, environment),
      verification: "unavailable",
    };
    const targetEnvironment = environment.VERCEL_TARGET_ENV;
    const preferredEnvironment =
      targetEnvironment !== undefined && targetEnvironment !== ""
        ? targetEnvironment
        : environment.VERCEL_ENV;
    const runtimeEnvironment =
      operatorCallerWorkloadSchema.shape.runtimeEnvironment.safeParse(preferredEnvironment);
    if (runtimeEnvironment.success && runtimeEnvironment.data !== undefined) {
      observed.runtimeEnvironment = runtimeEnvironment.data;
    }
    createHostedOperatorConsentDiagnostic(
      input.sessionId,
      input.sink,
    )({
      boundary: "builder",
      callerWorkload: await verifyCaller(input, environment, observed),
      httpStatus: input.httpStatus,
      outcome: "operator_access_denied",
      phase: input.phase,
      stage: "caller_workload",
    });
  } catch {
    /* No diagnostic failure can replace the original upstream authorization denial. */
  }
};
