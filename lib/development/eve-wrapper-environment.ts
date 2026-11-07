import path from "node:path";
import { observePrivateComputeLimits } from "./private-compute-limits";

/** The supervisor alone reads CLI credentials; the wrapper receives public facts and owned paths. */
export const prepareDevelopmentEveWrapperEnvironment = async (input: {
  cycleFile: string;
  closed: Readonly<Record<string, string>>;
  applicationRoot: string;
  runsRoot: string;
  supervisorRoot: string;
  runtimeHome: string;
  workflowData: string;
  repositoryRoot: string;
  nodeExecutable: string;
  vercelExecutable: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<NodeJS.ProcessEnv> => {
  input.signal.throwIfAborted();
  // A failed read leaves the default footprint available. Selecting another
  // footprint still requires a later verified observation and normal approval.
  let limits: Awaited<ReturnType<typeof observePrivateComputeLimits>> | undefined;
  try {
    limits = await observePrivateComputeLimits({
      environment: input.environment,
      repositoryRoot: input.repositoryRoot,
      signal: input.signal,
      vercelExecutable: input.vercelExecutable,
    });
  } catch {
    // The unselected default footprint needs no resource-change observation.
  }
  input.signal.throwIfAborted();
  const environment: NodeJS.ProcessEnv = {
    HOME: input.runtimeHome,
    LANG: input.environment.LANG ?? "C",
    LC_ALL: input.environment.LC_ALL ?? "C",
    NODE_ENV: "production",
    PATH: `${path.dirname(input.nodeExecutable)}:/usr/bin:/bin`,
    TMPDIR: input.environment.TMPDIR ?? "/tmp",
    TZ: input.environment.TZ ?? "UTC",
    ...input.closed,
  };
  if (limits !== undefined) {
    environment.APP_BUILDER_PRIVATE_COMPUTE_LIMITS = JSON.stringify(limits);
  }
  return {
    ...environment,
    APP_BUILDER_DEV_EVE_ROOT: input.applicationRoot,
    APP_BUILDER_DEV_RUNS_ROOT: input.runsRoot,
    APP_BUILDER_DEV_RUNTIME_HOME: input.runtimeHome,
    APP_BUILDER_DEV_SUPERVISOR_ROOT: input.supervisorRoot,
    APP_BUILDER_EVE_PORT: new URL(input.closed.EVE_AGENT_HOST).port,
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: input.cycleFile,
    // Keep workflow redelivery on the same explicit loopback Eve endpoint.
    WORKFLOW_LOCAL_BASE_URL: input.closed.EVE_AGENT_HOST,
    WORKFLOW_LOCAL_DATA_DIR: input.workflowData,
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
  };
};
