import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_PATH =
  "artifacts/hosted/arrusted-77dce488-preview.tar.gz";
export const HOSTED_ARTIFACT_BYTES = 5_615_040;
export const HOSTED_ARTIFACT_SHA256 =
  "8196a1d53669fcf304e70c2be315bdf29b49d49e081066b073769b086b8088ad";
export const HOSTED_SOURCE_PATH =
  "/opt/app-builder/hosted-source/arrusted-development";
export const HOSTED_SOURCE_ARCHIVE_SHA256 =
  "83a8cdf7b869068a550dc5ec82739a9a0981bcc04df76a4db3eebc790eaaf544";
export const HOSTED_SOURCE_ARCHIVE_BYTES = 4_029_085;
export const HOSTED_SOURCE_ENTRY_COUNT = 1_746;
export const HOSTED_SOURCE_WORKSPACE_DIGEST =
  "e532db0da48c072199dab37b0ab06bead8160e66d4f3905adfc3954eec59dbe1";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "c19bdf85e8be9b783ec670ce4036f3e868490fd23d0272678364e09baaac34a5";
export const HOSTED_DEPENDENCY_ARCHIVE_SHA256 =
  "d1febde038cc4f84394293e80bf076c944809a3e6cb6485accf67f4af2c4b1ce";
export const HOSTED_DEPENDENCY_ARCHIVE_BYTES = 1_356_765;

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Reads the server-only deployment asset and rejects tracing or byte drift. */
export function readHostedArtifactBytes(): Buffer {
  const content = readFileSync(join(process.cwd(), HOSTED_ARTIFACT_PATH));
  if (
    content.byteLength !== HOSTED_ARTIFACT_BYTES ||
    sha256(content) !== HOSTED_ARTIFACT_SHA256
  )
    throw new Error("The hosted Arrusted artifact is missing or drifted.");
  return content;
}

export function hostedExecutionArtifactDigest(): string {
  return `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`;
}
