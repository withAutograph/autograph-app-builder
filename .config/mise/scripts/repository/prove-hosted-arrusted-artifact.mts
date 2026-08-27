import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { extract } from "tar";

import { BUILD_READY_APP_SPEC } from "../../../../evals/support/app-spec.ts";
import {
  HOSTED_ARTIFACT_PATH,
  HOSTED_ARTIFACT_SHA256,
} from "../../../../lib/sandbox/hosted-artifact.ts";

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--mise-bin")
  throw new Error(
    "Usage: prove-hosted-arrusted-artifact.mts --mise-bin <path>",
  );
const miseBin = args[1];
if (!isAbsolute(miseBin) || basename(miseBin) !== "mise")
  throw new Error("The mise executable must use an absolute canonical path.");
const miseStat = statSync(miseBin);
if (
  realpathSync(miseBin) !== miseBin ||
  !miseStat.isFile() ||
  (miseStat.mode & 0o022) !== 0
)
  throw new Error("The mise executable is not an immutable regular file.");
const root = mkdtempSync(join(tmpdir(), "hosted-arrusted-proof."));
try {
  extract({ cwd: root, file: HOSTED_ARTIFACT_PATH, sync: true });
  const seed = join(root, ".app-builder-hosted-seed");
  const repository = join(root, "repository");
  mkdirSync(repository);
  extract({
    cwd: repository,
    file: join(seed, "source-tree.tar.gz"),
    sync: true,
  });
  extract({
    cwd: repository,
    file: join(seed, "dependency-cache", "node-modules.tar.gz"),
    sync: true,
  });
  const appSpecPath = join(
    repository,
    "prototype",
    "builder-proof",
    "app-spec.md",
  );
  mkdirSync(join(repository, "prototype", "builder-proof"), {
    recursive: true,
  });
  writeFileSync(appSpecPath, BUILD_READY_APP_SPEC);
  const appSpecDigest = sha256(readFileSync(appSpecPath));
  const contractPath = join(root, "contract.json");
  writeFileSync(
    contractPath,
    `${JSON.stringify({
      version: 1,
      appId: "builder-proof",
      appSpec: {
        path: "prototype/builder-proof/app-spec.md",
        sha256: appSpecDigest,
      },
    })}\n`,
  );
  const run = (args: readonly string[]) =>
    JSON.parse(
      execFileSync(
        miseBin,
        ["run", "--skip-tools", "repository:exec", "--", ...args],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            MISE_AUTO_INSTALL: "false",
            MISE_EXEC_AUTO_INSTALL: "false",
            MISE_TASK_RUN_AUTO_INSTALL: "false",
          },
        },
      ),
    ) as Record<string, unknown>;
  const identity = run(["app-identity.ts", "--app", "builder-proof"]);
  const proposal = run(["app-contract.ts", "--contract", contractPath]);
  if (
    identity.appId !== "builder-proof" ||
    identity.workspacePath !== "apps/builder-proof" ||
    identity.packageName !== "@autograph/builder-proof" ||
    proposal.futurePath !== "apps/builder-proof/app.contract.json" ||
    !Array.isArray(proposal.blockers) ||
    proposal.blockers.length !== 0 ||
    !Array.isArray(proposal.mutations) ||
    proposal.mutations.length !== 0
  )
    throw new Error(
      "The hosted artifact returned an unexpected planning result.",
    );
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      artifactSha256: HOSTED_ARTIFACT_SHA256,
      appId: identity.appId,
      futurePath: proposal.futurePath,
      blockers: proposal.blockers,
      mutations: proposal.mutations,
    })}\n`,
  );
} finally {
  rmSync(root, { force: true, recursive: true });
}
