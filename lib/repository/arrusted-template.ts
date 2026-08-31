import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  ARRUSTED_TEMPLATE_REF,
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectClonedTemplateSourceReceipt,
  type SourceReceipt,
} from "./source-receipt";

const execFileAsync = promisify(execFile);
const git = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
const SHA = /^[0-9a-f]{40}$/u;
const TEMPLATE_READINESS_CHECK = "Template readiness";

export { ARRUSTED_TEMPLATE_REF, ARRUSTED_TEMPLATE_REPOSITORY };

export type ArrustedTemplateClone = {
  receipt: SourceReceipt;
  dispose(): Promise<void>;
};

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
  };
}

async function command(args: readonly string[], cwd?: string) {
  return execFileAsync(
    git,
    [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    { cwd, env: environment(), encoding: "utf8", timeout: 60_000 },
  );
}

function receiptReadinessDigest(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function templateReadinessAttestationDigest(
  sha: string,
  tree: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/withAutograph/arrusted-development/commits/${sha}/check-runs?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Autograph-App-Builder",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error("Template-readiness evidence is unavailable.");
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { check_runs?: unknown }).check_runs)
  )
    throw new Error("Template-readiness evidence is invalid.");
  const checks = (body as { check_runs: unknown[] }).check_runs;
  const readiness = checks
    .filter(
      (check): check is Record<string, unknown> =>
        typeof check === "object" &&
        check !== null &&
        !Array.isArray(check) &&
        (check as Record<string, unknown>)["name"] === TEMPLATE_READINESS_CHECK,
    )
    .toSorted((left, right) =>
      String(right.started_at ?? "").localeCompare(
        String(left.started_at ?? ""),
      ),
    )[0];
  if (
    readiness === undefined ||
    readiness.status !== "completed" ||
    readiness.conclusion !== "success" ||
    typeof readiness.id !== "number" ||
    !Number.isSafeInteger(readiness.id) ||
    typeof readiness.completed_at !== "string"
  )
    throw new Error(
      "The resolved Arrusted commit has no successful template-readiness evidence.",
    );
  return receiptReadinessDigest({
    version: 1,
    repository: ARRUSTED_TEMPLATE_REPOSITORY,
    ref: ARRUSTED_TEMPLATE_REF,
    sha,
    tree,
    check: {
      id: readiness.id,
      name: TEMPLATE_READINESS_CHECK,
      completedAt: readiness.completed_at,
      conclusion: readiness.conclusion,
    },
  });
}

/**
 * The only runtime template transport. The remote and ref are constants rather
 * than tool input, and the returned checkout has no credentials or inherited
 * host Git configuration.
 */
export async function cloneArrustedTemplate(
  root = join(tmpdir(), "autograph-app-builder-template"),
): Promise<ArrustedTemplateClone> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = await realpath(resolve(root));
  const checkout = await mkdtemp(join(parent, "clone-"));
  try {
    await command([
      "clone",
      "--no-checkout",
      "--no-recurse-submodules",
      "--single-branch",
      "--branch",
      "main",
      ARRUSTED_TEMPLATE_REPOSITORY,
      checkout,
    ]);
    const origin = (
      await command(["-C", checkout, "config", "--get", "remote.origin.url"])
    ).stdout.trim();
    if (origin !== ARRUSTED_TEMPLATE_REPOSITORY)
      throw new Error("Canonical Arrusted template origin drifted.");
    await command([
      "-C",
      checkout,
      "fetch",
      "--no-tags",
      "origin",
      ARRUSTED_TEMPLATE_REF,
    ]);
    const sha = (
      await command(["-C", checkout, "rev-parse", "FETCH_HEAD"])
    ).stdout.trim();
    if (!SHA.test(sha))
      throw new Error("Canonical Arrusted template ref is invalid.");
    await command(["-C", checkout, "checkout", "--detach", "--quiet", sha]);
    const tree = (
      await command(["-C", checkout, "rev-parse", `${sha}^{tree}`])
    ).stdout.trim();
    if (!SHA.test(tree))
      throw new Error("Canonical Arrusted template tree is invalid.");
    if (
      (await command(["-C", checkout, "status", "--porcelain=v1"])).stdout !==
      ""
    )
      throw new Error("Canonical Arrusted template clone is not clean.");
    if (existsSync(join(checkout, ".gitmodules")))
      throw new Error("Canonical Arrusted template contains submodules.");
    const readinessDigest = await templateReadinessAttestationDigest(sha, tree);
    const receipt = await inspectClonedTemplateSourceReceipt({
      path: checkout,
      readinessDigest,
    });
    if (receipt.sourceSha !== sha || receipt.sourceTree !== tree)
      throw new Error("Canonical Arrusted template receipt drifted.");
    return {
      receipt,
      dispose: () => rm(checkout, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(checkout, { recursive: true, force: true });
    throw error;
  }
}
