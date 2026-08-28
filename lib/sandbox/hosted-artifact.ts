import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_PATH =
  "artifacts/hosted/arrusted-2503b6ad-preview.tar.gz";
export const HOSTED_ARTIFACT_BYTES = 5_609_441;
export const HOSTED_ARTIFACT_SHA256 =
  "4d4a68a40aa87c553ff97ec2b3fd1a17be6f475284bdf30d064f90e40b4651aa";
export const HOSTED_SOURCE_PATH =
  "/opt/app-builder/hosted-source/arrusted-development";
export const HOSTED_SOURCE_ARCHIVE_SHA256 =
  "70595eb3e4a923f49120a64e025c913fb8f247dae5392dbd8cb363a466693b36";
export const HOSTED_SOURCE_ARCHIVE_BYTES = 4_023_766;
export const HOSTED_SOURCE_ENTRY_COUNT = 1_744;
export const HOSTED_SOURCE_WORKSPACE_DIGEST =
  "614452877b5271bc9c7c89bf19399a8241267a578987aee605996efd5fb4c57d";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "63190de081cc2388c6d25e1ad526277931d0bf1d814b9256b6459b5112c1651f";
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
