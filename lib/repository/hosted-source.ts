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
  "2b524f0975a1e0c55e0c7aeca25553afc394698e812f89f35df3881e24e38744";
export const HOSTED_CONTRACT_DIGEST =
  "0295cecbbb6059544e80b90dc95a4722eb530642d4c0d63687b08009a26aa2c3";
export const HOSTED_SOURCE_RECEIPT_DIGEST =
  "7acb8c5ba44424f1f4924f3304e7a3360b0f0acef391132e338c7a5072487dd5";

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
