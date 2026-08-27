import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_PATH =
  "artifacts/hosted/arrusted-c9a5faf2-preview.tar.gz";
export const HOSTED_ARTIFACT_BYTES = 5_490_966;
export const HOSTED_ARTIFACT_SHA256 =
  "26c40cc2313bbe2e14e1e1675cd44cc0f61958dfff08491ea5cb3fae1a51600d";
export const HOSTED_SOURCE_PATH =
  "/opt/app-builder/hosted-source/arrusted-development";
export const HOSTED_SOURCE_ARCHIVE_SHA256 =
  "728dd05b23de874080ec8d795249a6350db472571bbd1bb9629d520e6263a7ef";
export const HOSTED_SOURCE_ARCHIVE_BYTES = 3_923_701;
export const HOSTED_SOURCE_ENTRY_COUNT = 1_713;
export const HOSTED_SOURCE_WORKSPACE_DIGEST =
  "a825a753e9d64ff9c70d62daf3b9518b8cea523f1663c17d15e86ede4e2ac46b";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "b85e7c3bc83685a10f7ccf372e0f074371977a62d1dbd726a7e0df9bdc2e7ef6";
export const HOSTED_DEPENDENCY_ARCHIVE_SHA256 =
  "c5820c64cdd4961a2f8a2ca1b0f73a615d9c938c87b5a8c2276dba59fd843afa";
export const HOSTED_DEPENDENCY_ARCHIVE_BYTES = 1_343_984;

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
