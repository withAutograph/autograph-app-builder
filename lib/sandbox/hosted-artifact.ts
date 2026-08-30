export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_RELEASE_TAG =
  "hosted-arrusted-ffa0c34a-execution-v1";
export const HOSTED_ARTIFACT_RELEASE_NAME = "arrusted-ffa0c34a-preview.tar.gz";
export const HOSTED_ARTIFACT_URL = `https://github.com/withAutograph/autograph-app-builder/releases/download/${HOSTED_ARTIFACT_RELEASE_TAG}/${HOSTED_ARTIFACT_RELEASE_NAME}`;
export const HOSTED_ARTIFACT_BYTES = 152_130_068;
export const HOSTED_ARTIFACT_SHA256 =
  "b60085e4365b1b48f6fd2bc0e59b8c40a36bc47c8f295cef5418c50bd2f4d317";
export const HOSTED_SOURCE_PATH =
  "/opt/app-builder/hosted-source/arrusted-development";
export const HOSTED_SOURCE_ARCHIVE_SHA256 =
  "c62f35b5811496093bf7f6435eadd8f1822844e6aeea01ac00a9cc38cb1bcf5a";
export const HOSTED_SOURCE_ARCHIVE_BYTES = 4_036_880;
export const HOSTED_SOURCE_ENTRY_COUNT = 1_749;
export const HOSTED_SOURCE_WORKSPACE_DIGEST =
  "3fe09ef0605b9beb3360add82cf9f56d7114330c7c93a16c635de5c524c82a2f";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "9ea1b704dca91153c389b27440c2e33a3ae4474bb2bfc8c3749e11be3aea830d";
export const HOSTED_DEPENDENCY_ARCHIVE_SHA256 =
  "fe8d50896ea7a7cb5d7b426d343f53fe196761ac3073874eebb922225933f860";
export const HOSTED_DEPENDENCY_ARCHIVE_BYTES = 148_306_235;

export function hostedExecutionArtifactDigest(): string {
  return `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`;
}
