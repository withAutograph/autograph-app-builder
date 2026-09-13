import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { ARRUSTED_TEMPLATE_REPOSITORY } from "../../lib/repository/source-receipt";

const execute = promisify(execFile);
type Git = (args: string[], cwd?: string) => Promise<string>;
const git: Git = async (args, cwd) => {
  const result = await execute("git", args, { cwd, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
};

export interface TemplateSourceEvidence {
  sourcePath: string;
  acquisition: "provided-checkout" | "canonical-clone";
  revision: string;
  remote: string | null;
}

/** Acquires source once; explicit checkouts are inspected without fetching or changing them. */
export async function prepareSelfReproductionTemplateSource(input: {
  outputDirectory: string;
  providedCheckout?: string;
  /** Injectable structured process boundary for focused transport tests. */
  runGit?: Git;
}): Promise<TemplateSourceEvidence> {
  const run = input.runGit ?? git;
  const sourcePath = input.providedCheckout
    ? resolve(input.providedCheckout)
    : resolve(input.outputDirectory, "runtime-source", "arrusted-development");
  const acquisition = input.providedCheckout ? "provided-checkout" : "canonical-clone";
  if (!input.providedCheckout) {
    await mkdir(resolve(input.outputDirectory, "runtime-source"), { recursive: true });
    // Git's configured credential helper supplies access; no credentials enter arguments.
    await run([
      "clone",
      "--branch",
      "main",
      "--single-branch",
      ARRUSTED_TEMPLATE_REPOSITORY,
      sourcePath,
    ]);
  }
  const revision = await run(["rev-parse", "HEAD"], sourcePath);
  let remote: string | null = null;
  try {
    const value = await run(["remote", "get-url", "origin"], sourcePath);
    // Never retain HTTP credentials from a user-provided checkout's remote URL.
    remote = value.replaceAll(/(?<scheme>https?:\/\/)[^/@]+@/gu, "$<scheme>");
  } catch {
    // Local source checkouts need not have an origin remote.
  }
  return { sourcePath, acquisition, revision, remote };
}
