/* oxlint-disable eslint/no-await-in-loop -- Stage one verified file at a time without loading an entire repository into memory. */
/* oxlint-disable react-doctor/async-await-in-loop -- Bound source staging memory and resolve archived links only after the complete graph exists. */
/* oxlint-disable eslint/no-bitwise -- POSIX executable mode bits are the artifact contract. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const worker = (id: string) => z.object({ id: z.literal(id), sha256: digest });
const receiptSchema = z.object({
  appWorker: worker("app-integration-bootstrap-v1"),
  deploymentProfile: z.literal("isolated-central-integrations-v1"),
  files: z.array(
    z.object({ mode: z.enum(["100644", "100755", "120000"]), path: z.string(), sha256: digest }),
  ),
  serviceIds: z.tuple([z.literal("gateway"), z.literal("integrations")]),
  servicesManifestSha256: digest,
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceTree: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.literal(1),
  workers: z.object({
    resources: worker("neon-resource-bootstrap-v1"),
    schema: worker("central-integration-bootstrap-v1"),
  }),
});
const receiptPath = ".app-builder/central-source-build-receipt.json";
const workerPaths = {
  application: ".app-builder/central-workers/app-integration-bootstrap-worker.js",
  resources: ".app-builder/central-workers/neon-resource-bootstrap-worker.js",
  schema: ".app-builder/central-workers/central-integration-bootstrap-worker.js",
} as const;
const safePath = (filename: string) => {
  if (
    filename.includes("\\") ||
    filename.startsWith("/") ||
    filename.includes("\0") ||
    filename.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("central_bundle_invalid_path");
  }
};
const inside = (root: string, filename: string) => {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const git = (root: string, args: string[]) =>
  // The maintainer uses the installed Git executable; no repository-provided command is invoked.
  // oxlint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

type Receipt = z.infer<typeof receiptSchema>;
const readRegularSource = async (root: string, filename: string, executable: boolean) => {
  const state = await lstat(filename);
  if (
    !state.isFile() ||
    ((state.mode & 0o111) !== 0) !== executable ||
    !inside(root, await realpath(filename))
  ) {
    throw new Error("central_bundle_mode_mismatch");
  }
  return await readFile(filename);
};
const verifyStagedLinks = async (
  repository: string,
  links: readonly { filename: string; target: string }[],
) => {
  // Resolve the complete staged graph: lexical normalization alone misses
  // links followed by parent traversal through another archived link.
  for (const link of links) {
    let resolved: string;
    try {
      resolved = await realpath(path.join(repository, link.filename));
    } catch {
      throw new Error("central_bundle_unresolved_link");
    }
    if (!inside(repository, resolved)) {
      throw new Error("central_bundle_link_escape");
    }
  }
};

const copySource = async (
  sourceRoot: string,
  repository: string,
  files: Receipt["files"],
  tree: Map<string, { mode: string; blob: string }>,
) => {
  const links: { filename: string; target: string }[] = [];
  for (const file of files) {
    safePath(file.path);
    const entry = tree.get(file.path);
    if (!entry || entry.mode !== file.mode) {
      throw new Error("central_bundle_inventory_mismatch");
    }
    tree.delete(file.path);
    const from = path.join(sourceRoot, file.path);
    const state = await lstat(from);
    let bytes: Buffer;
    if (file.mode === "120000") {
      if (!state.isSymbolicLink()) {
        throw new Error("central_bundle_mode_mismatch");
      }
      const target = await readlink(from);
      if (
        path.isAbsolute(target) ||
        !inside(repository, path.resolve(repository, path.dirname(file.path), target))
      ) {
        throw new Error("central_bundle_link_escape");
      }
      bytes = Buffer.from(target);
      links.push({ filename: file.path, target });
    } else {
      bytes = await readRegularSource(sourceRoot, from, file.mode === "100755");
    }
    if (
      sha256(bytes) !== file.sha256 ||
      // Git SHA-1 is an additional provenance relation; SHA-256 above pins actual bytes.
      // oxlint-disable-next-line sonarjs/hashing
      createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex") !==
        entry.blob
    ) {
      throw new Error("central_bundle_source_bytes_mismatch");
    }
    if (file.mode !== "120000") {
      const to = path.join(repository, file.path);
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
    }
  }
  for (const link of links) {
    const to = path.join(repository, link.filename);
    await mkdir(path.dirname(to), { recursive: true });
    await symlink(link.target, to);
  }
  await verifyStagedLinks(repository, links);
};

/** Offline release packaging only. Live Builder planning never requires this artifact. */
export const assembleCentralWorkerBundle = async (input: {
  sourceRoot: string;
  artifactRoot: string;
  destination: string;
  reviewedSourceSha: string;
  receiptSha256: string;
}) => {
  digest.parse(input.receiptSha256);
  const [sourceRoot, artifactRoot] = await Promise.all([
    realpath(input.sourceRoot),
    realpath(input.artifactRoot),
  ]);
  const requestedDestination = path.resolve(input.destination);
  const destination = path.join(
    await realpath(path.dirname(requestedDestination)),
    path.basename(requestedDestination),
  );
  if (inside(sourceRoot, destination) || inside(artifactRoot, destination)) {
    throw new Error("central_bundle_destination_inside_input");
  }
  const raw = await readFile(path.join(artifactRoot, receiptPath));
  if (sha256(raw) !== input.receiptSha256) {
    throw new Error("central_bundle_receipt_mismatch");
  }
  const receipt = receiptSchema.parse(JSON.parse(raw.toString("utf-8")));
  if (
    receipt.sourceSha !== input.reviewedSourceSha ||
    git(sourceRoot, ["rev-parse", `${receipt.sourceSha}^{tree}`]).trim() !== receipt.sourceTree
  ) {
    throw new Error("central_bundle_source_mismatch");
  }
  const entries = git(sourceRoot, ["ls-tree", "-rz", "--full-tree", receipt.sourceSha])
    .split("\0")
    .filter(Boolean);
  const tree = new Map(
    entries.map((entry) => {
      const match =
        /^(?<mode>100644|100755|120000) blob (?<blob>[a-f0-9]{40})\t(?<filename>.+)$/su.exec(entry);
      if (!match?.groups) {
        throw new Error("central_bundle_unsupported_git_entry");
      }
      return [match[3], { blob: match[2], mode: match[1] }] as const;
    }),
  );
  if (tree.size !== receipt.files.length) {
    throw new Error("central_bundle_inventory_mismatch");
  }
  // Exclusive staging preserves existing artifacts on failure; no cleanup is inferred.
  await mkdir(destination, { mode: 0o700 });
  const repository = path.join(destination, "repository");
  await mkdir(repository, { mode: 0o700 });
  await copySource(sourceRoot, repository, receipt.files, tree);
  const workers = {
    application: receipt.appWorker,
    resources: receipt.workers.resources,
    schema: receipt.workers.schema,
  };
  for (const name of ["resources", "schema", "application"] as const) {
    const from = path.join(artifactRoot, workerPaths[name]);
    const state = await lstat(from);
    if (
      !state.isFile() ||
      (state.mode & 0o111) === 0 ||
      !inside(artifactRoot, await realpath(from))
    ) {
      throw new Error("central_bundle_worker_not_executable");
    }
    const bytes = await readFile(from);
    if (
      sha256(bytes) !== workers[name].sha256 ||
      !bytes.subarray(0, 19).equals(Buffer.from("#!/usr/bin/env bun\n"))
    ) {
      throw new Error("central_bundle_worker_mismatch");
    }
    const to = path.join(repository, workerPaths[name]);
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, bytes, { flag: "wx", mode: 0o755 });
    await chmod(to, 0o755);
  }
  await writeFile(path.join(repository, receiptPath), raw, { flag: "wx", mode: 0o600 });
  const descriptor = {
    deploymentProfile: receipt.deploymentProfile,
    receiptSha256: input.receiptSha256,
    serviceIds: receipt.serviceIds,
    servicesManifestSha256: receipt.servicesManifestSha256,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    version: 1,
    workers: Object.fromEntries(
      (["resources", "schema", "application"] as const).map((name) => [
        name,
        { ...workers[name], path: workerPaths[name] },
      ]),
    ),
  };
  await writeFile(path.join(destination, "bundle.json"), `${JSON.stringify(descriptor)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return descriptor;
};
