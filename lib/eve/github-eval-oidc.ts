import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

const issuer = "https://token.actions.githubusercontent.com";
const githubKeys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));

export interface AuthorizedEvalRun {
  repositoryId: string;
  workflowRef: string;
  ref: string;
  runId: string;
  runAttempt: string;
}

/** Construct from deployment-owned configuration, never request body scope. */
export const createGitHubEvalAuthorizer = (
  policy: { audience: string; repositoryId: string; workflowRef: string; ref: string },
  dependencies: { keys?: JWTVerifyGetKey } = {},
) => {
  if (
    !policy.audience ||
    !/^[1-9][0-9]*$/u.test(policy.repositoryId) ||
    !policy.ref.startsWith("refs/heads/") ||
    !policy.workflowRef.endsWith(`@${policy.ref}`)
  )
    throw new Error("GitHub eval authorization requires an explicit deployment-owned policy.");
  return async (
    token: string,
    /** Existing persisted run identity for status/artifact access, never replacement policy. */
    expectedRun?: { runId: string; runAttempt: string },
  ): Promise<AuthorizedEvalRun> => {
    try {
      const { payload } = await jwtVerify(token, dependencies.keys ?? githubKeys, {
        algorithms: ["RS256"],
        audience: policy.audience,
        issuer,
        requiredClaims: [
          "exp",
          "iat",
          "nbf",
          "repository_id",
          "workflow_ref",
          "ref",
          "run_id",
          "run_attempt",
          "event_name",
        ],
      });
      if (
        payload.repository_id !== policy.repositoryId ||
        payload.workflow_ref !== policy.workflowRef ||
        payload.ref !== policy.ref ||
        payload.event_name !== "workflow_dispatch" ||
        payload.ref_type !== "branch" ||
        Boolean(payload.head_ref) ||
        Boolean(payload.base_ref) ||
        typeof payload.run_id !== "string" ||
        !/^[1-9][0-9]*$/u.test(payload.run_id) ||
        typeof payload.run_attempt !== "string" ||
        !/^[1-9][0-9]*$/u.test(payload.run_attempt) ||
        (expectedRun &&
          (payload.run_id !== expectedRun.runId || payload.run_attempt !== expectedRun.runAttempt))
      )
        throw new Error("Untrusted workflow identity.");
      return {
        ref: policy.ref,
        repositoryId: policy.repositoryId,
        runAttempt: payload.run_attempt,
        runId: payload.run_id,
        workflowRef: policy.workflowRef,
      };
    } catch {
      throw new Error("GitHub eval workflow identity could not be authorized.");
    }
  };
};
