import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  exactCleanGitSource,
  releasePublicationCommands,
  sha256,
  verifyPromotionCandidate,
} from "../lib/release/promotion";
import { HostedMcpProofClient } from "./hosted-portable-proof";
import { TOOL_NAMES } from "./portable-release";

const execFileAsync = promisify(execFile);

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
    )
      throw new Error("Release publication options must be unique pairs.");
    values.set(name, value);
  }
  const candidateRoot = values.get("--candidate-root");
  const tokenFile = values.get("--token-file");
  if (
    values.size !== 2 ||
    candidateRoot === undefined ||
    tokenFile === undefined
  )
    throw new Error(
      "Usage: mise run release:publish -- --candidate-root /absolute/proven/candidate --token-file /absolute/owner-only/oauth-token",
    );
  if (!isAbsolute(candidateRoot) || !isAbsolute(tokenFile))
    throw new Error("Release candidate and token paths must be absolute.");
  return { candidateRoot, tokenFile };
}

function requiredExecutable(name: string) {
  const value = process.env[name];
  if (value === undefined || !isAbsolute(value))
    throw new Error(`mise must supply the absolute ${name} executable.`);
  return value;
}

async function ownerToken(path: string) {
  const canonical = await realpath(resolve(path));
  const info = await lstat(canonical);
  if (
    canonical !== path ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Release OAuth token must be a canonical owner-only file.");
  const token = (await readFile(canonical, "utf8")).trim();
  if (token === "" || token.length > 16_384 || /\s/u.test(token))
    throw new Error("Release OAuth token was malformed.");
  return token;
}

function deploymentIdentity(value: string) {
  const parsed = JSON.parse(value) as { id?: unknown; url?: unknown };
  if (
    typeof parsed.id !== "string" ||
    !/^dpl_[A-Za-z0-9]+$/u.test(parsed.id) ||
    typeof parsed.url !== "string" ||
    !/^[A-Za-z0-9.-]+[.]vercel[.]app$/u.test(parsed.url)
  )
    throw new Error("Vercel deployment readback was incomplete.");
  return { id: parsed.id, url: parsed.url } as const;
}

async function sealPublicationTree(root: string, current = root) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error("Release publication staging contained a link.");
    if (entry.isDirectory()) {
      await sealPublicationTree(root, path);
      await chmod(path, 0o500);
    } else if (entry.isFile()) await chmod(path, 0o400);
    else
      throw new Error("Release publication staging contained a special file.");
  }
  if (current === root) await chmod(root, 0o500);
}

async function removePublicationTree(root: string) {
  async function makeWritable(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path))
        await makeWritable(join(path, entry));
    } else await chmod(path, 0o600);
  }
  await makeWritable(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rm(root, { recursive: true, force: true });
}

const parsedArguments = parseArguments(process.argv.slice(2));
const candidateRoot = await realpath(resolve(parsedArguments.candidateRoot));
if (candidateRoot !== parsedArguments.candidateRoot)
  throw new Error("Release candidate root must be canonical.");
