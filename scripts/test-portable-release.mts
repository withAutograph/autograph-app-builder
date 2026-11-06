import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { z } from "zod";

import {
  archiveFiles,
  portableReleaseReceiptSchema,
  verifyPortableProofArtifact,
} from "./portable-proof-artifact";
import { deterministicGzip, deterministicTar, sha256 } from "./portable-release";
import { runSequentially } from "../lib/async-sequential";

const { join, resolve: pathResolve } = nodePath;
const pluginVersionSchema = z.object({ version: z.string() });
const marketplaceManifestSchema = z.object({
  name: z.string(),
  plugins: z.array(
    z.object({
      policy: z.object({ authentication: z.string() }),
      source: z.object({ path: z.string() }),
    }),
  ),
});
const codexAdapterSchema = z.object({
  mcpServers: z.record(z.string(), z.object({ oauth_resource: z.string(), url: z.string() })),
});
const codexManifestSchema = z.object({
  interface: z.object({ composerIcon: z.string().optional(), logo: z.string().optional() }),
});
const harnessSchema = z.object({ transport: z.object({ url: z.string() }) });
const releaseReceiptSchema = portableReleaseReceiptSchema.extend({
  source: z.object({ repository: z.string(), sha: z.string(), tree: z.string() }),
});
const marketplaceArchivePrefix = "app-builder-codex-marketplace-";
const sourceRepository = "https://github.com/withAutograph/autograph-app-builder";
const receiptFilename = "release-receipt.json";
const systemPath = "/usr/bin:/bin";
const constrainedEnvironment = { LC_ALL: "C", NODE_ENV: "test", PATH: systemPath };
const manifestFilename = ".codex-plugin/plugin.json";
const appBuilderPluginPath = "./plugins/app-builder";

const waitForClose = async (child: ReturnType<typeof spawn>) => {
  await once(child, "close");
  return child.exitCode;
};
const archivePrefix = "app-builder-";
const packageVersion = pluginVersionSchema.parse(
  JSON.parse(await readFile("plugin.json", "utf-8")),
).version;

const run = async (script: string, args: string[], expected = 0) => {
  const child = spawn(process.execPath, [...process.execArgv, `scripts/${script}`, ...args], {
    stdio: expected === 0 ? "inherit" : "ignore",
  });
  const code = await waitForClose(child);
  if (code !== expected) {
    throw new Error(`${script} exited ${code}; expected ${expected}.`);
  }
};

