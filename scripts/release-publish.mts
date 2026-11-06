import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import nodePath from "node:path";
import { runSequentially } from "../lib/async-sequential";

import {
  exactCleanGitSource,
  releasePublicationCommands,
  sha256,
  verifyPromotionCandidate,
} from "../lib/release/promotion";
import { HostedMcpProofClient } from "./hosted-portable-proof";
import { TOOL_NAMES } from "./portable-release";

const execFileAsync = promisify(execFile);
const PROMOTION_RECEIPT_NAME = "promotion-receipt.json";

const UNIQUE_PAIRS_ERROR = "Release publication options must be unique pairs.";
const TOKEN_FILE_ERROR = "Release OAuth token must be a canonical owner-only file.";
const DEPLOYMENT_READBACK_ERROR = "Vercel deployment readback was incomplete.";
const GITHUB_READBACK_ERROR = "Existing GitHub release did not match the promotion.";
const RELEASE_ASSETS_ERROR = "Existing GitHub release assets did not match proof.";
const RESOURCE_METADATA_ERROR = "Deployed OAuth resource metadata did not match release.";

const parseArguments = (args: readonly string[]) => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined) {
      throw new Error(UNIQUE_PAIRS_ERROR);
    }
    const invalidName = !name.startsWith("--");
    const invalidValue = value.startsWith("--");
    const duplicateName = values.has(name);
    if (invalidName || invalidValue || duplicateName) {
      throw new Error(UNIQUE_PAIRS_ERROR);
    }
    values.set(name, value);
  }
  const candidateRoot = values.get("--candidate-root");
  const tokenFile = values.get("--token-file");
  const hasExpectedOptions = values.size === 2;
  const hasCandidate = candidateRoot !== undefined;
  const hasToken = tokenFile !== undefined;
  if (!hasExpectedOptions || !hasCandidate || !hasToken) {
    throw new Error(
      "Usage: mise run release:publish -- --candidate-root /absolute/proven/candidate --token-file /absolute/owner-only/oauth-token",
    );
  }
  const candidateIsAbsolute = nodePath.isAbsolute(candidateRoot);
  const tokenIsAbsolute = nodePath.isAbsolute(tokenFile);
  if (!candidateIsAbsolute || !tokenIsAbsolute) {
    throw new Error("Release candidate and token paths must be absolute.");
  }
  return { candidateRoot, tokenFile };
};

function requiredExecutable(name: string) {
  const value = process.env[name];
  if (value === undefined || !nodePath.isAbsolute(value)) {
    throw new Error(`mise must supply the absolute ${name} executable.`);
  }
  return value;
}

async function ownerToken(path: string) {
  const canonical = await realpath(nodePath.resolve(path));
  const info = await lstat(canonical);
  const wrongPath = canonical !== path;
  const notRegularFile = !info.isFile();
  const symbolicLink = info.isSymbolicLink();
  if (wrongPath || notRegularFile || symbolicLink) {
    throw new Error(TOKEN_FILE_ERROR);
  }
  if (info.uid !== process.getuid?.()) {
    throw new Error(TOKEN_FILE_ERROR);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(TOKEN_FILE_ERROR);
  }
  const tokenContents = await readFile(canonical, "utf-8");
  const token = tokenContents.trim();
  if (token === "" || token.length > 16_384 || /\s/u.test(token)) {
    throw new Error("Release OAuth token was malformed.");
  }
  return token;
}

interface JsonRecord {
  [key: string]: JsonValue;
}
type JsonValue = boolean | JsonRecord | null | number | string | JsonValue[];
interface DeploymentIdentity {
  id: string;
  url: string;
}
interface GithubAsset {
  name: string;
}
const isJsonRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJsonRecord = (value: string, errorMessage: string): JsonRecord => {
  const parsed: unknown = JSON.parse(value);
  if (!isJsonRecord(parsed)) throw new Error(errorMessage);
  return parsed;
};

const parseString = (value: JsonValue | undefined, pattern: RegExp, errorMessage: string) => {
  if (value === null || value === undefined || value.constructor !== String) {
    throw new Error(errorMessage);
  }
  const valueString = value;
  const [parsed] = valueString.match(pattern) ?? [];
  if (parsed !== value) throw new Error(errorMessage);
  return valueString;
};

