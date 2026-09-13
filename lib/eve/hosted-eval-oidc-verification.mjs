import { verifyVercelOidcToken } from "@vercel/oidc";

/**
 * @param {string} token Identity to verify.
 * @param {{projectId:string,teamId:string,environment:string}} scope Deployment-owned scope.
 * @param {typeof verifyVercelOidcToken} verify Official signature and claim verifier.
 */
export const verifyHostedEvalIdentity = async (token, scope, verify = verifyVercelOidcToken) => {
  try {
    if ([scope.projectId, scope.teamId, scope.environment].some((value) => !value || value === "*"))
      throw new Error("Missing workload scope");
    const verified = await verify(token, {
      environment: scope.environment,
      ownerId: scope.teamId,
      projectId: scope.projectId,
      requiredClaims: ["exp", "iat", "nbf"],
    });
    return {
      expiresAt: verified.payload.exp,
      projectId: scope.projectId,
      teamId: scope.teamId,
      token,
    };
  } catch {
    throw new Error("Hosted eval project workload identity could not be acquired or verified.");
  }
};
