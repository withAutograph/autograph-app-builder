import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  ARRUSTED_IMAGE_TARGET_SHA,
  ARRUSTED_IMAGE_TARGET_TREE,
  IMAGE_PLATFORM,
  IMAGE_REPOSITORY,
  IMAGE_TOOL_VERSIONS,
} from "../lib/image/lifecycle";
import { materializeSanitizedGitTree } from "../lib/image/sanitized-git-tree";
import {
  exactCleanGitSource,
  immutableTreeDigest,
  inspectOciCandidateArchive,
  sealPromotionReceipt,
  sha256,
} from "../lib/release/promotion";
import { assertExactToolDiscovery, parseReviewedProof } from "../lib/release/proof-evidence";
import { verifyPortableProofArtifact } from "./portable-proof-artifact";
import { releaseEndpoint, TOOL_NAMES } from "./portable-release";

const execFileAsync = promisify(execFile);
const repositoryRoot = await realpath(path.resolve("."));

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith("--") ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error("Release proof arguments must be unique --name value pairs.");
    }
    values.set(name, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (value === undefined || value === "") {
      throw new Error(`Missing required release proof option ${name}.`);
    }
    values.delete(name);
    return value;
  };
  const parsed = {
    arrustedRoot: required("--arrusted-root"),
    endpoint: required("--endpoint"),
    output: required("--output"),
  };
  if (values.size !== 0) {
    throw new Error(`Unsupported release proof options: ${[...values.keys()].join(", ")}.`);
  }
  if (!path.isAbsolute(parsed.arrustedRoot) || !path.isAbsolute(parsed.output)) {
    throw new Error("Release proof roots must be absolute.");
  }
  return parsed;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function requiredExecutable(name: string) {
  const value = process.env[name];
  if (value === undefined || !path.isAbsolute(value)) {
    throw new Error(`mise must supply the absolute ${name} executable.`);
  }
  return value;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function run(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    capture?: boolean;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const result = await execFileAsync(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf-8",
    env: options.environment ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!options.capture && result.stdout.trim() !== "") {
    process.stdout.write(result.stdout);
  }
  if (!options.capture && result.stderr.trim() !== "") {
    process.stderr.write(result.stderr);
  }
  return result.stdout;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function ownerBoundFile(filePath: string, label: string) {
  const info = await lstat(filePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (info.mode & 0o022) !== 0
  ) {
    throw new Error(`${label} must be a current-user-owned regular file.`);
  }
  return readFile(filePath);
}

const args = parseArguments(process.argv.slice(2));
const endpointOrigin = releaseEndpoint(args.endpoint);
const builder = await exactCleanGitSource(repositoryRoot, "Builder");
const arrusted = await exactCleanGitSource(args.arrustedRoot, "Arrusted");
if (arrusted.commit !== ARRUSTED_IMAGE_TARGET_SHA || arrusted.tree !== ARRUSTED_IMAGE_TARGET_TREE) {
  throw new Error("Arrusted release source does not match the source-bound image target.");
}
const projectBinding = await ownerBoundFile(
  path.join(repositoryRoot, ".vercel/project.json"),
  "Vercel release project binding",
);
const outputParent = await realpath(path.dirname(args.output));
if (path.join(outputParent, path.basename(args.output)) !== args.output) {
  throw new Error("Release output must be an absolute canonical child path.");
}
try {
  await mkdir(args.output, { mode: 0o700 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    throw new Error(`Release candidate already exists: ${args.output}`, {
      cause: error,
    });
  }
  throw error;
}
const output = await realpath(args.output);
const node = requiredExecutable("APP_BUILDER_RELEASE_NODE_BIN");
const buildx = requiredExecutable("APP_BUILDER_RELEASE_BUILDX_BIN");
const msb = requiredExecutable("APP_BUILDER_RELEASE_MSB_BIN");
const vercel = requiredExecutable("APP_BUILDER_RELEASE_VERCEL_BIN");
const temporaryArrusted = path.join(output, ".arrusted-context");
const temporaryBuilder = path.join(output, ".builder-context");

try {
  const arrustedContext = materializeSanitizedGitTree(
    arrusted.root,
    temporaryArrusted,
    arrusted.commit,
    arrusted.tree,
  );
  materializeSanitizedGitTree(builder.root, temporaryBuilder, builder.commit, builder.tree);

  const packageRoot = path.join(output, "package");
  await run(node, [
    "--import",
    "tsx",
    "scripts/build-portable-release.mts",
    "--endpoint",
    endpointOrigin,
    "--output",
    packageRoot,
  ]);
  const installRoot = path.join(output, ".portable-install");
  await mkdir(installRoot, { mode: 0o700 });
  await Promise.all(
    ["codex", "vscode", "cursor"].map((client) =>
      run(node, [
        "--import",
        "tsx",
        "scripts/install-portable-plugin.mts",
        "--client",
        client,
        "--source",
        packageRoot,
        "--destination",
        installRoot,
      ]),
    ),
  );
  const portable = await verifyPortableProofArtifact({
    installRoot,
    releaseRoot: packageRoot,
    repositoryRoot,
  });
  assertExactToolDiscovery(portable.receipt.tools);

  const imageArchive = path.join(output, "image.oci.tar");
  const dockerfile = path.join(temporaryBuilder, "containers/eve-sandbox/Dockerfile");
  const dockerfileSha256 = sha256(await readFile(dockerfile));
  const provisionalTag = `${IMAGE_REPOSITORY}:candidate-${sha256(
    `${builder.commit}\0${arrusted.commit}\0${dockerfileSha256}`,
  ).slice(0, 16)}`;
  await run(buildx, [
    "build",
    "--platform",
    IMAGE_PLATFORM,
    "--build-context",
    `arrusted-target=${temporaryArrusted}`,
    "--build-arg",
    `APP_BUILDER_REVISION=${builder.commit}`,
    "--file",
    dockerfile,
    "--tag",
    provisionalTag,
    "--provenance=false",
    "--sbom=false",
    "--output",
    `type=oci,dest=${imageArchive}`,
    temporaryBuilder,
  ]);
  await chmod(imageArchive, 0o600);
  const image = await inspectOciCandidateArchive(imageArchive);
  const publicationTag = `${IMAGE_REPOSITORY}:release-${image.manifestDigest
    .slice("sha256:".length)
    .slice(0, 16)}`;
  const imageReference = `${IMAGE_REPOSITORY}@${image.manifestDigest}`;
  await run(msb, ["load", "--input", imageArchive, "--tag", publicationTag, "--quiet"]);

  const evalArguments = (evaluation: string) => [
    "--import",
    "tsx",
    "scripts/run-eve-eval.mts",
    "--gate-a-profile",
    "sandbox",
    "--gate-a-image",
    imageReference,
    "--gate-a-source-root",
    temporaryArrusted,
    evaluation,
    "--strict",
    "--skip-report",
  ];
  const proofEnvironment = {
    ...process.env,
    APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
    APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
    APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
    APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
    EVE_HOSTED_ADAPTER: "0",
  };
  const createOutput = await run(node, evalArguments("sandbox-reviewed-change-set"), {
    capture: true,
    environment: proofEnvironment,
  });
  const iterationOutput = await run(node, evalArguments("sandbox-existing-iteration"), {
    capture: true,
    environment: proofEnvironment,
  });

  await mkdir(path.join(temporaryBuilder, ".vercel"), {
    mode: 0o700,
    recursive: true,
  });
  await writeFile(path.join(temporaryBuilder, ".vercel/project.json"), projectBinding, {
    mode: 0o600,
  });
  await run(vercel, ["build", "--prod", "--yes"], {
    cwd: temporaryBuilder,
  });
  const deploymentRoot = path.join(output, "deployment");
  await mkdir(path.join(deploymentRoot, ".vercel"), {
    mode: 0o700,
    recursive: true,
  });
  await cp(
    path.join(temporaryBuilder, ".vercel/output"),
    path.join(deploymentRoot, ".vercel/output"),
    {
      recursive: true,
    },
  );
  await copyFile(
    path.join(temporaryBuilder, ".vercel/project.json"),
    path.join(deploymentRoot, ".vercel/project.json"),
  );

  const packageReceiptBytes = await readFile(path.join(packageRoot, "release-receipt.json"));
  const checksumsBytes = await readFile(path.join(packageRoot, "SHA256SUMS"));
  const releaseArchive = await readFile(path.join(packageRoot, portable.receipt.archive.name));
  const marketplaceArchive = await readFile(
    path.join(packageRoot, portable.receipt.codexMarketplaceArchive.name),
  );
  const finalBuilder = await exactCleanGitSource(repositoryRoot, "Builder");
  const finalArrusted = await exactCleanGitSource(args.arrustedRoot, "Arrusted");
  if (
    finalBuilder.commit !== builder.commit ||
    finalBuilder.tree !== builder.tree ||
    finalArrusted.commit !== arrusted.commit ||
    finalArrusted.tree !== arrusted.tree
  ) {
    throw new Error("Release sources changed while the candidate was proved.");
  }
  const closureSha256 = sha256(
    JSON.stringify({
      arrusted: { commit: arrusted.commit, tree: arrusted.tree },
      builder: { commit: builder.commit, tree: builder.tree },
      dockerfileSha256,
      platform: IMAGE_PLATFORM,
      sourceEntries: {
        count: arrustedContext.entryCount,
        digest: arrustedContext.entriesDigest,
      },
      tools: { ...IMAGE_TOOL_VERSIONS, vercel: "59.10.0" },
    }),
  );
  const receipt = sealPromotionReceipt({
    arrusted: { clean: true, commit: arrusted.commit, tree: arrusted.tree },
    bindings: {
      deployment: "production",
      endpoint: "deployed",
      execution: "release",
      marketplace: "release",
      oauth: "hosted",
    },
    builder: {
      clean: true,
      commit: builder.commit,
      repository: "https://github.com/withAutograph/autograph-app-builder",
      tree: builder.tree,
    },
    deployment: {
      outputTreeSha256: await immutableTreeDigest(path.join(deploymentRoot, ".vercel/output")),
      projectBindingSha256: sha256(projectBinding),
      root: "deployment",
    },
    endpoint: `${endpointOrigin}/mcp`,
    format: "autograph-release-promotion-v1",
    image: {
      archive: "image.oci.tar",
      archiveSha256: image.archiveSha256,
      localTag: provisionalTag,
      manifestDigest: image.manifestDigest,
      publicationTag,
      reference: imageReference,
    },
    package: {
      archive: `package/${portable.receipt.archive.name}`,
      archiveSha256: sha256(releaseArchive),
      checksums: "package/SHA256SUMS",
      checksumsSha256: sha256(checksumsBytes),
      marketplaceArchive: `package/${portable.receipt.codexMarketplaceArchive.name}`,
      marketplaceArchiveSha256: sha256(marketplaceArchive),
      receipt: "package/release-receipt.json",
      receiptSha256: sha256(packageReceiptBytes),
      root: "package",
      version: portable.receipt.version,
    },
    platform: {
      closureSha256,
      dockerfileSha256,
      image: IMAGE_PLATFORM,
      sanitizedSourceEntriesSha256: arrustedContext.entriesDigest,
      sanitizedSourceEntryCount: arrustedContext.entryCount,
    },
    proofs: {
      create: parseReviewedProof(createOutput, "sandbox-reviewed-change-set"),
      iteration: parseReviewedProof(iterationOutput, "sandbox-existing-iteration"),
    },
    tools: [...TOOL_NAMES],
  });
  await writeFile(
    path.join(output, "promotion-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  await rm(installRoot, { force: false, recursive: true });
  await rm(temporaryArrusted, { force: false, recursive: true });
  await rm(temporaryBuilder, { force: false, recursive: true });
  console.log(`Release candidate proved: ${receipt.digest}`);
  console.log(`Candidate root: ${output}`);
} catch (error) {
  await rm(output, { force: true, recursive: true });
  throw error;
}
