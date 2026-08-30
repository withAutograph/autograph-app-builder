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
  "c7e00f034e0c36452b7c43a5544f5b5486240cc45f5d624f4e9134924af0e735";
export const HOSTED_CONTRACT_DIGEST =
  "be880ed1dcd6c450457a888b78fea704e3ffe62e121e6be118c83c2800a67d03";
export const HOSTED_SOURCE_RECEIPT_DIGEST =
  "7b696ceb167857912b21786ae0fab4afdbcbc5a58894ab4646feec8e52c9010f";

function exactHostedReceipt(): SourceReceipt {
  return parseSourceReceipt({
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
}

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
  return exactHostedReceipt();
}

export async function prepareHostedSourceWorkspace(input: {
  receipt: SourceReceipt;
  sandbox: SandboxSession;
  callId: string;
}) {
  const receipt = exactHostedReceipt();
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
