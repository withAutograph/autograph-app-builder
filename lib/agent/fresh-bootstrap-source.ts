import type { SandboxSession } from "eve/sandbox";

import { inspectSourceBoundSandboxWorkspace } from "../repository/arrusted-template";
import type { FreshBootstrapSourceWorkspace } from "../repository/node-fresh-bootstrap";
import { SOURCE_RECEIPT_VERSION } from "../repository/source-receipt";
import type { SourceReceipt } from "../repository/source-receipt";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import { readPreparedSandboxSourceManifest } from "../repository/supported-template";

/**
 * Bridge the canonical sandbox clone into local fresh-repository publication
 * without creating or consulting a second host-side checkout.
 */
export async function freshBootstrapSourceWorkspace(input: {
  sandbox: SandboxSession;
  receipt: SourceReceipt;
  workspace: PreparedSandboxWorkspace;
}): Promise<FreshBootstrapSourceWorkspace | undefined> {
  if (input.receipt.version !== SOURCE_RECEIPT_VERSION) {
    return undefined;
  }
  const reverify = async () => {
    await inspectSourceBoundSandboxWorkspace({
      expectedWorkspace: input.workspace,
      receipt: input.receipt,
      sandbox: input.sandbox,
    });
  };
  await reverify();
  const files = await readPreparedSandboxSourceManifest(
    input.sandbox,
    input.workspace
  );
  return {
    files,
    readSourceFile: async (path) =>
      await input.sandbox.readBinaryFile({ path: `repository/${path}` }),
    reverify,
  };
}
