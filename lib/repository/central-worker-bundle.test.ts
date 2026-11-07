/* oxlint-disable eslint/no-await-in-loop -- Fixture artifacts are written sequentially before packaging. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { assembleCentralWorkerBundle } from "./central-worker-bundle";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const fixture = async (link?: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "central-bundle-"));
  const sourceRoot = path.join(root, "source");
  const artifactRoot = path.join(root, "artifacts");
  await mkdir(sourceRoot);
  await mkdir(path.join(artifactRoot, ".app-builder/central-workers"), { recursive: true });
  const git = (...args: string[]) =>
    // oxlint-disable-next-line sonarjs/no-os-command-from-path -- Invoke installed Git, never repository content.
    execFileSync("git", ["-C", sourceRoot, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  await writeFile(path.join(sourceRoot, "source.ts"), "export const version = 1;\n");
  if (link !== undefined) {
    await symlink(link, path.join(sourceRoot, "link"));
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "source",
  );
  await writeFile(path.join(sourceRoot, ".env.local"), "DO_NOT_COPY=private\n");
  const executable = "#!/usr/bin/env bun\nconsole.log('worker');\n";
  for (const filename of [
    "neon-resource-bootstrap-worker.js",
    "central-integration-bootstrap-worker.js",
    "app-integration-bootstrap-worker.js",
  ]) {
    await writeFile(path.join(artifactRoot, ".app-builder/central-workers", filename), executable, {
      mode: 0o755,
    });
  }
  const files = [
    { mode: "100644", path: "source.ts", sha256: hash("export const version = 1;\n") },
  ];
  if (link !== undefined) {
    files.push({ mode: "120000", path: "link", sha256: hash(link) });
  }
  const receipt = {
    appWorker: { id: "app-integration-bootstrap-v1", sha256: hash(executable) },
    deploymentProfile: "isolated-central-integrations-v1",
    files,
    serviceIds: ["gateway", "integrations"],
    servicesManifestSha256: "a".repeat(64),
    sourceSha: git("rev-parse", "HEAD"),
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    version: 1,
    workers: {
      resources: { id: "neon-resource-bootstrap-v1", sha256: hash(executable) },
      schema: { id: "central-integration-bootstrap-v1", sha256: hash(executable) },
    },
  };
  const raw = `${JSON.stringify(receipt)}\n`;
  await writeFile(path.join(artifactRoot, ".app-builder/central-source-build-receipt.json"), raw);
  return {
    artifactRoot,
    destination: path.join(root, "bundle"),
    receiptSha256: hash(raw),
    reviewedSourceSha: receipt.sourceSha,
    sourceRoot,
  };
};

it("packages tracked Git bytes and exact executable artifacts while excluding local credentials", async () => {
  const input = await fixture("source.ts");
  const result = await assembleCentralWorkerBundle(input);
  expect(result.sourceSha).toBe(input.reviewedSourceSha);
  expect(await readFile(path.join(input.destination, "repository/link"), "utf-8")).toBe(
    "export const version = 1;\n",
  );
  await expect(
    readFile(path.join(input.destination, "repository/.env.local")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(path.join(input.destination, "repository/.git/config")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    JSON.parse(await readFile(path.join(input.destination, "bundle.json"), "utf-8")),
  ).toMatchObject({ receiptSha256: input.receiptSha256 });
  await expect(assembleCentralWorkerBundle(input)).rejects.toMatchObject({ code: "EEXIST" });
});

it("rejects changed source even when a receipt claims the reviewed Git commit", async () => {
  const input = await fixture();
  await writeFile(path.join(input.sourceRoot, "source.ts"), "changed");
  await expect(assembleCentralWorkerBundle(input)).rejects.toThrow(
    "central_bundle_source_bytes_mismatch",
  );
});

it("rejects an archive link that could reach outside the code-only bundle", async () => {
  await expect(assembleCentralWorkerBundle(await fixture("../../credentials"))).rejects.toThrow(
    "central_bundle_link_escape",
  );
});

it("does not stage inside live source through a symlinked destination parent", async () => {
  const input = await fixture();
  const alias = path.join(path.dirname(input.destination), "source-alias");
  await symlink(input.sourceRoot, alias);
  await expect(
    assembleCentralWorkerBundle({ ...input, destination: path.join(alias, "staged") }),
  ).rejects.toThrow("central_bundle_destination_inside_input");
  await expect(readFile(path.join(input.sourceRoot, "staged/bundle.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("requires directly executable worker bytes and the independently pinned receipt", async () => {
  const input = await fixture();
  await expect(
    assembleCentralWorkerBundle({ ...input, receiptSha256: "f".repeat(64) }),
  ).rejects.toThrow("central_bundle_receipt_mismatch");
  await chmod(
    path.join(
      input.artifactRoot,
      ".app-builder/central-workers/app-integration-bootstrap-worker.js",
    ),
    0o644,
  );
  await expect(assembleCentralWorkerBundle(input)).rejects.toThrow(
    "central_bundle_worker_not_executable",
  );
});
