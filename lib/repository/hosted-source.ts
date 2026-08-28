import type { SandboxSession } from "eve/sandbox";

import {
  SOURCE_RECEIPT_VERSION,
  parseSourceReceipt,
  type SourceKind,
  type SourceReceipt,
} from "./source-receipt";
import {
  SUPPORTED_TEMPLATE_ADAPTER,
  prepareFixedHostedSandboxWorkspace,
} from "./supported-template";
import {
  HOSTED_SOURCE_PATH,
  HOSTED_SOURCE_WORKSPACE_DIGEST,
} from "../sandbox/hosted-artifact";
import { isHostedVercelRuntime } from "../sandbox/backend";
import { ARRUSTED_TARGET_SHA, ARRUSTED_TARGET_TREE } from "./dependency-cache";
import { readHostedDeploymentEnvironment } from "../hosted/deployment-environment";

export const HOSTED_ELIGIBILITY_DIGEST =
  "f22626d877869ba98ace18b29c60b54a8ef9f968c00a6d9de09d40f662b139f7";
export const HOSTED_CONTRACT_DIGEST =
  "efbd1f6d233e2d8f5972e80920af76974f465820fad118bcb6b40448537ec73a";
export const HOSTED_SOURCE_RECEIPT_DIGEST =
  "c13e6bdcddd14c550ea7675d8ee479376eb06eb1299a9f2ee082cdb66444da16";

const receipt = parseSourceReceipt({
  version: SOURCE_RECEIPT_VERSION,
  sourceKind: "existing-repository",
  sourcePath: HOSTED_SOURCE_PATH,
  sourceSha: ARRUSTED_TARGET_SHA,
  sourceTree: ARRUSTED_TARGET_TREE,
  adapter: SUPPORTED_TEMPLATE_ADAPTER,
  eligibilityDigest: HOSTED_ELIGIBILITY_DIGEST,
  contractDigest: HOSTED_CONTRACT_DIGEST,
  releaseEnabled: false,
  digest: HOSTED_SOURCE_RECEIPT_DIGEST,
});

export function hostedSourceReceipt(
  sourceKind: SourceKind,
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SourceReceipt | undefined {
  if (!isHostedVercelRuntime(environment)) return undefined;
  readHostedDeploymentEnvironment(environment);
  if (sourceKind !== "existing-repository" || path !== HOSTED_SOURCE_PATH)
    throw new Error(
      `Hosted App Builder supports only the fixed source ${HOSTED_SOURCE_PATH}.`,
    );
  return receipt;
}

export async function prepareHostedSourceWorkspace(input: {
  receipt: SourceReceipt;
  sandbox: SandboxSession;
  callId: string;
}) {
  if (JSON.stringify(input.receipt) !== JSON.stringify(receipt))
    throw new Error("The hosted source receipt changed after review.");
  return prepareFixedHostedSandboxWorkspace({
    sandbox: input.sandbox,
    callId: input.callId,
    sourcePath: HOSTED_SOURCE_PATH,
    sourceSha: ARRUSTED_TARGET_SHA,
    sourceTree: ARRUSTED_TARGET_TREE,
    eligibilityDigest: HOSTED_ELIGIBILITY_DIGEST,
    workspaceDigest: HOSTED_SOURCE_WORKSPACE_DIGEST,
  });
}
