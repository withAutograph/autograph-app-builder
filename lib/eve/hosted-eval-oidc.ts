import { verifyVercelOidcToken } from "@vercel/oidc";
import { createVercelWorkloadIdentity } from "./vercel-workload-identity";
import { verifyHostedEvalIdentity } from "./hosted-eval-oidc-verification.mjs";

/** Hosted invocation identity only; never falls back to local files or static keys. */
export const acquireHostedEvalOidc = async (
  scope: { projectId: string; teamId: string; environment: string },
  dependencies: {
    getToken?: () => Promise<string>;
    verify?: typeof verifyVercelOidcToken;
  } = {},
) => {
  if ([scope.projectId, scope.teamId, scope.environment].some((value) => !value || value === "*"))
    throw new Error("Hosted eval requires an explicit project, team, and environment.");
  try {
    // Acquire on every call so a later invocation can obtain refreshed identity.
    const token = await createVercelWorkloadIdentity({ getToken: dependencies.getToken }).token();
    return await verifyHostedEvalIdentity(
      token,
      scope,
      dependencies.verify ?? verifyVercelOidcToken,
    );
  } catch {
    // SDK exceptions may include token/provider detail; never propagate credential material.
    throw new Error("Hosted eval project workload identity could not be acquired or verified.");
  }
};
