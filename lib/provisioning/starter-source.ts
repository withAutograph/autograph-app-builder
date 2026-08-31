import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { z } from "zod";

import {
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
} from "../repository/dependency-cache";
import { safeSourcePath } from "../repository/source-path";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const objectId = z.string().regex(/^[0-9a-f]{40}$/u);

export const starterSourceManifestSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        repository: z.literal(
          "https://github.com/withAutograph/arrusted-development",
        ),
        sha: objectId,
        tree: objectId,
      })
      .strict(),
    archive: z
      .object({
        url: z.string().url().startsWith("https://"),
        sha256: digest,
        bytes: z
          .number()
          .int()
          .positive()
          .max(100 * 1024 * 1024),
      })
      .strict(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            mode: z.enum(["100644", "100755"]),
            sha256: digest,
            bytes: z
              .number()
              .int()
              .nonnegative()
              .max(10 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

export type StarterSourceManifest = z.infer<typeof starterSourceManifestSchema>;
export type StarterSourceFile = {
  path: string;
  mode: "100644" | "100755";
  bytes: Uint8Array;
};
export type StarterSourceProvenance = {
  sourceSha: string;
  sourceTree: string;
  repository: string;
  ref: "refs/heads/main";
  method: "git-clone-v1" | "starter-archive-v3";
  readinessDigest?: string;
};
export type StarterSource = {
  /** Present only while recovering a legacy V3 starter acquisition. */
  manifest?: StarterSourceManifest;
  manifestSha256?: string;
  provenance?: StarterSourceProvenance;
  files: readonly StarterSourceFile[];
};

const execFileAsync = promisify(execFile);
const git = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
const MAX_STARTER_FILES = 10_000;
const MAX_STARTER_FILE_BYTES = 10 * 1024 * 1024;

const starterConfigSchema = z
  .object({
    manifestUrl: z.string().url().startsWith("https://"),
    manifestSha256: digest,
  })
  .strict()
  .superRefine((value, context) => {
    if (!new URL(value.manifestUrl).pathname.includes(value.manifestSha256)) {
      context.addIssue({
        code: "custom",
        path: ["manifestUrl"],
        message: "Starter manifest URL must be content addressed.",
      });
    }
  });

export type StarterSourceConfig = z.infer<typeof starterConfigSchema>;

export function readStarterSourceEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): StarterSourceConfig {
  return starterConfigSchema.parse({
    manifestUrl: environment.APP_BUILDER_STARTER_MANIFEST_URL,
    manifestSha256: environment.APP_BUILDER_STARTER_MANIFEST_SHA256,
  });
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedBytes(response: Response, maximum: number) {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximum)
  )
    throw new Error("starter-response-too-large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error("starter-response-too-large");
  return bytes;
}

function tarFiles(archive: Uint8Array) {
  const tar = gunzipSync(archive);
  const files = new Map<
    string,
    { mode: "100644" | "100755"; bytes: Uint8Array }
  >();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/u, "");
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim(),
      8,
    );
    const rawMode = Number.parseInt(
      header.subarray(100, 108).toString("ascii").replace(/\0.*$/u, "").trim(),
      8,
    );
    const type = header[156];
    if (
      !safeSourcePath(path) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      ![0, 48].includes(type) ||
      files.has(path)
    )
      throw new Error("starter-archive-invalid");
    const start = offset + 512;
    const end = start + size;
    if (end > tar.byteLength) throw new Error("starter-archive-invalid");
    files.set(path, {
      mode: rawMode & 0o111 ? "100755" : "100644",
      bytes: new Uint8Array(tar.subarray(start, end)),
    });
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!files.size) throw new Error("starter-archive-invalid");
  return files;
}

export async function loadStarterSource(input: {
  config: StarterSourceConfig;
  fetch?: typeof fetch;
}): Promise<
  StarterSource & {
    manifest: StarterSourceManifest;
    manifestSha256: string;
    provenance: StarterSourceProvenance;
  }
