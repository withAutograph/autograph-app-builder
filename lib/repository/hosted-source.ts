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
  "c47f3c720cce4b4bcf64e430d248284570776f48a886c20fc18d255815985c6e";
export const HOSTED_CONTRACT_DIGEST =
  "f3c8499305c983b3d82f3b78687f4106a149decd7faa486d3d106bdaf83e928f";
export const HOSTED_SOURCE_RECEIPT_DIGEST =
  "d7d0f34a4f3fbe5f3fc7a342e17a4ee68485dd5039156cf630648e10f16459e9";

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
