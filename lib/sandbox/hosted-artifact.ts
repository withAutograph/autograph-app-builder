export const HOSTED_ARTIFACT_CONTRACT_VERSION = 1;
export const HOSTED_ARTIFACT_RELEASE_TAG =
  "hosted-arrusted-d378904a-execution-v6";
export const HOSTED_ARTIFACT_RELEASE_NAME =
  "arrusted-d378904a-dependencies.tar.gz";
export const HOSTED_ARTIFACT_URL = `https://github.com/withAutograph/autograph-app-builder/releases/download/${HOSTED_ARTIFACT_RELEASE_TAG}/${HOSTED_ARTIFACT_RELEASE_NAME}`;
export const HOSTED_ARTIFACT_BYTES = 175_953_869;
export const HOSTED_ARTIFACT_SHA256 =
  "8aefedfc45c733c99e7d3ceb1e31b0174853411f2c2560490337b58cfa51376d";
export const HOSTED_DEPENDENCY_MANIFEST_SHA256 =
  "8314084383dd4c1dace70d794266605860d137a3e48ccdbc98c0de2b673a094a";
export const HOSTED_DEPENDENCY_ARCHIVE_SHA256 =
  "419ee6e19631b147b6b014942c060528dcef02a8e34fc7ab28615c16ef6ebefa";
export const HOSTED_DEPENDENCY_ARCHIVE_BYTES = 176_461_350;

export function hostedExecutionArtifactDigest(): string {
  return `vercel-sandbox-seed@sha256:${HOSTED_ARTIFACT_SHA256}`;
}
