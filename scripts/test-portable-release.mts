import { execFileSync, spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  archiveFiles,
  verifyPortableProofArtifact,
} from "./portable-proof-artifact";
import {
  deterministicGzip,
  deterministicTar,
  sha256,
} from "./portable-release";

const run = (script: string, args: string[], expected = 0) =>
  new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, `scripts/${script}`, ...args],
      { stdio: expected === 0 ? "inherit" : "ignore" },
    );
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === expected
        ? resolveRun()
        : rejectRun(
            new Error(`${script} exited ${code}; expected ${expected}.`),
          ),
    );
  });

const temp = await mkdtemp(join(tmpdir(), "autograph-portable-"));
try {
  const expectRejected = async (
    action: () => Promise<unknown>,
    label: string,
  ) => {
    try {
      await action();
    } catch {
      return;
    }
    throw new Error(`Portable verifier accepted ${label}.`);
  };
  for (const endpoint of [
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
  ])
    await run(
      "build-portable-release.mts",
      [
        "--endpoint",
        endpoint,
        "--output",
        join(temp, `rejected-${Date.now()}`),
      ],
      1,
    );
  const first = join(temp, "release-a");
  const second = join(temp, "release-b");
  const endpoint = "https://mcp.autograph.dev";
  for (const output of [first, second])
    await run("build-portable-release.mts", [
      "--endpoint",
      endpoint,
      "--output",
      output,
    ]);
  const portableManifest = JSON.parse(await readFile("plugin.json", "utf8"));
  const archiveName = `app-builder-${portableManifest.version}.tar.gz`;
  const marketplaceArchiveName = `app-builder-codex-marketplace-${portableManifest.version}.tar.gz`;
  const firstArchive = await readFile(join(first, archiveName));
  const secondArchive = await readFile(join(second, archiveName));
  if (!firstArchive.equals(secondArchive))
    throw new Error("Portable archive is not reproducible.");
  const firstMarketplaceArchive = await readFile(
    join(first, marketplaceArchiveName),
  );
  const secondMarketplaceArchive = await readFile(
    join(second, marketplaceArchiveName),
  );
  if (!firstMarketplaceArchive.equals(secondMarketplaceArchive))
    throw new Error("Codex marketplace archive is not reproducible.");
  const firstReceipt = JSON.parse(
    await readFile(join(first, "release-receipt.json"), "utf8"),
  );
  const secondReceipt = JSON.parse(
    await readFile(join(second, "release-receipt.json"), "utf8"),
  );
  if (JSON.stringify(firstReceipt) !== JSON.stringify(secondReceipt))
    throw new Error("Portable release receipt is not reproducible.");
  if (
    firstReceipt.source.repository !==
      "https://github.com/withAutograph/autograph-app-builder" ||
    !/^[0-9a-f]{40}$/u.test(firstReceipt.source.sha) ||
    !/^[0-9a-f]{40}$/u.test(firstReceipt.source.tree)
  )
    throw new Error("Portable release was not bound to an immutable source.");
  const extracted = join(temp, "extracted");
  await mkdir(extracted);
  execFileSync(
    "/usr/bin/tar",
    ["-xzf", join(first, archiveName), "-C", extracted],
    {
      stdio: "inherit",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
    },
  );
  await run("validate-plugin.mts", [
    "--root",
    join(extracted, "app-builder"),
    "--artifact",
    "--release",
  ]);
  const marketplace = join(temp, "codex-marketplace");
  await mkdir(marketplace);
  execFileSync(
    "/usr/bin/tar",
    ["-xzf", join(first, marketplaceArchiveName), "-C", marketplace],
    {
      stdio: "inherit",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
    },
  );
  const marketplaceManifest = JSON.parse(
    await readFile(
      join(marketplace, ".agents/plugins/marketplace.json"),
      "utf8",
    ),
  );
  if (
    marketplaceManifest.name !== "autograph" ||
    marketplaceManifest.plugins?.[0]?.source?.path !== "./plugins/app-builder" ||
    marketplaceManifest.plugins?.[0]?.policy?.authentication !== "ON_USE"
  )
    throw new Error(
      "Codex marketplace manifest must authenticate App Builder on first use.",
    );
  const codexPluginRoot = join(
    marketplace,
    marketplaceManifest.plugins[0].source.path,
  );
  if (!(await stat(codexPluginRoot)).isDirectory())
    throw new Error(
      "Codex marketplace source path did not resolve to the packaged plugin.",
    );
  const codexAdapter = JSON.parse(
    await readFile(join(codexPluginRoot, ".mcp.json"), "utf8"),
  );
  if (codexAdapter.mcpServers?.["app-builder"]?.url !== `${endpoint}/mcp`)
    throw new Error("Codex marketplace did not bind the release endpoint.");
  const codexManifest = JSON.parse(
    await readFile(join(codexPluginRoot, ".codex-plugin/plugin.json"), "utf8"),
  );
  for (const reference of [
    codexManifest.interface?.composerIcon,
    codexManifest.interface?.logo,
  ]) {
    if (typeof reference !== "string" || !reference.startsWith("./"))
      throw new Error("Codex marketplace asset reference was invalid.");
    if (!(await stat(join(codexPluginRoot, reference))).isFile())
      throw new Error(
        `Codex marketplace omitted referenced asset ${reference}.`,
      );
  }
  const installs = join(temp, "installs");
  for (const client of ["vscode", "cursor", "codex"])
    await run("install-portable-plugin.mts", [
      "--client",
      client,
      "--source",
      first,
      "--destination",
      installs,
    ]);
  await run("smoke-portable-plugin.mts", [
    "--release",
    first,
    "--install-root",
    installs,
  ]);
  await verifyPortableProofArtifact({
    releaseRoot: first,
    installRoot: installs,
    repositoryRoot: resolve("."),
  });

  const mutateReceipt = async (
    name: string,
    mutation: (receipt: Record<string, unknown>) => void,
  ) => {
    const root = join(temp, `tampered-${name}`);
    await cp(first, root, { recursive: true });
    const path = join(root, "release-receipt.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    mutation(receipt);
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
    await expectRejected(
      () =>
        verifyPortableProofArtifact({
          releaseRoot: root,
          installRoot: installs,
          repositoryRoot: resolve("."),
        }),
      name,
    );
  };
  await mutateReceipt("unknown receipt key", (receipt) => {
    receipt.unexpected = true;
  });
  await mutateReceipt("source repository drift", (receipt) => {
    (receipt.source as { repository: string }).repository =
      "https://github.com/example/wrong";
  });
  await mutateReceipt("source SHA drift", (receipt) => {
    (receipt.source as { sha: string }).sha = "0".repeat(40);
  });
  await mutateReceipt("source tree drift", (receipt) => {
    (receipt.source as { tree: string }).tree = "0".repeat(40);
  });
  await mutateReceipt("package version drift", (receipt) => {
    receipt.version = "0.1.0";
  });
  await mutateReceipt("archive basename traversal", (receipt) => {
    const archive = receipt.archive as { name: string };
    archive.name = `../${archive.name}`;
  });
  await mutateReceipt("marketplace archive digest drift", (receipt) => {
    const marketplaceArchive = receipt.codexMarketplaceArchive as {
      sha256: string;
    };
    marketplaceArchive.sha256 = "0".repeat(64);
  });
  await mutateReceipt("core digest drift", (receipt) => {
    const files = receipt.coreFiles as Record<string, string>;
    const path = Object.keys(files)[0];
    files[path] = "0".repeat(64);
  });
  await mutateReceipt("auxiliary digest drift", (receipt) => {
    const files = receipt.auxiliaryFiles as Record<string, string>;
    const path = Object.keys(files)[0];
    files[path] = "0".repeat(64);
  });

  const missingMarketplaceAsset = join(temp, "missing-marketplace-asset");
  await cp(first, missingMarketplaceAsset, { recursive: true });
  const missingAssetArchivePath = join(
    missingMarketplaceAsset,
    marketplaceArchiveName,
  );
  const missingAssetFiles = archiveFiles(
    await readFile(missingAssetArchivePath),
  );
  const missingAssetPath = "plugins/app-builder/assets/autograph-icon.png";
  if (!missingAssetFiles.delete(missingAssetPath))
    throw new Error("Expected generated marketplace asset was absent.");
  const missingAssetArchive = deterministicGzip(
    deterministicTar(missingAssetFiles),
  );
  await writeFile(missingAssetArchivePath, missingAssetArchive);
  const missingAssetReceiptPath = join(
    missingMarketplaceAsset,
    "release-receipt.json",
  );
  const missingAssetReceipt = JSON.parse(
    await readFile(missingAssetReceiptPath, "utf8"),
  );
  missingAssetReceipt.codexMarketplaceArchive.sha256 =
    sha256(missingAssetArchive);
  await writeFile(
    missingAssetReceiptPath,
    `${JSON.stringify(missingAssetReceipt, null, 2)}\n`,
  );
  await expectRejected(
    () =>
      verifyPortableProofArtifact({
        releaseRoot: missingMarketplaceAsset,
        installRoot: installs,
        repositoryRoot: resolve("."),
      }),
    "marketplace archive with a missing manifest-referenced asset",
  );

  const tamperedMarketplaceAsset = join(temp, "tampered-marketplace-asset");
  await cp(first, tamperedMarketplaceAsset, { recursive: true });
  const tamperedAssetArchivePath = join(
    tamperedMarketplaceAsset,
    marketplaceArchiveName,
  );
  const tamperedAssetFiles = archiveFiles(
    await readFile(tamperedAssetArchivePath),
  );
  tamperedAssetFiles.set(
    missingAssetPath,
    Buffer.from("tampered manifest-referenced asset"),
  );
  const tamperedAssetArchive = deterministicGzip(
    deterministicTar(tamperedAssetFiles),
  );
  await writeFile(tamperedAssetArchivePath, tamperedAssetArchive);
  const tamperedAssetReceiptPath = join(
    tamperedMarketplaceAsset,
    "release-receipt.json",
  );
  const tamperedAssetReceipt = JSON.parse(
    await readFile(tamperedAssetReceiptPath, "utf8"),
  );
  tamperedAssetReceipt.codexMarketplaceArchive.sha256 =
    sha256(tamperedAssetArchive);
  tamperedAssetReceipt.codexMarketplaceAssets[missingAssetPath] = sha256(
    tamperedAssetFiles.get(missingAssetPath)!,
  );
  await writeFile(
    tamperedAssetReceiptPath,
    `${JSON.stringify(tamperedAssetReceipt, null, 2)}\n`,
  );
  await expectRejected(
    () =>
      verifyPortableProofArtifact({
        releaseRoot: tamperedMarketplaceAsset,
        installRoot: installs,
        repositoryRoot: resolve("."),
      }),
    "marketplace archive with tampered manifest-referenced asset bytes and a fully rebound receipt",
  );

  const checkoutDriftRepository = join(temp, "checkout-drift-repository");
  execFileSync(
    "/usr/bin/git",
    [
      "clone",
      "--quiet",
      "--no-hardlinks",
      resolve("."),
      checkoutDriftRepository,
    ],
    {
      stdio: "inherit",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
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
      stdio: "inherit",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", NODE_ENV: "test" },
    },
  );
  const fullyReboundTreeDrift = join(temp, "fully-rebound-tree-drift");
  await cp(first, fullyReboundTreeDrift, { recursive: true });
  const treeDriftArchivePath = join(
    fullyReboundTreeDrift,
    marketplaceArchiveName,
  );
  const treeDriftFiles = archiveFiles(await readFile(treeDriftArchivePath));
  const treeDriftBytes = Buffer.from("fully rebound checkout-drift asset");
  treeDriftFiles.set(missingAssetPath, treeDriftBytes);
  const treeDriftArchive = deterministicGzip(deterministicTar(treeDriftFiles));
  await writeFile(treeDriftArchivePath, treeDriftArchive);
  const treeDriftReceiptPath = join(
    fullyReboundTreeDrift,
    "release-receipt.json",
  );
  const treeDriftReceipt = JSON.parse(
    await readFile(treeDriftReceiptPath, "utf8"),
  );
  treeDriftReceipt.codexMarketplaceArchive.sha256 = sha256(treeDriftArchive);
  treeDriftReceipt.codexMarketplaceAssets[missingAssetPath] =
    sha256(treeDriftBytes);
  await writeFile(
    treeDriftReceiptPath,
    `${JSON.stringify(treeDriftReceipt, null, 2)}\n`,
  );
  await writeFile(
    join(checkoutDriftRepository, "assets", "autograph-icon.png"),
    treeDriftBytes,
  );
  await expectRejected(
    () =>
      verifyPortableProofArtifact({
        releaseRoot: fullyReboundTreeDrift,
        installRoot: installs,
        repositoryRoot: checkoutDriftRepository,
      }),
    "marketplace archive and receipt rebound to checkout bytes that differ from the receipt tree",
  );

  const archiveTamper = join(temp, "tampered-archive");
  await cp(first, archiveTamper, { recursive: true });
  const archivePath = join(archiveTamper, archiveName);
  await writeFile(
    archivePath,
    Buffer.concat([await readFile(archivePath), Buffer.from("tamper")]),
  );
  await expectRejected(
    () =>
      verifyPortableProofArtifact({
        releaseRoot: archiveTamper,
        installRoot: installs,
        repositoryRoot: resolve("."),
      }),
    "archive contents drift",
  );

  const installedTamper = join(temp, "tampered-installs");
  await cp(installs, installedTamper, { recursive: true });
  const codexHarness = join(installedTamper, "codex", "client-harness.json");
  const harness = JSON.parse(await readFile(codexHarness, "utf8"));
  harness.transport.url = "https://wrong.autograph.dev/mcp";
  await writeFile(codexHarness, `${JSON.stringify(harness, null, 2)}\n`);
  await expectRejected(
    () =>
      verifyPortableProofArtifact({
        releaseRoot: first,
        installRoot: installedTamper,
        repositoryRoot: resolve("."),
      }),
    "installed client adapter drift",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
