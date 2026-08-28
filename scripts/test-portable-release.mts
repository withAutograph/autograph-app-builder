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

import { verifyPortableProofArtifact } from "./portable-proof-artifact";

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
  const archiveName = `autograph-app-builder-${portableManifest.version}.tar.gz`;
  const marketplaceArchiveName = `autograph-app-builder-codex-marketplace-${portableManifest.version}.tar.gz`;
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
    join(extracted, "autograph-app-builder"),
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
    marketplaceManifest.plugins?.[0]?.source?.path !==
      "./plugins/autograph-app-builder"
  )
    throw new Error("Codex marketplace manifest was invalid.");
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
  if (
    codexAdapter.mcpServers?.["autograph-app-builder"]?.url !==
    `${endpoint}/mcp`
  )
    throw new Error("Codex marketplace did not bind the release endpoint.");
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