> {
  const config = starterConfigSchema.parse(input.config);
  const request = input.fetch ?? fetch;
  const manifestResponse = await request(config.manifestUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!manifestResponse.ok) throw new Error("starter-manifest-unavailable");
  const manifestBytes = await boundedBytes(manifestResponse, 5 * 1024 * 1024);
  if (sha256(manifestBytes) !== config.manifestSha256)
    throw new Error("starter-manifest-mismatch");
  let manifest: StarterSourceManifest;
  try {
    manifest = starterSourceManifestSchema.parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(manifestBytes),
      ),
    );
  } catch {
    throw new Error("starter-manifest-invalid");
  }
  if (
    manifest.source.sha !== ARRUSTED_TARGET_SHA ||
    manifest.source.tree !== ARRUSTED_TARGET_TREE ||
    !new URL(manifest.archive.url).pathname.includes(manifest.archive.sha256)
  )
    throw new Error("starter-source-mismatch");
  const archiveResponse = await request(manifest.archive.url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!archiveResponse.ok) throw new Error("starter-archive-unavailable");
  const archive = await boundedBytes(archiveResponse, manifest.archive.bytes);
  if (
    archive.byteLength !== manifest.archive.bytes ||
    sha256(archive) !== manifest.archive.sha256
  )
    throw new Error("starter-archive-mismatch");
  const files = tarFiles(archive);
  const expectedPaths = new Set<string>();
  const result = manifest.files.map((entry) => {
    if (!safeSourcePath(entry.path) || expectedPaths.has(entry.path))
      throw new Error("starter-manifest-invalid");
    expectedPaths.add(entry.path);
    const file = files.get(entry.path);
    if (
      !file ||
      file.mode !== entry.mode ||
      file.bytes.byteLength !== entry.bytes ||
      sha256(file.bytes) !== entry.sha256
    )
      throw new Error("starter-file-mismatch");
    return { path: entry.path, mode: entry.mode, bytes: file.bytes };
  });
  if (files.size !== result.length) throw new Error("starter-tree-mismatch");
  return {
    manifest,
    manifestSha256: config.manifestSha256,
    provenance: {
      sourceSha: manifest.source.sha,
      sourceTree: manifest.source.tree,
      repository: manifest.source.repository,
      ref: "refs/heads/main",
      method: "starter-archive-v3",
    },
    files: result,
  };
}

/**
 * Resolves the canonical Arrusted template through the same clone-and-pin
 * transport as fresh App Builder sessions.  The legacy archive loader above
 * remains readable solely for sessions that already recorded a V3 receipt.
 */
export async function cloneStarterSource(): Promise<StarterSource> {
  const { cloneArrustedTemplate } =
    await import("../repository/arrusted-template");
  const clone = await cloneArrustedTemplate();
  try {
    if (clone.receipt.version !== 4)
      throw new Error("starter-source-receipt-version-invalid");
    const listing = await execFileAsync(
      git,
      [
        "-c",
        "protocol.allow=never",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        clone.receipt.sourcePath,
        "ls-files",
        "-z",
      ],
      {
        encoding: "utf8",
        env: {
          NODE_ENV: process.env.NODE_ENV ?? "production",
          PATH: "/usr/bin:/bin",
          HOME: "/dev/null",
          XDG_CONFIG_HOME: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    const paths = listing.stdout.split("\0").filter(Boolean);
    if (paths.length === 0 || paths.length > MAX_STARTER_FILES)
      throw new Error("starter-source-file-count-invalid");
    const files = await Promise.all(
      paths.map(async (path): Promise<StarterSourceFile> => {
        if (!safeSourcePath(path))
          throw new Error("starter-source-path-invalid");
        const filePath = join(clone.receipt.sourcePath, path);
        const stat = await lstat(filePath);
        if (!stat.isFile() || stat.size > MAX_STARTER_FILE_BYTES)
          throw new Error("starter-source-file-invalid");
        return {
          path,
          mode: stat.mode & 0o111 ? "100755" : "100644",
          bytes: await readFile(filePath),
        };
      }),
    );
    return {
      provenance: {
        sourceSha: clone.receipt.sourceSha,
        sourceTree: clone.receipt.sourceTree,
        repository: clone.receipt.provenance.repository,
        ref: clone.receipt.provenance.ref,
        method: clone.receipt.provenance.method,
        readinessDigest: clone.receipt.provenance.readinessDigest,
      },
      files,
    };
  } finally {
    await clone.dispose();
  }
}
