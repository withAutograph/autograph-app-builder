export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_RELEASE_TAG =
  "hosted-arrusted-ffa0c34a-execution-v3";
export const HOSTED_ARTIFACT_RELEASE_NAME = "arrusted-ffa0c34a-preview.tar.gz";
export const HOSTED_ARTIFACT_URL = `https://github.com/withAutograph/autograph-app-builder/releases/download/${HOSTED_ARTIFACT_RELEASE_TAG}/${HOSTED_ARTIFACT_RELEASE_NAME}`;
export const HOSTED_ARTIFACT_BYTES = 181_139_242;
export const HOSTED_ARTIFACT_SHA256 =
  "c619ed74cc451a9b3ba7424d5f31da11611af0dd2d5f85299d3bbb82c9e3dcf0";
export const HOSTED_SOURCE_PATH =
  "/opt/app-builder/hosted-source/arrusted-development";
export const HOSTED_SOURCE_ARCHIVE_SHA256 =
  "c62f35b5811496093bf7f6435eadd8f1822844e6aeea01ac00a9cc38cb1bcf5a";
export const HOSTED_SOURCE_ARCHIVE_BYTES = 4_036_880;
export const HOSTED_SOURCE_ENTRY_COUNT = 1_749;
export const HOSTED_SOURCE_WORKSPACE_DIGEST =
  "3fe09ef0605b9beb3360add82cf9f56d7114330c7c93a16c635de5c524c82a2f";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "7ad9e12b0ee7a0d6aa0a681600d270d817d92536ebb6fca37d4986093e03350b";
export const HOSTED_DEPENDENCY_ARCHIVE_SHA256 =
  "dcdd38dcdd34a9cd060e021cd71584df039b9a79d6f16fd7e966cf82dd168242";
export const HOSTED_DEPENDENCY_ARCHIVE_BYTES = 177_381_378;

export function hostedExecutionArtifactDigest(): string {
  return `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`;
}
