import { developmentExecutionEnvironment } from "../development/execution-environment.mjs";
import { lstatSync, realpathSync } from "node:fs";
import nodePath from "node:path";

import { isHostedVercelRuntime } from "../sandbox/backend";
import { inspectSourceReceipt } from "./source-receipt";
import type { SourceKind, SourceReceipt } from "./source-receipt";

type Environment = Readonly<Record<string, string | undefined>>;

const closedDevelopmentBinding = (environment: Environment) =>
  Object.entries(developmentExecutionEnvironment).every(
    ([name, value]) => environment[name] === value,
  );

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function canAutoSelectDevelopmentSource(environment: Environment = process.env) {
  return !isHostedVercelRuntime(environment) && closedDevelopmentBinding(environment);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function required(environment: Environment, name: string) {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Development source ${name} binding was unavailable.`);
  }
  return value;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function exactDevelopmentSourceRoot(path: string) {
  if (
    !nodePath.isAbsolute(path) ||
    nodePath.resolve(path) !== path ||
    realpathSync(path) !== path
  ) {
    throw new Error("Development source root was not canonical.");
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Development source root was not a directory.");
  }
  return path;
}

/**
 * Selects the single transient source snapshot only for the exact `mise run
 * dev` authority. Hosted execution and non-development explicit paths
 * deliberately fall through to their existing readers.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function developmentSourceReceipt(
  sourceKind: SourceKind,
  suppliedPath?: string,
  environment: Environment = process.env,
): Promise<SourceReceipt | undefined> {
  if (isHostedVercelRuntime(environment)) {
    return undefined;
  }
  if (environment.APP_BUILDER_EXECUTION_MODE !== "development") {
    return undefined;
  }
  if (!closedDevelopmentBinding(environment)) {
    throw new Error("Development source binding was not closed.");
  }

  const sourceRoot = exactDevelopmentSourceRoot(required(environment, "REPOSITORY_LOCAL_ROOTS"));
  if (suppliedPath !== undefined && suppliedPath !== sourceRoot) {
    throw new Error("Development source path did not match the selected snapshot.");
  }
  // Development deliberately re-observes a live checkout.  Source edits are
  // normal planning input, not authority failures; the sandbox materializer
  // computes the current working-tree generation when it synchronizes bytes.
  return await inspectSourceReceipt(sourceKind, sourceRoot);
}
