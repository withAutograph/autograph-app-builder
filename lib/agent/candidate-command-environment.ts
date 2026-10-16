import type { SandboxSession } from "eve/sandbox";

const applicationDependencyEnvironment = (environment: Record<string, string>) => {
  const selected = (environment.MISE_ENV ?? "")
    .split(",")
    .filter((name) => name !== "" && name !== "app-validation");
  return { ...environment, MISE_ENV: [...selected, "app-validation"].join(",") };
};

/** Add the app validation Mise profile to candidate commands while retaining the session. */
export const withCandidateCommandEnvironment = <
  Session extends Pick<SandboxSession, "run" | "spawn">,
>(
  sandbox: Session,
) => ({
  ...sandbox,
  run(options: Parameters<SandboxSession["run"]>[0]) {
    return sandbox.run({
      ...options,
      env: applicationDependencyEnvironment(options.env ?? {}),
    });
  },
  spawn(options: Parameters<SandboxSession["spawn"]>[0]) {
    return sandbox.spawn({
      ...options,
      env: applicationDependencyEnvironment(options.env ?? {}),
    });
  },
});
