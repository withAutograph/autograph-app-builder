import { createHash } from "node:crypto";
import {
  applicationSourceArtifactSchema,
  applicationSourceManifestSchema,
} from "./application-source-contract";
import type { ApplicationSourceManifest } from "./application-source-contract";

export const applicationSourceManifestDigest = (manifest: ApplicationSourceManifest): string =>
  createHash("sha256")
    .update(JSON.stringify(applicationSourceManifestSchema.parse(manifest)))
    .digest("hex");

/** Source integrity only: no journal, identity, destination or approval authority is imported. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Untrusted uploaded artifact bytes are parsed immediately at this I/O boundary.
export const validateApplicationSourceArtifact = (input: unknown) => {
  const artifact = applicationSourceArtifactSchema.parse(input);
  const byPath = new Map(artifact.files.map((file) => [file.path, file]));
  if (byPath.size !== artifact.files.length || byPath.size !== artifact.manifest.files.length) {
    throw new Error("Application source file inventory mismatch");
  }
  const files = artifact.manifest.files.map((entry) => {
    const file = byPath.get(entry.path);
    if (
      !file ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.contentBase64)
    ) {
      throw new Error("Application source bytes are unavailable");
    }
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (
      bytes.toString("base64") !== file.contentBase64 ||
      bytes.byteLength !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    ) {
      throw new Error("Application source byte digest mismatch");
    }
    return { bytes, mode: entry.mode, path: entry.path };
  });
  return { artifact, files, manifestDigest: applicationSourceManifestDigest(artifact.manifest) };
};
