import { readFile } from "node:fs/promises";
import { verifyHostedEvalIdentity } from "../lib/eve/hosted-eval-oidc-verification.mjs";

/** @param {NodeJS.ProcessEnv} environment Fixed worker environment. */
export const refreshWorkerIdentity = async (
  environment = process.env,
  verify = verifyHostedEvalIdentity,
) => {
  const file = environment.SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE;
  if (!file) return;
  const record = JSON.parse(await readFile(file, "utf-8"));
  const identity = await verify(record.token, {
    environment: environment.VERCEL_TARGET_ENV || environment.VERCEL_ENV || "",
    projectId: environment.VERCEL_PROJECT_ID ?? "",
    teamId: environment.VERCEL_TEAM_ID ?? "",
  });
  environment.VERCEL_OIDC_TOKEN = identity.token;
};

if (process.env.SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE) {
  await refreshWorkerIdentity();
  let pending = false;
  const tick = async () => {
    if (pending) return;
    pending = true;
    try {
      await refreshWorkerIdentity();
    } catch {
      // Keep the previous verified identity; providers still enforce its expiry.
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 1000);
  timer.unref();
}
