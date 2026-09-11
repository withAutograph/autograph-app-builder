import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  deterministicGzip,
  deterministicTar,
} from "../../scripts/portable-release";
import {
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
} from "../repository/dependency-cache";
import { loadStarterSource } from "./starter-source";

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function fixture() {
  const file = new TextEncoder().encode("# Exact starter\n");
  const archive = deterministicGzip(
    deterministicTar(new Map([["README.md", file]]))
  );
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
          path: "README.md",
          mode: "100644",
          sha256: sha256(file),
          bytes: file.byteLength,
        },
      ],
      source: {
        repository: "https://github.com/withAutograph/arrusted-development",
        sha: ARRUSTED_TARGET_SHA,
        tree: ARRUSTED_TARGET_TREE,
      },
      version: 1,
    })
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
        : new Response(value.archive)
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
    expect(new TextDecoder().decode(source.files[0]?.bytes)).toBe(
      "# Exact starter\n"
    );
  });

  it("rejects a mutable URL or mismatched manifest bytes", async () => {
    const value = fixture();
    await expect(
      loadStarterSource({
        config: {
          manifestSha256: value.manifestSha256,
          manifestUrl: "https://releases.example.test/latest.json",
        },
      })
    ).rejects.toThrow();
    await expect(
      loadStarterSource({
        config: {
          manifestSha256: value.manifestSha256,
          manifestUrl: value.manifestUrl,
        },
        fetch: vi.fn(async () => new Response("tampered")),
      })
    ).rejects.toThrow("manifest-mismatch");
  });
});
