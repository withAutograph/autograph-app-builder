export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_RELEASE_TAG =
  "hosted-arrusted-d378904a-execution-v4";
export const HOSTED_ARTIFACT_RELEASE_NAME = "arrusted-d378904a-preview.tar.gz";
export const HOSTED_ARTIFACT_URL = `https://github.com/withAutograph/autograph-app-builder/releases/download/${HOSTED_ARTIFACT_RELEASE_TAG}/${HOSTED_ARTIFACT_RELEASE_NAME}`;
export const HOSTED_ARTIFACT_BYTES = 180_168_876;
export const HOSTED_ARTIFACT_SHA256 =
  "0fa5754204b55a8c67232892c78a1e70f89f95633e48d79158ce1bbbb6cc91cb";
export const HOSTED_SOURCE_PATH =
  "/opt/app-builder/hosted-source/arrusted-development";
export const HOSTED_SOURCE_ARCHIVE_SHA256 =
  "b8094adda43c73e3107dc6cf413861c0080a5ac8cc5045249a05990e3c799e44";
export const HOSTED_SOURCE_ARCHIVE_BYTES = 4_037_050;
export const HOSTED_SOURCE_ENTRY_COUNT = 1_749;
export const HOSTED_SOURCE_WORKSPACE_DIGEST =
  "ee6eb2e560b4bf3f4cd0faff390fa4c7d1787e865e96fd78752cc50df5bed025";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "aa50cf4f027396908bcd6600a475bb3f1a98409cd0019279938585dfaa50a43c";
export const HOSTED_DEPENDENCY_ARCHIVE_SHA256 =
  "7ae0a108f9e0ec7e01f8624a058a0afc1056fa6f2a74925e6ab6fcff7819d6e6";
export const HOSTED_DEPENDENCY_ARCHIVE_BYTES = 176_411_280;

export function hostedExecutionArtifactDigest(): string {
  return `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`;
}
