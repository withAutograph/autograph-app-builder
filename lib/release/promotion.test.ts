import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IMAGE_REPOSITORY } from "../image/lifecycle";
import {
  exactCleanGitSource,
  immutableTreeDigest,
  releasePublicationCommands,
  sealPromotionReceipt,
  sha256,
  type PromotionReceiptUnsigned,
  verifyPromotionCandidate,
} from "./promotion";
import { deterministicTar, TOOL_NAMES } from "../../scripts/portable-release";

const digest = "a".repeat(64);
const object = "b".repeat(40);

function unsigned(): PromotionReceiptUnsigned {
  return {
    format: "autograph-release-promotion-v1",
    builder: {
      repository: "https://github.com/withAutograph/autograph-app-builder",
      commit: object,
      tree: "c".repeat(40),
      clean: true,
    },
    arrusted: { commit: "d".repeat(40), tree: "e".repeat(40), clean: true },
    platform: {
      image: "linux/arm64",
      sanitizedSourceEntriesSha256: digest,
      sanitizedSourceEntryCount: 10,
      dockerfileSha256: "1".repeat(64),
      closureSha256: "2".repeat(64),
    },
    endpoint: "https://app-builder.withautograph.com/mcp",
    tools: [
      "autograph_start",
      "autograph_get",
      "autograph_send",
      "autograph_respond",
      "autograph_cancel",
    ],
    package: {
      version: "0.2.4",
      root: "package",
      receipt: "package/release-receipt.json",
      receiptSha256: "3".repeat(64),
      archive: "package/app-builder-0.2.4.tar.gz",
      archiveSha256: "4".repeat(64),
      marketplaceArchive: "package/app-builder-codex-marketplace-0.2.4.tar.gz",
      marketplaceArchiveSha256: "5".repeat(64),
      checksums: "package/SHA256SUMS",
      checksumsSha256: "6".repeat(64),
    },
    image: {
      archive: "image.oci.tar",
      archiveSha256: "7".repeat(64),
      manifestDigest: `sha256:${digest}`,
      reference: `${IMAGE_REPOSITORY}@sha256:${digest}`,
      localTag: `${IMAGE_REPOSITORY}:candidate-${digest.slice(0, 16)}`,
      publicationTag: `${IMAGE_REPOSITORY}:release-${digest.slice(0, 16)}`,
    },
    deployment: {
      root: "deployment",
      outputTreeSha256: "8".repeat(64),
      projectBindingSha256: "9".repeat(64),
    },
    proofs: {
      create: {
        eval: "sandbox-reviewed-change-set",
        terminalPhase: "reviewed",
        browserPreview: true,
        publicationAttempted: false,
        outputSha256: "a".repeat(64),
      },
      iteration: {
        eval: "sandbox-existing-iteration",
        terminalPhase: "reviewed",
        browserPreview: true,
        publicationAttempted: false,
        outputSha256: "b".repeat(64),
      },
    },
    bindings: {
      execution: "release",
      oauth: "hosted",
      endpoint: "deployed",
      marketplace: "release",
      deployment: "production",
    },
  };
}

async function candidate() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "promotion-")));
  await chmod(root, 0o700);
  await mkdir(join(root, "package"), { mode: 0o700 });
  await mkdir(join(root, "deployment/.vercel/output"), {
    recursive: true,
    mode: 0o700,
  });
  const packageArchive = Buffer.from("portable-package");
  const marketplaceArchive = Buffer.from("marketplace-package");
  const checksums = Buffer.from("checksums\n");
  await writeFile(
    join(root, "package/app-builder-0.2.4.tar.gz"),
    packageArchive,
  );
  await writeFile(
    join(root, "package/app-builder-codex-marketplace-0.2.4.tar.gz"),
    marketplaceArchive,
  );
  await writeFile(join(root, "package/SHA256SUMS"), checksums);
  await writeFile(join(root, "deployment/.vercel/output/config.json"), "{}\n");
  const projectBinding = Buffer.from('{"projectId":"prj_test"}\n');
  await writeFile(
    join(root, "deployment/.vercel/project.json"),
    projectBinding,
  );

  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      config: { digest: `sha256:${"1".repeat(64)}` },
      layers: [{ digest: `sha256:${"2".repeat(64)}` }],
    }),
  );
  const manifestDigest = `sha256:${sha256(manifest)}`;
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          digest: manifestDigest,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          platform: { os: "linux", architecture: "arm64" },
        },
      ],
    }),
  );
  const imageArchive = deterministicTar(
    new Map([
      ["index.json", index],
      [`blobs/sha256/${manifestDigest.slice(7)}`, manifest],
    ]),
  );
  await writeFile(join(root, "image.oci.tar"), imageArchive);

  const values = unsigned();
  values.image = {
    archive: "image.oci.tar",
    archiveSha256: sha256(imageArchive),
    manifestDigest,
    reference: `${IMAGE_REPOSITORY}@${manifestDigest}`,
    localTag: `${IMAGE_REPOSITORY}:candidate-${manifestDigest.slice(7, 23)}`,
    publicationTag: `${IMAGE_REPOSITORY}:release-${manifestDigest.slice(7, 23)}`,
  };
  const packageReceipt = {
    format: "autograph-portable-plugin-release-v3",
    specification: "1.0.0",
    name: "app-builder",
    version: "0.2.4",
    source: {
      repository: values.builder.repository,
      sha: values.builder.commit,
      tree: values.builder.tree,
    },
    endpoint: values.endpoint,
    archive: {
      name: "app-builder-0.2.4.tar.gz",
      sha256: sha256(packageArchive),
    },
    codexMarketplaceArchive: {
      name: "app-builder-codex-marketplace-0.2.4.tar.gz",
      sha256: sha256(marketplaceArchive),
    },
    codexMarketplaceAssets: {},
    coreFiles: {},
    auxiliaryFiles: {},
    tools: TOOL_NAMES,
  };
  const packageReceiptBytes = Buffer.from(
    `${JSON.stringify(packageReceipt, null, 2)}\n`,
  );
  await writeFile(
    join(root, "package/release-receipt.json"),
    packageReceiptBytes,
  );
  values.package = {
    ...values.package,
    receiptSha256: sha256(packageReceiptBytes),
    archiveSha256: sha256(packageArchive),
    marketplaceArchiveSha256: sha256(marketplaceArchive),
    checksumsSha256: sha256(checksums),
  };
  values.deployment = {
    root: "deployment",
    outputTreeSha256: await immutableTreeDigest(
      join(root, "deployment/.vercel/output"),
    ),
    projectBindingSha256: sha256(projectBinding),
  };
  await writeFile(
    join(root, "promotion-receipt.json"),
    `${JSON.stringify(sealPromotionReceipt(values), null, 2)}\n`,
  );
  return root;
}

