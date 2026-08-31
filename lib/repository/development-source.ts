import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { isHostedVercelRuntime } from "../sandbox/backend";
import { inspectSourceReceipt, type SourceReceipt } from "./source-receipt";

const gitObjectPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

type Environment = Readonly<Record<string, string | undefined>>;

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
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error("Development source root was not owner-bound.");
  return path;
}

/**
 * Selects the transient source snapshot only for the exact `mise run dev`
 * authority. Hosted execution deliberately falls through to its fixed remote
 * or release reader and can never consume this host path.
 */
export async function developmentFreshTemplateSourceReceipt(
  environment: Environment = process.env,
): Promise<SourceReceipt | undefined> {
  if (isHostedVercelRuntime(environment)) return undefined;
  if (environment.APP_BUILDER_EXECUTION_MODE !== "development")
    return undefined;
  if (
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development" ||
    environment.APP_BUILDER_SANDBOX_PROVIDER !== "vercel" ||
    environment.APP_BUILDER_LOCAL_ADAPTER !== "1" ||
    environment.APP_BUILDER_LOCAL_PUBLICATION !== "0" ||
    environment.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION !== "0" ||
    environment.APP_BUILDER_GITHUB_PUBLICATION_ENABLED !== "0" ||
    environment.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED !== "0" ||
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION !== "0" ||
    environment.APP_BUILDER_LOCAL_AUTH_EMULATION !== "0" ||
    environment.APP_BUILDER_HOSTED_ARTIFACT_PROOF !== "0" ||
    environment.EVE_HOSTED_ADAPTER !== "0" ||
    environment.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS !== "0"
  )
    throw new Error("Development source binding was not closed.");

  const sourceRoot = exactDevelopmentSourceRoot(
    required(environment, "REPOSITORY_LOCAL_ROOTS"),
  );
  const expectedSha = required(
    environment,
    "APP_BUILDER_DEVELOPMENT_SOURCE_SHA",
  );
  const expectedTree = required(
    environment,
    "APP_BUILDER_DEVELOPMENT_SOURCE_TREE",
  );
  const fingerprint = required(
    environment,
    "APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT",
  );
  if (
    !gitObjectPattern.test(expectedSha) ||
    !gitObjectPattern.test(expectedTree) ||
    !sha256Pattern.test(fingerprint)
  )
    throw new Error("Development source identity was invalid.");

  const receipt = await inspectSourceReceipt("fresh-template", sourceRoot);
  if (
    receipt.sourcePath !== sourceRoot ||
    receipt.sourceSha !== expectedSha ||
    receipt.sourceTree !== expectedTree
  )
    throw new Error("Development source snapshot drifted.");
  return receipt;
}
