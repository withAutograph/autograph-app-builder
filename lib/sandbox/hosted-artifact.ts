export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_RELEASE_TAG =
  "hosted-arrusted-d378904a-execution-v4";
export const HOSTED_ARTIFACT_RELEASE_NAME = "arrusted-d378904a-preview.tar.gz";
export const HOSTED_ARTIFACT_URL = `https://github.com/withAutograph/autograph-app-builder/releases/download/${HOSTED_ARTIFACT_RELEASE_TAG}/${HOSTED_ARTIFACT_RELEASE_NAME}`;
export const HOSTED_ARTIFACT_BYTES = 180_168_876;
export const HOSTED_ARTIFACT_SHA256 =
  "0fa5754204b55a8c67232892c78a1e70f89f95633e48d79158ce1bbbb6cc91cb";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "aa50cf4f027396908bcd6600a475bb3f1a98409cd0019279938585dfaa50a43c";
export const HOSTED_DEPENDENCY_ARCHIVE_SHA256 =
  "7ae0a108f9e0ec7e01f8624a058a0afc1056fa6f2a74925e6ab6fcff7819d6e6";
export const HOSTED_DEPENDENCY_ARCHIVE_BYTES = 176_411_280;

export function hostedExecutionArtifactDigest(): string {
  return `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`;
}