describe("release promotion contract", () => {
  it("seals only exact release bindings and rejects non-release inputs", () => {
    const receipt = sealPromotionReceipt(unsigned());
    expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.tools).toHaveLength(5);
    expect(() =>
      sealPromotionReceipt({
        ...unsigned(),
        endpoint: "http://127.0.0.1:3000/mcp",
      } as never),
    ).toThrow();
    expect(() =>
      sealPromotionReceipt({
        ...unsigned(),
        image: { ...unsigned().image, reference: `${IMAGE_REPOSITORY}:latest` },
      } as never),
    ).toThrow();
    expect(() =>
      sealPromotionReceipt({
        ...unsigned(),
        package: { ...unsigned().package, archive: "/tmp/release.tar.gz" },
      } as never),
    ).toThrow();
    expect(() =>
      sealPromotionReceipt({
        ...unsigned(),
        bindings: { ...unsigned().bindings, endpoint: "loopback" },
      } as never),
    ).toThrow();
  });

  it("publishes only receipt-bound bytes and contains no build command", () => {
    const commands = releasePublicationCommands(
      sealPromotionReceipt(unsigned()),
    );
    expect(commands.map(({ tool }) => tool)).toEqual([
      "docker",
      "docker",
      "docker",
      "vercel",
      "gh",
    ]);
    expect(commands.flatMap(({ args }) => args)).not.toContain("build");
    expect(commands.map(({ tool }) => tool)).not.toContain("buildx");
    expect(commands.at(-2)?.args).toContain("--prebuilt");
    expect(commands.at(-1)?.args).toContain("promotion-receipt.json");
  });

  it("requires clean committed Builder and Arrusted sources", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "release-clean-")),
    );
    await chmod(root, 0o700);
    await writeFile(join(root, "source.txt"), "clean\n");
    const git = (...args: string[]) =>
      execFileSync("/usr/bin/git", args, {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/dev/null",
          LC_ALL: "C",
          NODE_ENV: "test",
        },
      });
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "source",
    );
    await expect(exactCleanGitSource(root, "Arrusted")).resolves.toMatchObject({
      root,
    });
    await writeFile(join(root, "source.txt"), "dirty\n");
    await expect(exactCleanGitSource(root, "Arrusted")).rejects.toThrow(
      "must be clean",
    );
  });

  it("accepts exact candidate bytes and rejects every mutated binding", async () => {
    const valid = await candidate();
    await expect(
      verifyPromotionCandidate({ candidateRoot: valid }),
    ).resolves.toMatchObject({
      root: valid,
    });

    const packageMutation = await candidate();
    await writeFile(
      join(packageMutation, "package/app-builder-0.2.4.tar.gz"),
      "changed",
    );
    await expect(
      verifyPromotionCandidate({ candidateRoot: packageMutation }),
    ).rejects.toThrow("bytes drifted");

    const imageMutation = await candidate();
    await writeFile(join(imageMutation, "image.oci.tar"), "changed");
    await expect(
      verifyPromotionCandidate({ candidateRoot: imageMutation }),
    ).rejects.toThrow("bytes drifted");

    const deploymentMutation = await candidate();
    await writeFile(
      join(deploymentMutation, "deployment/.vercel/output/config.json"),
      '{"changed":true}\n',
    );
    await expect(
      verifyPromotionCandidate({ candidateRoot: deploymentMutation }),
    ).rejects.toThrow("deployment bytes");

    const bindingMutation = await candidate();
    await writeFile(
      join(bindingMutation, "deployment/.vercel/project.json"),
      '{"projectId":"other"}\n',
    );
    await expect(
      verifyPromotionCandidate({ candidateRoot: bindingMutation }),
    ).rejects.toThrow("deployment bytes");

    const receiptMutation = await candidate();
    const receiptPath = join(receiptMutation, "promotion-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      digest: string;
    };
    receipt.digest = "0".repeat(64);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await expect(
      verifyPromotionCandidate({ candidateRoot: receiptMutation }),
    ).rejects.toThrow("digest drifted");
  });
});
