import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ARRUSTED_TARGET_SHA, ARRUSTED_TARGET_TREE } from "../repository/dependency-cache";
import { deterministicGzip, deterministicTar } from "../../scripts/portable-release";
import {
  cloneStarterSource,
  loadStarterSource,
  starterSourceManifestSchema,
} from "./starter-source";

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function fixture() {
  const file = new TextEncoder().encode("# Exact starter\n");
  const archive = deterministicGzip(deterministicTar(new Map([["README.md", file]])));
  const archiveSha256 = sha256(archive);
  const archiveUrl = `https://releases.example.test/${archiveSha256}.tar.gz`;
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      archive: {
        bytes: archive.byteLength,
        sha256: archiveSha256,
        url: archiveUrl,
      },
      files: [
        {
          bytes: file.byteLength,
          mode: "100644",
          path: "README.md",
          sha256: sha256(file),
        },
      ],
      source: {
        repository: "https://github.com/withAutograph/arrusted-development",
        sha: ARRUSTED_TARGET_SHA,
        tree: ARRUSTED_TARGET_TREE,
      },
      version: 1,
    }),
  );
  const manifestSha256 = sha256(manifestBytes);
  return {
    archive,
    archiveUrl,
    manifestBytes,
    manifestSha256,
    manifestUrl: `https://releases.example.test/${manifestSha256}.json`,
  };
}

describe("immutable Arrusted starter source", () => {
  it("verifies the content-addressed manifest, archive, and exact file inventory", async () => {
    const value = fixture();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const request = vi.fn<typeof fetch>(async (url) =>
      String(url) === value.manifestUrl
        ? new Response(value.manifestBytes)
        : new Response(value.archive),
    );
    const source = await loadStarterSource({
      config: {
        manifestSha256: value.manifestSha256,
        manifestUrl: value.manifestUrl,
      },
      fetch: request,
    });
    expect(source.manifest.source).toEqual({
      repository: "https://github.com/withAutograph/arrusted-development",
      sha: ARRUSTED_TARGET_SHA,
      tree: ARRUSTED_TARGET_TREE,
    });
    expect(source.files).toHaveLength(1);
    expect(new TextDecoder().decode(source.files[0]?.bytes)).toBe("# Exact starter\n");
  });

  it("rejects a mutable URL or mismatched manifest bytes", async () => {
    const value = fixture();
    await expect(
      loadStarterSource({
        config: {
          manifestSha256: value.manifestSha256,
          manifestUrl: "https://releases.example.test/latest.json",
        },
      }),
    ).rejects.toThrow();
    await expect(
      loadStarterSource({
        config: {
          manifestSha256: value.manifestSha256,
          manifestUrl: value.manifestUrl,
        },
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        fetch: vi.fn(async () => new Response("tampered")),
      }),
    ).rejects.toThrow("manifest-mismatch");
  });

  it("does not impose starter archive, file, or inventory size ceilings", () => {
    const value = fixture();
    const parsed = starterSourceManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(value.manifestBytes)),
    );
    const manifest = {
      ...parsed,
      archive: { ...parsed.archive, bytes: 101 * 1024 * 1024 },
      files: Array.from({ length: 10_001 }, (_, index) => ({
        bytes: 11 * 1024 * 1024,
        mode: "100644",
        path: `large-inventory/${index}.txt`,
        sha256: "0".repeat(64),
      })),
    };
    expect(starterSourceManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("accepts long relative paths for the filesystem to validate", () => {
    const value = fixture();
    const manifest = starterSourceManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(value.manifestBytes)),
    );
    expect(
      starterSourceManifestSchema.safeParse({
        ...manifest,
        files: [{ ...manifest.files[0], path: `nested/${"a".repeat(600)}.txt` }],
      }).success,
    ).toBe(true);
  });

  it("forwards caller cancellation without imposing an internal fetch deadline", async () => {
    const value = fixture();
    const controller = new AbortController();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning fetch test double
    const request = vi.fn<typeof fetch>(async (url) =>
      String(url) === value.manifestUrl
        ? new Response(value.manifestBytes)
        : new Response(value.archive),
    );
    await loadStarterSource({
      config: { manifestSha256: value.manifestSha256, manifestUrl: value.manifestUrl },
      fetch: request,
      signal: controller.signal,
    });
    expect(request.mock.calls.map((call) => call[1]?.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
  });
});

describe("source-only starter clone", () => {
  it("clones real Git source with rearranged internals and no template check evidence", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "builder-source-only-test-"));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No check evidence available"));
    try {
      const repository = nodePath.join(root, "upstream");
      await mkdir(nodePath.join(repository, "tools"), { recursive: true });
      await writeFile(nodePath.join(repository, "README.md"), "Rearranged starter\n");
      await writeFile(
        nodePath.join(repository, "tools", "create-app.ts"),
        "// repository owns commands\n",
      );
      const git = (args: string[]) =>
        execFileSync(
          "/usr/bin/git",
          ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
          { cwd: repository, encoding: "utf-8" },
        ).trim();
      git(["init", "-b", "main"]);
      git(["add", "."]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "fixture",
      ]);
      const source = await cloneStarterSource({
        git: async (args) =>
          await Promise.resolve({
            stdout: execFileSync(
              "/usr/bin/git",
              [
                "-c",
                `url.file://${repository}.insteadOf=https://github.com/withAutograph/arrusted-development.git`,
                "-c",
                "protocol.file.allow=always",
                "-c",
                "core.hooksPath=/dev/null",
                ...args,
              ],
              { encoding: "utf-8" },
            ),
          }),
        reader: { acquire: async () => await Promise.resolve({ token: "fixture-only-token" }) },
      });
      expect(source.files.map((file) => file.path)).toEqual(["README.md", "tools/create-app.ts"]);
      expect(source.provenance).toMatchObject({
        receiptVersion: 5,
        sourceSha: git(["rev-parse", "HEAD"]),
        sourceTree: git(["rev-parse", "HEAD^{tree}"]),
      });
      expect(source.provenance).toHaveProperty("sourceDigest");
      expect(source.provenance).not.toHaveProperty("readinessDigest");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      await rm(root, { force: true, recursive: true });
    }
  });
});