const deploymentIdentity = (value: string): DeploymentIdentity => {
  const parsed = parseJsonRecord(value, DEPLOYMENT_READBACK_ERROR);
  return {
    id: parseString(parsed.id, /^dpl_[A-Za-z0-9]+$/u, DEPLOYMENT_READBACK_ERROR),
    url: parseString(parsed.url, /^[A-Za-z0-9.-]+[.]vercel[.]app$/u, DEPLOYMENT_READBACK_ERROR),
  };
};

const parseGithubAssets = (value: JsonValue | undefined): GithubAsset[] => {
  if (!Array.isArray(value)) throw new Error(GITHUB_READBACK_ERROR);
  return value.map((asset) => {
    if (!isJsonRecord(asset)) {
      throw new Error(GITHUB_READBACK_ERROR);
    }
    return { name: parseString(asset.name, /.+/u, GITHUB_READBACK_ERROR) };
  });
};

async function sealPublicationTree(root: string, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  await runSequentially(entries, async (entry) => {
    const path = nodePath.join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error("Release publication staging contained a link.");
    }
    if (entry.isDirectory()) {
      await sealPublicationTree(root, path);
      await chmod(path, 0o500);
    } else if (entry.isFile()) {
      await chmod(path, 0o400);
    } else {
      throw new Error("Release publication staging contained a special file.");
    }
  });
  if (current === root) {
    await chmod(root, 0o500);
  }
}

// Keep publication cleanup scoped to the release command.
async function removePublicationTree(root: string) {
  // Keep publication cleanup helpers local to this operation.
  async function makeWritable(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return;
    }
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      await runSequentially(await readdir(path), async (entry) => {
        await makeWritable(nodePath.join(path, entry));
      });
    } else {
      await chmod(path, 0o600);
    }
  }
  try {
    await makeWritable(root);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  await rm(root, { force: true, recursive: true });
}