await verifyPromotionCandidate({ candidateRoot });
const publicationReceiptPath = join(candidateRoot, "publication-receipt.json");
try {
  await lstat(publicationReceiptPath);
  throw new Error("This exact release candidate was already published.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const publicationRoot = await realpath(
  await mkdtemp(join(tmpdir(), "autograph-release-publish-")),
);
await chmod(publicationRoot, 0o700);
try {
  await cp(candidateRoot, publicationRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  await sealPublicationTree(publicationRoot);
  const { receipt } = await verifyPromotionCandidate({
    candidateRoot: publicationRoot,
  });
  const builder = await exactCleanGitSource(resolve("."), "Builder");
  if (
    builder.commit !== receipt.builder.commit ||
    builder.tree !== receipt.builder.tree
  )
    throw new Error("Release publication checkout does not match the proof.");
  const oauthToken = await ownerToken(parsedArguments.tokenFile);

  const executables = {
    gh: requiredExecutable("APP_BUILDER_RELEASE_GH_BIN"),
    docker: requiredExecutable("APP_BUILDER_RELEASE_DOCKER_BIN"),
    vercel: requiredExecutable("APP_BUILDER_RELEASE_VERCEL_BIN"),
  };

  async function exactGithubReleaseExists() {
    let metadataRaw: string;
    try {
      const result = await execFileAsync(
        executables.gh,
        [
          "release",
          "view",
          `v${receipt.package.version}`,
          "--repo",
          "withAutograph/autograph-app-builder",
          "--json",
          "tagName,isPrerelease,targetCommitish,assets",
        ],
        { cwd: publicationRoot, env: process.env, encoding: "utf8" },
      );
      metadataRaw = result.stdout;
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      if (
        typeof stderr === "string" &&
        /release not found|could not resolve to a release/iu.test(stderr)
      )
        return false;
      throw error;
    }
    const metadata = JSON.parse(metadataRaw) as {
      tagName?: unknown;
      isPrerelease?: unknown;
      targetCommitish?: unknown;
      assets?: { name?: unknown }[];
    };
    const expectedAssetNames = [
      basename(receipt.package.archive),
      basename(receipt.package.marketplaceArchive),
      basename(receipt.package.checksums),
      basename(receipt.package.receipt),
      "promotion-receipt.json",
    ].sort();
    if (
      metadata.tagName !== `v${receipt.package.version}` ||
      metadata.isPrerelease !== true ||
      metadata.targetCommitish !== receipt.builder.commit ||
      !Array.isArray(metadata.assets) ||
      JSON.stringify(metadata.assets.map(({ name }) => name).sort()) !==
        JSON.stringify(expectedAssetNames)
    )
      throw new Error("Existing GitHub release did not match the promotion.");
    const downloadRoot = await realpath(
      await mkdtemp(join(tmpdir(), "autograph-github-readback-")),
    );
    const assets = [
      [receipt.package.archive, receipt.package.archiveSha256],
      [
        receipt.package.marketplaceArchive,
        receipt.package.marketplaceArchiveSha256,
      ],
      [receipt.package.checksums, receipt.package.checksumsSha256],
      [receipt.package.receipt, receipt.package.receiptSha256],
      [
        "promotion-receipt.json",
        sha256(await readFile(join(publicationRoot, "promotion-receipt.json"))),
      ],
    ] as const;
    try {
      await execFileAsync(
        executables.gh,
        [
          "release",
          "download",
          `v${receipt.package.version}`,
          "--repo",
          "withAutograph/autograph-app-builder",
          "--dir",
          downloadRoot,
        ],
        { cwd: publicationRoot, env: process.env, encoding: "utf8" },
      );
      for (const [path, expected] of assets) {
        const downloaded = join(downloadRoot, basename(path));
        const info = await lstat(downloaded);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          sha256(await readFile(downloaded)) !== expected
        )
          throw new Error(
            "Existing GitHub release assets did not match proof.",
          );
      }
    } finally {
      await rm(downloadRoot, { recursive: true, force: true });
    }
    return true;
  }
  const outputs: { tool: string; stdoutSha256: string }[] = [];
  const commands = releasePublicationCommands(receipt);
  const releaseCommand = commands.at(-1);
  if (releaseCommand?.tool !== "gh")
    throw new Error("Release asset publication must be the final mutation.");
  const execute = async (command: (typeof commands)[number]) => {
    const result = await execFileAsync(
      executables[command.tool],
      command.args,
      {
        cwd:
          "cwd" in command
            ? join(publicationRoot, command.cwd)
            : publicationRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.stdout.trim() !== "") process.stdout.write(result.stdout);
    if (result.stderr.trim() !== "") process.stderr.write(result.stderr);
    outputs.push({ tool: command.tool, stdoutSha256: sha256(result.stdout) });
    return result.stdout;
  };
  let deploymentUrl: string | undefined;
  for (const command of commands.slice(0, -1)) {
    const stdout = await execute(command);
    if (command.tool === "vercel")
      deploymentUrl = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .findLast((line) =>
          /^https:\/\/[A-Za-z0-9.-]+[.]vercel[.]app$/u.test(line),
        );
  }

  const buildx = requiredExecutable("APP_BUILDER_RELEASE_BUILDX_BIN");
  const remote = await execFileAsync(
    buildx,
    [
      "imagetools",
      "inspect",
      receipt.image.publicationTag,
      "--format",
      "{{json .Manifest}}",
    ],
    {
      cwd: publicationRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const remoteDescriptor = JSON.parse(remote.stdout) as { digest?: unknown };
  if (remoteDescriptor.digest !== receipt.image.manifestDigest)
    throw new Error(
      "Published registry image did not retain the proven digest.",
    );
  const endpointOrigin = new URL(receipt.endpoint).origin;
  if (deploymentUrl === undefined)
    throw new Error("Production deployment did not complete.");
  const [deploymentReadback, endpointReadback] = await Promise.all([
    execFileAsync(
      executables.vercel,
      ["inspect", deploymentUrl, "--wait", "--json"],
      {
        cwd: join(publicationRoot, receipt.deployment.root),
        env: process.env,
        encoding: "utf8",
      },
    ),
    execFileAsync(
      executables.vercel,
      ["inspect", endpointOrigin, "--wait", "--json"],
      {
        cwd: join(publicationRoot, receipt.deployment.root),
        env: process.env,
        encoding: "utf8",
      },
    ),
  ]);
  const deployment = deploymentIdentity(deploymentReadback.stdout);
  const endpointDeployment = deploymentIdentity(endpointReadback.stdout);
  if (deployment.id !== endpointDeployment.id)
    throw new Error("Release endpoint was not bound to the proven deployment.");
  const metadataResponse = await fetch(
    `${endpointOrigin}/.well-known/oauth-protected-resource`,
    { redirect: "error", signal: AbortSignal.timeout(15_000) },
  );
  if (!metadataResponse.ok)
    throw new Error("Deployed OAuth resource metadata was unavailable.");
  const metadataBytes = Buffer.from(await metadataResponse.arrayBuffer());
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as {
    resource?: unknown;
    authorization_servers?: unknown;
  };
  if (
    metadata.resource !== receipt.endpoint ||
    !Array.isArray(metadata.authorization_servers) ||
    metadata.authorization_servers.length !== 1 ||
    typeof metadata.authorization_servers[0] !== "string" ||
    !metadata.authorization_servers[0].startsWith("https://")
  )
    throw new Error("Deployed OAuth resource metadata did not match release.");
  const hostedClient = new HostedMcpProofClient(receipt.endpoint, oauthToken);
  await hostedClient.initialize();
  const deployedTools = await hostedClient.listTools();
  if (JSON.stringify(deployedTools) !== JSON.stringify(TOOL_NAMES))
    throw new Error(
      "Deployed MCP endpoint did not expose the exact five tools.",
    );
  if (!(await exactGithubReleaseExists())) {
    await execute(releaseCommand);
    if (!(await exactGithubReleaseExists()))
      throw new Error("GitHub release readback was unavailable after publish.");
  } else {
    outputs.push({ tool: "gh", stdoutSha256: sha256("reconciled") });
  }

  const unsigned = {
    format: "autograph-release-publication-v1",
    promotionDigest: receipt.digest,
    image: {
      reference: receipt.image.reference,
      publicationTag: receipt.image.publicationTag,
      remoteReadbackSha256: sha256(remote.stdout),
    },
    package: {
      version: receipt.package.version,
      releaseTag: `v${receipt.package.version}`,
      archiveSha256: receipt.package.archiveSha256,
      marketplaceArchiveSha256: receipt.package.marketplaceArchiveSha256,
    },
    deployment: {
      endpointOrigin,
      outputTreeSha256: receipt.deployment.outputTreeSha256,
      deploymentId: deployment.id,
      deploymentUrl,
      mode: "prebuilt-production",
      oauthMetadataSha256: sha256(metadataBytes),
      toolDiscoverySha256: sha256(JSON.stringify(deployedTools)),
    },
    commands: outputs,
  };
  const publication = { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
  await writeFile(
    publicationReceiptPath,
    `${JSON.stringify(publication, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(`Published exact proven release: ${publication.digest}`);
} finally {
  await removePublicationTree(publicationRoot);
}
