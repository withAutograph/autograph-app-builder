import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { isHostedVercelRuntime } from "../sandbox/backend";
import {
  inspectSourceReceipt,
  type SourceKind,
  type SourceReceipt,
} from "./source-receipt";

type Environment = Readonly<Record<string, string | undefined>>;

const closedDevelopmentBinding = (environment: Environment) =>
  environment.APP_BUILDER_EXECUTION_MODE === "development" &&
  environment.APP_BUILDER_EXECUTION_BUNDLE === "local-development" &&
  environment.APP_BUILDER_SANDBOX_PROVIDER === "vercel" &&
  environment.APP_BUILDER_LOCAL_ADAPTER === "1" &&
  environment.APP_BUILDER_LOCAL_PUBLICATION === "0" &&
  environment.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION === "0" &&
  environment.APP_BUILDER_GITHUB_PUBLICATION_ENABLED === "0" &&
  environment.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED === "0" &&
  environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION === "0" &&
  environment.APP_BUILDER_LOCAL_AUTH_EMULATION === "0" &&
  environment.APP_BUILDER_HOSTED_ARTIFACT_PROOF === "0" &&
  environment.EVE_HOSTED_ADAPTER === "0" &&
  environment.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS === "0";

export function canAutoSelectDevelopmentSource(
  environment: Environment = process.env,
) {
  return (
    !isHostedVercelRuntime(environment) && closedDevelopmentBinding(environment)
  );
}

function required(environment: Environment, name: string) {
  const value = environment[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Development source ${name} binding was unavailable.`);
  return value;
}

function exactDevelopmentSourceRoot(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync(path) !== path
  )
    throw new Error("Development source root was not canonical.");
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Development source root was not a directory.");
  return path;
}

/**
 * Selects the single transient source snapshot only for the exact `mise run
 * dev` authority. Hosted execution and non-development explicit paths
 * deliberately fall through to their existing readers.
 */
export async function developmentSourceReceipt(
  sourceKind: SourceKind,
  suppliedPath?: string,
  environment: Environment = process.env,
): Promise<SourceReceipt | undefined> {
  if (isHostedVercelRuntime(environment)) return undefined;
  if (environment.APP_BUILDER_EXECUTION_MODE !== "development")
    return undefined;
  if (!closedDevelopmentBinding(environment))
    throw new Error("Development source binding was not closed.");

  const sourceRoot = exactDevelopmentSourceRoot(
    required(environment, "REPOSITORY_LOCAL_ROOTS"),
  );
  if (suppliedPath !== undefined && suppliedPath !== sourceRoot)
    throw new Error(
      "Development source path did not match the selected snapshot.",
    );
  // Development deliberately re-observes a live checkout.  Source edits are
  // normal planning input, not authority failures; the sandbox materializer
  // computes the current working-tree generation when it synchronizes bytes.
  return await inspectSourceReceipt(sourceKind, sourceRoot);
}
