import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
} from "../repository/dependency-cache";
import {
  deterministicGzip,
  deterministicTar,
} from "../../scripts/portable-release";
import { loadStarterSource } from "./starter-source";

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function fixture() {
  const file = new TextEncoder().encode("# Exact starter\n");
  const archive = deterministicGzip(
    deterministicTar(new Map([["README.md", file]])),
  );
  const archiveSha256 = sha256(archive);
  const archiveUrl = `https://releases.example.test/${archiveSha256}.tar.gz`;
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      source: {
        repository: "https://github.com/withAutograph/arrusted-development",
        sha: ARRUSTED_TARGET_SHA,
        tree: ARRUSTED_TARGET_TREE,
      },
      archive: {
        url: archiveUrl,
        sha256: archiveSha256,
        bytes: archive.byteLength,
      },
      files: [
        {
          path: "README.md",
          mode: "100644",
          sha256: sha256(file),
          bytes: file.byteLength,
        },
      ],
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
    const request = vi.fn<typeof fetch>(async (url) =>
      String(url) === value.manifestUrl
        ? new Response(value.manifestBytes)
        : new Response(value.archive),
    );
    const source = await loadStarterSource({
      config: {
        manifestUrl: value.manifestUrl,
        manifestSha256: value.manifestSha256,
      },
      fetch: request,
    });
    expect(source.manifest.source).toEqual({
      repository: "https://github.com/withAutograph/arrusted-development",
      sha: ARRUSTED_TARGET_SHA,
      tree: ARRUSTED_TARGET_TREE,
    });
    expect(source.files).toHaveLength(1);
    expect(new TextDecoder().decode(source.files[0]?.bytes)).toBe(
      "# Exact starter\n",
    );
  });

  it("rejects a mutable URL or mismatched manifest bytes", async () => {
    const value = fixture();
    await expect(
      loadStarterSource({
        config: {
          manifestUrl: "https://releases.example.test/latest.json",
          manifestSha256: value.manifestSha256,
        },
      }),
    ).rejects.toThrow();
    await expect(
      loadStarterSource({
        config: {
          manifestUrl: value.manifestUrl,
          manifestSha256: value.manifestSha256,
        },
        fetch: vi.fn(async () => new Response("tampered")),
      }),
    ).rejects.toThrow("manifest-mismatch");
  });
});
