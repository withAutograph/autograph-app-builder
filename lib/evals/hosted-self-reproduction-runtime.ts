import type { Sql } from "postgres";
import { createGitHubEvalAuthorizer } from "../eve/github-eval-oidc";
import type { HostedEvalHttpRuntime } from "./hosted-self-reproduction-http";

const databases = new Map<string, Sql>();

/** All authority is deployment-owned; removing the audience disables the endpoint. */
export const hostedSelfReproductionRuntime = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HostedEvalHttpRuntime | undefined => {
  const audience = environment.SELF_REPRODUCTION_GITHUB_AUDIENCE;
  const projectId = environment.VERCEL_PROJECT_ID;
  const teamId = environment.VERCEL_TEAM_ID;
  const targetEnvironment = environment.VERCEL_TARGET_ENV || environment.VERCEL_ENV;
  const databaseUrl = environment.DATABASE_URL;
  const builderRevision = environment.VERCEL_GIT_COMMIT_SHA;
  if (!audience || !projectId || !teamId || !targetEnvironment || !databaseUrl || !builderRevision)
    return;
  const authorize = createGitHubEvalAuthorizer({
    audience,
    ref: "refs/heads/main",
    repositoryId: "1341836922",
    workflowRef:
      "withAutograph/autograph-app-builder/.github/workflows/self-reproduction.yml@refs/heads/main",
  });
  return {
    authorize,
    async controller() {
      // Called only after HTTP authorization; no database, template credential, or Sandbox access before it.
      const [
        { default: postgres },
        { createPostgresHostedEvalStorage },
        { createHostedEvalSandboxWorker },
        { deploymentArrustedTemplateReader },
        { createHostedSelfReproductionController },
      ] = await Promise.all([
        import("postgres"),
        import("./postgres-hosted-self-reproduction"),
        import("./hosted-self-reproduction-sandbox-worker"),
        import("../repository/arrusted-template-reader"),
        import("./hosted-self-reproduction-controller"),
      ]);
      let database = databases.get(databaseUrl);
      if (!database) {
        database = postgres(databaseUrl);
        databases.set(databaseUrl, database);
      }
      const storage = createPostgresHostedEvalStorage(database);
      return createHostedSelfReproductionController({
        ...storage,
        authorize,
        collectionLeaseMs: 5 * 60_000,
        now: Date.now,
        worker: createHostedEvalSandboxWorker({
          builderRevision,
          scope: { environment: targetEnvironment, projectId, teamId },
          templateReader: deploymentArrustedTemplateReader(environment),
        }),
        workerLifetimeMs: 45 * 60_000,
      });
    },
  };
};
