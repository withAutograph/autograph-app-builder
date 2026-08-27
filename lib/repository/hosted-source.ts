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

export const HOSTED_ELIGIBILITY_DIGEST =
  "2d7503a9c959d3fadfa53dc46abc0edfa54540db4ca5cb2d22932aaaa7e52b78";
export const HOSTED_CONTRACT_DIGEST =
  "f5b971410e5d37f0452af7eea17ab6bad9e35b5a0aa9a3d6b993edc3407fda6b";
export const HOSTED_SOURCE_RECEIPT_DIGEST =
  "115b48f0ac70ee056ef98a72e10868d715dfe32318c4bfd62250433c5feb642d";

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
  if (environment.VERCEL_ENV !== "preview")
    throw new Error("The hosted source is available only in Vercel Preview.");
  if (sourceKind !== "existing-repository" || path !== HOSTED_SOURCE_PATH)
    throw new Error(
      `Hosted Preview supports only the fixed source ${HOSTED_SOURCE_PATH}.`,
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