const temp = await mkdtemp(join(tmpdir(), "autograph-portable-"));
try {
  // Keep assertion helpers scoped to this release proof.
  const expectRejected = async (action: () => Promise<void>, label: string) => {
    try {
      await action();
    } catch {
      return;
    }
    throw new Error(`Portable verifier accepted ${label}.`);
  };
  await runSequentially(
    [
      "https://replace-me.invalid",
      "https://mcp-endpoint.template",
      "https://localhost",
      "https://agent.example.com",
      "https://localhost.",
      "https://example.com.",
      "https://agent.invalid.",
      "https://agent.localhost.",
      "https://0",
      "https://0.0.0.0",
      "https://[::]",
      "https://[::ffff:0:0]",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:127.0.0.1]",
      "https://mcp.autograph.dev/",
      "https://MCP.autograph.dev",
      "https://mcp.autograph.dev:443",
    ],
    async (endpoint) => {
      await run(
        "build-portable-release.mts",
        ["--endpoint", endpoint, "--output", join(temp, `rejected-${Date.now()}`)],
        1,
      );
    },
  );
  const first = join(temp, "release-a");
  const second = join(temp, "release-b");
  const endpoint = "https://mcp.autograph.dev";
  await runSequentially([first, second], async (output) => {
    await run("build-portable-release.mts", ["--endpoint", endpoint, "--output", output]);
  });
  const archiveName = `${archivePrefix}${packageVersion}.tar.gz`;
  const marketplaceArchiveName = `${marketplaceArchivePrefix}${packageVersion}.tar.gz`;
  const firstArchive = await readFile(join(first, archiveName));
  const secondArchive = await readFile(join(second, archiveName));
  if (!firstArchive.equals(secondArchive)) {
    throw new Error("Portable archive is not reproducible.");
  }
  const firstMarketplaceArchive = await readFile(join(first, marketplaceArchiveName));
  const secondMarketplaceArchive = await readFile(join(second, marketplaceArchiveName));
  if (!firstMarketplaceArchive.equals(secondMarketplaceArchive)) {
    throw new Error("Codex marketplace archive is not reproducible.");
  }
  const firstReceiptBytes = await readFile(join(first, receiptFilename), "utf-8");
  const secondReceiptBytes = await readFile(join(second, receiptFilename), "utf-8");
  const firstReceipt = portableReleaseReceiptSchema.parse(JSON.parse(firstReceiptBytes));
  const secondReceipt = portableReleaseReceiptSchema.parse(JSON.parse(secondReceiptBytes));
  if (JSON.stringify(firstReceipt) !== JSON.stringify(secondReceipt)) {
    throw new Error("Portable release receipt is not reproducible.");
  }
  if (
    firstReceipt.source.repository !== sourceRepository ||
    !/^[0-9a-f]{40}$/u.test(firstReceipt.source.sha) ||
    !/^[0-9a-f]{40}$/u.test(firstReceipt.source.tree)
  ) {
    throw new Error("Portable release was not bound to an immutable source.");
  }
  const extracted = join(temp, "extracted");
  await mkdir(extracted);
  execFileSync("/usr/bin/tar", ["-xzf", join(first, archiveName), "-C", extracted], {
    env: constrainedEnvironment,
    stdio: "inherit",
  });
  await run("validate-plugin.mts", [
    "--root",
    join(extracted, "app-builder"),
    "--artifact",
    "--release",
  ]);
  const marketplace = join(temp, "codex-marketplace");
  await mkdir(marketplace);
  execFileSync("/usr/bin/tar", ["-xzf", join(first, marketplaceArchiveName), "-C", marketplace], {
    env: constrainedEnvironment,
    stdio: "inherit",
  });
  const marketplaceManifest = marketplaceManifestSchema.parse(
    JSON.parse(await readFile(join(marketplace, ".agents/plugins/marketplace.json"), "utf-8")),
  );
  if (
    marketplaceManifest.name !== "autograph" ||
    marketplaceManifest.plugins?.[0]?.source?.path !== appBuilderPluginPath ||
    marketplaceManifest.plugins?.[0]?.policy?.authentication !== "ON_USE"
  ) {
    throw new Error("Codex marketplace manifest must authenticate App Builder on first use.");
  }
  const codexPluginRoot = join(marketplace, marketplaceManifest.plugins[0].source.path);
  const codexPluginRootStat = await stat(codexPluginRoot);
  if (!codexPluginRootStat.isDirectory()) {
    throw new Error("Codex marketplace source path did not resolve to the packaged plugin.");
  }
  const codexAdapter = codexAdapterSchema.parse(
    JSON.parse(await readFile(join(codexPluginRoot, ".mcp.json"), "utf-8")),
  );
  if (codexAdapter.mcpServers?.["app-builder"]?.url !== `${endpoint}/mcp`) {
    throw new Error("Codex marketplace did not bind the release endpoint.");
  }
  if (codexAdapter.mcpServers?.["app-builder"]?.oauth_resource !== `${endpoint}/mcp`) {
    throw new Error("Codex marketplace did not bind the OAuth resource.");
  }
  const codexManifest = codexManifestSchema.parse(
    JSON.parse(await readFile(join(codexPluginRoot, manifestFilename), "utf-8")),
  );
  const assetReferences = z
    .array(z.string().startsWith("./"))
    .parse(
      [codexManifest.interface?.composerIcon, codexManifest.interface?.logo].filter(
        (reference) => reference !== undefined,
      ),
    );
  await runSequentially(assetReferences, async (reference) => {
    const assetStat = await stat(join(codexPluginRoot, reference));
    if (!assetStat.isFile()) {
      throw new Error(`Codex marketplace omitted referenced asset ${reference}.`);
    }
  });
  const installs = join(temp, "installs");
  await runSequentially(["vscode", "cursor", "codex"], async (client) => {
    await run("install-portable-plugin.mts", [
      "--client",
      client,
      "--source",
      first,
      "--destination",
      installs,
    ]);
  });
  await run("smoke-portable-plugin.mts", ["--release", first, "--install-root", installs]);
  await verifyPortableProofArtifact({
    installRoot: installs,
    releaseRoot: first,
    repositoryRoot: pathResolve("."),
  });

  const mutateReceipt = async (
    name: string,
    mutation: (receipt: z.infer<typeof portableReleaseReceiptSchema>) => void,
  ) => {
    const root = join(temp, `tampered-${name}`);
    await cp(first, root, { recursive: true });
    const path = join(root, receiptFilename);
    const receipt = portableReleaseReceiptSchema.parse(JSON.parse(await readFile(path, "utf-8")));
    mutation(receipt);
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
    await expectRejected(
      async () =>
        await verifyPortableProofArtifact({
          installRoot: installs,
          releaseRoot: root,
          repositoryRoot: pathResolve("."),
        }),
      name,
    );
  };
  await mutateReceipt("unknown receipt key", (receipt) => {
    receipt.unexpected = true;
  });
  await mutateReceipt("source repository drift", (receipt) => {
    receipt.source.repository = `${sourceRepository}.invalid`;
  });
  await mutateReceipt("source SHA drift", (receipt) => {
    receipt.source.sha = "0".repeat(40);
  });
  await mutateReceipt("source tree drift", (receipt) => {
    receipt.source.tree = "0".repeat(40);
  });
  await mutateReceipt("package version drift", (receipt) => {
    receipt.version = "0.1.0";
  });
  await mutateReceipt("archive basename traversal", (receipt) => {
    receipt.archive.name = `../${receipt.archive.name}`;
  });
  await mutateReceipt("marketplace archive digest drift", (receipt) => {
    receipt.codexMarketplaceArchive.sha256 = "0".repeat(64);
  });
  await mutateReceipt("core digest drift", (receipt) => {
    const files = receipt.coreFiles;
    const [path] = Object.keys(files);
    if (!path) throw new Error("Expected core file digest.");
    // SAFETY: The key came from the parsed non-empty receipt inventory.
    files[path] = "0".repeat(64);
  });
  await mutateReceipt("auxiliary digest drift", (receipt) => {
    const files = receipt.auxiliaryFiles;
    const [path] = Object.keys(files);
    if (!path) throw new Error("Expected auxiliary file digest.");
    // SAFETY: The key came from the parsed non-empty receipt inventory.
    files[path] = "0".repeat(64);
  });

  const missingMarketplaceAsset = join(temp, "missing-marketplace-asset");
  await cp(first, missingMarketplaceAsset, { recursive: true });
  const missingAssetArchivePath = join(missingMarketplaceAsset, marketplaceArchiveName);
  const missingAssetFiles = archiveFiles(await readFile(missingAssetArchivePath));
  const missingAssetPath = "plugins/app-builder/assets/autograph-icon.png";
  if (!missingAssetFiles.delete(missingAssetPath)) {
    throw new Error("Expected generated marketplace asset was absent.");
  }
  const missingAssetArchive = deterministicGzip(deterministicTar(missingAssetFiles));
  await writeFile(missingAssetArchivePath, missingAssetArchive);
  const missingAssetReceiptPath = join(missingMarketplaceAsset, receiptFilename);
  const missingAssetReceipt = releaseReceiptSchema.parse(
    JSON.parse(await readFile(missingAssetReceiptPath, "utf-8")),
  );
  missingAssetReceipt.codexMarketplaceArchive.sha256 = sha256(missingAssetArchive);
  await writeFile(missingAssetReceiptPath, `${JSON.stringify(missingAssetReceipt, null, 2)}\n`);
  await expectRejected(
    async () =>
      await verifyPortableProofArtifact({
        installRoot: installs,
        releaseRoot: missingMarketplaceAsset,
        repositoryRoot: pathResolve("."),
      }),
    "marketplace archive with a missing manifest-referenced asset",
  );

  const tamperedMarketplaceAsset = join(temp, "tampered-marketplace-asset");
  await cp(first, tamperedMarketplaceAsset, { recursive: true });
  const tamperedAssetArchivePath = join(tamperedMarketplaceAsset, marketplaceArchiveName);
  const tamperedAssetFiles = archiveFiles(await readFile(tamperedAssetArchivePath));
  tamperedAssetFiles.set(missingAssetPath, Buffer.from("tampered manifest-referenced asset"));
  const tamperedAssetArchive = deterministicGzip(deterministicTar(tamperedAssetFiles));
  await writeFile(tamperedAssetArchivePath, tamperedAssetArchive);
  const tamperedAssetReceiptPath = join(tamperedMarketplaceAsset, receiptFilename);
  const tamperedAssetReceipt = releaseReceiptSchema.parse(
    JSON.parse(await readFile(tamperedAssetReceiptPath, "utf-8")),
  );
  tamperedAssetReceipt.codexMarketplaceArchive.sha256 = sha256(tamperedAssetArchive);
  const tamperedAssetFile = tamperedAssetFiles.get(missingAssetPath);
  if (!tamperedAssetFile) {
    throw new Error("Expected generated marketplace asset was absent.");
  }
  tamperedAssetReceipt.codexMarketplaceAssets[missingAssetPath] = sha256(tamperedAssetFile);
  await writeFile(tamperedAssetReceiptPath, `${JSON.stringify(tamperedAssetReceipt, null, 2)}\n`);
  await expectRejected(
    async () =>
      await verifyPortableProofArtifact({
        installRoot: installs,
        releaseRoot: tamperedMarketplaceAsset,
        repositoryRoot: pathResolve("."),
      }),
    "marketplace archive with tampered manifest-referenced asset bytes and a fully rebound receipt",
  );

  const checkoutDriftRepository = join(temp, "checkout-drift-repository");
  execFileSync(
    "/usr/bin/git",
    ["clone", "--quiet", "--no-hardlinks", pathResolve("."), checkoutDriftRepository],
    {
      env: { LC_ALL: "C", NODE_ENV: "test", PATH: systemPath },
      stdio: "inherit",
    },
  );
  execFileSync(
    "/usr/bin/git",
    [
      "-C",
      checkoutDriftRepository,
      "remote",
      "add",
      "canonical-release",
      "https://github.com/withAutograph/autograph-app-builder.git",
    ],
    {
      env: { LC_ALL: "C", NODE_ENV: "test", PATH: systemPath },
      stdio: "inherit",
    },
  );
  const fullyReboundTreeDrift = join(temp, "fully-rebound-tree-drift");
  await cp(first, fullyReboundTreeDrift, { recursive: true });
  const treeDriftArchivePath = join(fullyReboundTreeDrift, marketplaceArchiveName);
  const treeDriftFiles = archiveFiles(await readFile(treeDriftArchivePath));
  const treeDriftBytes = Buffer.from("fully rebound checkout-drift asset");
  treeDriftFiles.set(missingAssetPath, treeDriftBytes);
  const treeDriftArchive = deterministicGzip(deterministicTar(treeDriftFiles));
  await writeFile(treeDriftArchivePath, treeDriftArchive);
  const treeDriftReceiptPath = join(fullyReboundTreeDrift, receiptFilename);
  const treeDriftReceipt = releaseReceiptSchema.parse(
    JSON.parse(await readFile(treeDriftReceiptPath, "utf-8")),
  );
  treeDriftReceipt.codexMarketplaceArchive.sha256 = sha256(treeDriftArchive);
  treeDriftReceipt.codexMarketplaceAssets[missingAssetPath] = sha256(treeDriftBytes);
  await writeFile(treeDriftReceiptPath, `${JSON.stringify(treeDriftReceipt, null, 2)}\n`);
  await writeFile(join(checkoutDriftRepository, "assets", "autograph-icon.png"), treeDriftBytes);
  await expectRejected(
    async () =>
      await verifyPortableProofArtifact({
        installRoot: installs,
        releaseRoot: fullyReboundTreeDrift,
        repositoryRoot: checkoutDriftRepository,
      }),
    "marketplace archive and receipt rebound to checkout bytes that differ from the receipt tree",
  );

  const archiveTamper = join(temp, "tampered-archive");
  await cp(first, archiveTamper, { recursive: true });
  const archivePath = join(archiveTamper, archiveName);
  await writeFile(archivePath, Buffer.concat([await readFile(archivePath), Buffer.from("tamper")]));
  await expectRejected(
    async () =>
      await verifyPortableProofArtifact({
        installRoot: installs,
        releaseRoot: archiveTamper,
        repositoryRoot: pathResolve("."),
      }),
    "archive contents drift",
  );

  const installedTamper = join(temp, "tampered-installs");
  await cp(installs, installedTamper, { recursive: true });
  const codexHarness = join(installedTamper, "codex", "client-harness.json");
  const harness = harnessSchema.parse(JSON.parse(await readFile(codexHarness, "utf-8")));
  harness.transport.url = "https://wrong.autograph.dev/mcp";
  await writeFile(codexHarness, `${JSON.stringify(harness, null, 2)}\n`);
  await expectRejected(
    async () =>
      await verifyPortableProofArtifact({
        installRoot: installedTamper,
        releaseRoot: first,
        repositoryRoot: pathResolve("."),
      }),
    "installed client adapter drift",
  );
} finally {
  await rm(temp, { force: true, recursive: true });
}
