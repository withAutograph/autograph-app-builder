import { readFile } from "node:fs/promises";
import { acquireHostedEvalOidc } from "../eve/hosted-eval-oidc";

/** The controller owns this file outside source and report directories. */
export const syncHostedEvalIdentity = async (
  environment: NodeJS.ProcessEnv = process.env,
  acquire = acquireHostedEvalOidc,
) => {
  const identityFile = environment.SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE;
  const identity = await acquire(
    {
      environment: environment.VERCEL_TARGET_ENV || environment.VERCEL_ENV || "",
      projectId: environment.VERCEL_PROJECT_ID ?? "",
      teamId: environment.VERCEL_TEAM_ID ?? "",
    },
    identityFile
      ? {
          getToken: async () => {
            const record: unknown = JSON.parse(await readFile(identityFile, "utf-8"));
            if (
              !record ||
              typeof record !== "object" ||
              !("token" in record) ||
              typeof record.token !== "string"
            )
              throw new Error("Hosted workload identity file is unavailable.");
            return record.token;
          },
        }
      : {},
  );
  // Update only after issuer, project, owner, environment and time verification.
  environment.VERCEL_OIDC_TOKEN = identity.token;
  return identity;
};
