import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { extract } from "tar";

import { BUILD_READY_APP_SPEC } from "../../../../evals/support/app-spec.ts";

const TARGET_SHA = "d378904a05e1bc2c0896886e6fbd3b816babaee2";
const TARGET_TREE = "6735f4b45cc2b29a139531a41dac990c925e0d39";
const APP_BUILDER_MISE_PROFILE = `[settings]
exec_auto_install = false
not_found_auto_install = false
task.run_auto_install = false

[deps]
disable = ["bun"]
`;
const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--"))
      throw new Error("Arguments must be exact --name value pairs.");
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}.`);
    values.set(flag, value);
  }
  const miseBin = values.get("--mise-bin");
  const arrustedRoot = values.get("--arrusted-root");
  const artifact = values.get("--artifact");
  const artifactSha256 = values.get("--artifact-sha256");
  values.delete("--mise-bin");
  values.delete("--arrusted-root");
  values.delete("--artifact");
  values.delete("--artifact-sha256");
  if (
    miseBin === undefined ||
    arrustedRoot === undefined ||
    artifact === undefined ||
    artifactSha256 === undefined ||
    values.size !== 0
  )
    throw new Error(
      "Usage: hosted:artifact-prove -- --arrusted-root <path> --artifact <path> --artifact-sha256 <sha256>",
    );
  return {
    miseBin: realpathSync(miseBin),
    arrustedRoot: realpathSync(arrustedRoot),
    artifact: realpathSync(artifact),
    artifactSha256,
  };
}

const input = parseArguments(process.argv.slice(2));
if (!isAbsolute(input.miseBin) || basename(input.miseBin) !== "mise")
  throw new Error("The mise executable must use an absolute canonical path.");
const miseStat = statSync(input.miseBin);
if (
  !miseStat.isFile() ||
  (miseStat.mode & 0o022) !== 0 ||
  !/^[0-9a-f]{64}$/u.test(input.artifactSha256) ||
  sha256(readFileSync(input.artifact)) !== input.artifactSha256
)
  throw new Error("The hosted dependency artifact binding is invalid.");

const git = (args: readonly string[]) =>
  execFileSync("/usr/bin/git", ["-C", input.arrustedRoot, ...args], {
    encoding: "utf8",
  }).trim();
if (
  git(["rev-parse", "HEAD^{commit}"]) !== TARGET_SHA ||
  git(["rev-parse", "HEAD^{tree}"]) !== TARGET_TREE ||
  git(["status", "--porcelain=v1"]) !== ""
)
  throw new Error("Arrusted source is not the exact clean supported target.");

const root = mkdtempSync(join(tmpdir(), "hosted-arrusted-proof."));
try {
  extract({ cwd: root, file: input.artifact, sync: true });
  const seed = join(root, ".app-builder-hosted-seed");
  if (existsSync(join(seed, "source-tree.tar.gz")))
    throw new Error("The hosted dependency artifact still embeds source.");
  const repository = join(root, "repository");
  mkdirSync(repository);
  const sourceTar = join(root, "canonical-source.tar");
  execFileSync(
    "/usr/bin/git",
    [
      "-C",
      input.arrustedRoot,
      "archive",
      "--format=tar",
      `--output=${sourceTar}`,
      TARGET_SHA,
    ],
    { stdio: "inherit" },
  );
  extract({ cwd: repository, file: sourceTar, sync: true });
  writeFileSync(
    join(repository, ".config", "mise", "config.app-builder.toml"),
    APP_BUILDER_MISE_PROFILE,
  );
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
        input.miseBin,
        [
          "--env",
          "app-builder",
          "run",
          "--no-deps",
          "--skip-tools",
          "repository:exec",
          "--",
          ...args,
        ],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dirname(input.miseBin)}:${process.env.PATH ?? ""}`,
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
      "The hosted dependency artifact returned an unexpected planning result.",
    );
  process.stdout.write(
    `${JSON.stringify({
      version: 2,
      artifactSha256: input.artifactSha256,
      sourceSha: TARGET_SHA,
      sourceTree: TARGET_TREE,
      appId: identity.appId,
      futurePath: proposal.futurePath,
      blockers: proposal.blockers,
      mutations: proposal.mutations,
    })}\n`,
  );
} finally {
  rmSync(root, { force: true, recursive: true });
}
