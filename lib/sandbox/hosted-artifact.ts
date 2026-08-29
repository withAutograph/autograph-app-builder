import { createHash } from "node:crypto";

import {
  HOSTED_ARTIFACT_BASE64,
  HOSTED_ARTIFACT_EMBEDDED_BYTES,
  HOSTED_ARTIFACT_EMBEDDED_SHA256,
} from "./hosted-artifact.generated";

export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_PATH =
  "artifacts/hosted/arrusted-ffa0c34a-preview.tar.gz";
export const HOSTED_ARTIFACT_BYTES = 5_623_242;
export const HOSTED_ARTIFACT_SHA256 =
  "f66bcf6504cd72141f3c6fe683ddf008c88e07c76ef2e308c2cd6681c7731cd4";
export const HOSTED_SOURCE_PATH =
  "/opt/app-builder/hosted-source/arrusted-development";
export const HOSTED_SOURCE_ARCHIVE_SHA256 =
  "c62f35b5811496093bf7f6435eadd8f1822844e6aeea01ac00a9cc38cb1bcf5a";
export const HOSTED_SOURCE_ARCHIVE_BYTES = 4_036_880;
export const HOSTED_SOURCE_ENTRY_COUNT = 1_749;
export const HOSTED_SOURCE_WORKSPACE_DIGEST =
  "3fe09ef0605b9beb3360add82cf9f56d7114330c7c93a16c635de5c524c82a2f";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "03fdbc11d4da690f4361b26b35b7d34b30d439f111d2b3d6721b81cfe3dde2cf";
export const HOSTED_DEPENDENCY_ARCHIVE_SHA256 =
  "d1febde038cc4f84394293e80bf076c944809a3e6cb6485accf67f4af2c4b1ce";
export const HOSTED_DEPENDENCY_ARCHIVE_BYTES = 1_356_765;

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Decodes the server-only embedded asset and rejects generated-byte drift. */
export function readHostedArtifactBytes(): Buffer {
  if (
    HOSTED_ARTIFACT_EMBEDDED_BYTES !== HOSTED_ARTIFACT_BYTES ||
    HOSTED_ARTIFACT_EMBEDDED_SHA256 !== HOSTED_ARTIFACT_SHA256
  )
    throw new Error("The embedded hosted Arrusted artifact is stale.");
  const content = Buffer.from(HOSTED_ARTIFACT_BASE64, "base64");
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