const parsedArguments = parseArguments(process.argv.slice(2));
const candidateRoot = await realpath(nodePath.resolve(parsedArguments.candidateRoot));
if (candidateRoot !== parsedArguments.candidateRoot) {
  throw new Error("Release candidate root must be canonical.");
}
await verifyPromotionCandidate({ candidateRoot });
const publicationReceiptPath = nodePath.join(candidateRoot, "publication-receipt.json");
try {
  await lstat(publicationReceiptPath);
  throw new Error("This exact release candidate was already published.");
} catch (error: unknown) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}
const publicationRoot = await realpath(
  await mkdtemp(nodePath.join(tmpdir(), "autograph-release-publish-")),
);
await chmod(publicationRoot, 0o700);
try {
  await cp(candidateRoot, publicationRoot, {
    dereference: false,
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  await sealPublicationTree(publicationRoot);
  const { receipt } = await verifyPromotionCandidate({
    candidateRoot: publicationRoot,
  });
  const builder = await exactCleanGitSource(nodePath.resolve("."), "Builder");
  if (builder.commit !== receipt.builder.commit || builder.tree !== receipt.builder.tree) {
    throw new Error("Release publication checkout does not match the proof.");
  }
  const oauthToken = await ownerToken(parsedArguments.tokenFile);

  const executables = {
    docker: requiredExecutable("APP_BUILDER_RELEASE_DOCKER_BIN"),
    gh: requiredExecutable("APP_BUILDER_RELEASE_GH_BIN"),
    vercel: requiredExecutable("APP_BUILDER_RELEASE_VERCEL_BIN"),
  };

  const exactGithubReleaseExists = async () => {
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
        { cwd: publicationRoot, encoding: "utf-8", env: process.env },
      );
      metadataRaw = result.stdout;
    } catch (error) {
      const stderrValue = error instanceof Error && "stderr" in error ? error.stderr : undefined;
      const stderr =
        stderrValue !== null && stderrValue !== undefined && stderrValue.constructor === String
          ? String(stderrValue)
          : undefined;
      if (
        stderr !== undefined &&
        stderr.length > 0 &&
        /release not found|could not resolve to a release/iu.test(stderr)
      ) {
        return false;
      }
      throw error;
    }
    const metadata = parseJsonRecord(metadataRaw, GITHUB_READBACK_ERROR);
    const expectedAssetNames = [
      nodePath.basename(receipt.package.archive),
      nodePath.basename(receipt.package.marketplaceArchive),
      nodePath.basename(receipt.package.checksums),
      nodePath.basename(receipt.package.receipt),
      PROMOTION_RECEIPT_NAME,
    ].toSorted((left, right) => left.localeCompare(right));
    const tagMatches = metadata.tagName === `v${receipt.package.version}`;
    const isPrerelease = metadata.isPrerelease === true;
    const commitMatches = metadata.targetCommitish === receipt.builder.commit;
    if (!tagMatches || !isPrerelease || !commitMatches) throw new Error(GITHUB_READBACK_ERROR);
    const assetNames = parseGithubAssets(metadata.assets).map(({ name }) => name);
    if (
      JSON.stringify(assetNames.toSorted((left, right) => left.localeCompare(right))) !==
      JSON.stringify(expectedAssetNames)
    ) {
      throw new Error(GITHUB_READBACK_ERROR);
    }
    const downloadRoot = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), "autograph-github-readback-")),
    );
    const proofAssets: readonly (readonly [string, string])[] = [
      [receipt.package.archive, receipt.package.archiveSha256],
      [receipt.package.marketplaceArchive, receipt.package.marketplaceArchiveSha256],
      [receipt.package.checksums, receipt.package.checksumsSha256],
      [receipt.package.receipt, receipt.package.receiptSha256],
      [
        PROMOTION_RECEIPT_NAME,
        sha256(await readFile(nodePath.join(publicationRoot, PROMOTION_RECEIPT_NAME))),
      ],
    ];
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
        { cwd: publicationRoot, encoding: "utf-8", env: process.env },
      );
      for (const [path, expected] of proofAssets) {
        const downloaded = nodePath.join(downloadRoot, nodePath.basename(path));
        const info = await lstat(downloaded);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          sha256(await readFile(downloaded)) !== expected
        ) {
          throw new Error(RELEASE_ASSETS_ERROR);
        }
      }
    } finally {
      await rm(downloadRoot, { force: true, recursive: true });
    }
    return true;
  };
  const outputs: { tool: string; stdoutSha256: string }[] = [];
  const commands = releasePublicationCommands(receipt);
  const releaseCommand = commands.at(-1);
  if (releaseCommand?.tool !== "gh") {
    throw new Error("Release asset publication must be the final mutation.");
  }
  const execute = async (command: (typeof commands)[number]) => {
    const result = await execFileAsync(executables[command.tool], command.args, {
      cwd: "cwd" in command ? nodePath.join(publicationRoot, command.cwd) : publicationRoot,
      encoding: "utf-8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.stdout.trim() !== "") {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.trim() !== "") {
      process.stderr.write(result.stderr);
    }
    outputs.push({ stdoutSha256: sha256(result.stdout), tool: command.tool });
    return result.stdout;
  };
  let deploymentUrl: string | undefined;
  for (const command of commands.slice(0, -1)) {
    const stdout = await execute(command);
    if (command.tool === "vercel") {
      deploymentUrl = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .findLast((line) => /^https:\/\/[A-Za-z0-9.-]+[.]vercel[.]app$/u.test(line));
    }
  }

  const buildx = requiredExecutable("APP_BUILDER_RELEASE_BUILDX_BIN");
  const remote = await execFileAsync(
    buildx,
    ["imagetools", "inspect", receipt.image.publicationTag, "--format", "{{json .Manifest}}"],
    {
      cwd: publicationRoot,
      encoding: "utf-8",
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const remoteDescriptor = parseJsonRecord(
    remote.stdout,
    "Published registry image readback was malformed.",
  );
  if (remoteDescriptor.digest !== receipt.image.manifestDigest) {
    throw new Error("Published registry image did not retain the proven digest.");
  }
  const endpointOrigin = new URL(receipt.endpoint).origin;
  if (deploymentUrl === undefined) {
    throw new Error("Production deployment did not complete.");
  }
  const [deploymentReadback, endpointReadback] = await Promise.all([
    execFileAsync(executables.vercel, ["inspect", deploymentUrl, "--wait", "--json"], {
      cwd: nodePath.join(publicationRoot, receipt.deployment.root),
      encoding: "utf-8",
      env: process.env,
    }),
    execFileAsync(executables.vercel, ["inspect", endpointOrigin, "--wait", "--json"], {
      cwd: nodePath.join(publicationRoot, receipt.deployment.root),
      encoding: "utf-8",
      env: process.env,
    }),
  ]);
  const deployment = deploymentIdentity(deploymentReadback.stdout);
  const endpointDeployment = deploymentIdentity(endpointReadback.stdout);
  if (deployment.id !== endpointDeployment.id) {
    throw new Error("Release endpoint was not bound to the proven deployment.");
  }
  const metadataResponse = await fetch(`${endpointOrigin}/.well-known/oauth-protected-resource`, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!metadataResponse.ok) {
    throw new Error("Deployed OAuth resource metadata was unavailable.");
  }
  const metadataBytes = Buffer.from(await metadataResponse.arrayBuffer());
  const metadata = parseJsonRecord(metadataBytes.toString("utf-8"), RESOURCE_METADATA_ERROR);
  const authorizationServers = metadata.authorization_servers;
  if (
    metadata.resource !== receipt.endpoint ||
    !Array.isArray(authorizationServers) ||
    authorizationServers.length !== 1
  ) {
    throw new Error(RESOURCE_METADATA_ERROR);
  }
  const [authorizationServer] = authorizationServers;
  const hasAuthorizationServer = authorizationServer !== null && authorizationServer !== undefined;
  const isAuthorizationServerString =
    hasAuthorizationServer && authorizationServer.constructor === String;
  const authorizationServerUrl = isAuthorizationServerString ? authorizationServer : "";
  if (!isAuthorizationServerString || !authorizationServerUrl.startsWith("https://")) {
    throw new Error(RESOURCE_METADATA_ERROR);
  }
  const hostedClient = new HostedMcpProofClient(receipt.endpoint, oauthToken);
  await hostedClient.initialize();
  const deployedTools = await hostedClient.listTools();
  if (JSON.stringify(deployedTools) !== JSON.stringify(TOOL_NAMES)) {
    throw new Error("Deployed MCP endpoint did not expose the exact five tools.");
  }
  const releaseExists = await exactGithubReleaseExists();
  if (releaseExists) {
    outputs.push({ stdoutSha256: sha256("reconciled"), tool: "gh" });
  } else {
    await execute(releaseCommand);
    const releaseExistsAfterPublish = await exactGithubReleaseExists();
    if (releaseExistsAfterPublish) {
      outputs.push({ stdoutSha256: sha256("published"), tool: "gh" });
    } else {
      throw new Error("GitHub release readback was unavailable after publish.");
    }
  }

  const unsigned = {
    commands: outputs,
    deployment: {
      deploymentId: deployment.id,
      deploymentUrl,
      endpointOrigin,
      mode: "prebuilt-production",
      oauthMetadataSha256: sha256(metadataBytes),
      outputTreeSha256: receipt.deployment.outputTreeSha256,
      toolDiscoverySha256: sha256(JSON.stringify(deployedTools)),
    },
    format: "autograph-release-publication-v1",
    image: {
      publicationTag: receipt.image.publicationTag,
      reference: receipt.image.reference,
      remoteReadbackSha256: sha256(remote.stdout),
    },
    package: {
      archiveSha256: receipt.package.archiveSha256,
      marketplaceArchiveSha256: receipt.package.marketplaceArchiveSha256,
      releaseTag: `v${receipt.package.version}`,
      version: receipt.package.version,
    },
    promotionDigest: receipt.digest,
  };
  const publication = { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
  await writeFile(publicationReceiptPath, `${JSON.stringify(publication, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Published exact proven release: ${publication.digest}`);
} finally {
  await removePublicationTree(publicationRoot);
}
