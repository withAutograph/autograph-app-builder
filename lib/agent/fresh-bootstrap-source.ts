import type { SandboxSession } from "eve/sandbox";

import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import { readPreparedSandboxSourceManifest } from "../repository/supported-template";
import { inspectSourceBoundSandboxWorkspace } from "../repository/arrusted-template";
import { SOURCE_RECEIPT_VERSION } from "../repository/source-receipt";
import type { SourceReceipt } from "../repository/source-receipt";
import type { FreshBootstrapSourceWorkspace } from "../repository/node-fresh-bootstrap";

/**
 * Bridge the canonical sandbox clone into local fresh-repository publication
 * without creating or consulting a second host-side checkout.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function freshBootstrapSourceWorkspace(input: {
  sandbox: SandboxSession;
  receipt: SourceReceipt;
  workspace: PreparedSandboxWorkspace;
  dependencies?: {
    inspectSourceBoundSandboxWorkspace: typeof inspectSourceBoundSandboxWorkspace;
    readPreparedSandboxSourceManifest: typeof readPreparedSandboxSourceManifest;
  };
}): Promise<FreshBootstrapSourceWorkspace | undefined> {
  if (input.receipt.version !== SOURCE_RECEIPT_VERSION) {
    return undefined;
  }
  const inspect = input.dependencies?.inspectSourceBoundSandboxWorkspace ?? inspectSourceBoundSandboxWorkspace;
  const readManifest = input.dependencies?.readPreparedSandboxSourceManifest ?? readPreparedSandboxSourceManifest;
  const reverify = async () => {
    await inspect({
      expectedWorkspace: input.workspace,
      receipt: input.receipt,
      sandbox: input.sandbox,
    });
  };
  await reverify();
  const files = await readManifest(input.sandbox, input.workspace);
  return {
    files,
    readSourceFile: async (path) =>
      await input.sandbox.readBinaryFile({ path: `repository/${path}` }),
    readSourceFileStream: async (path) =>
      await input.sandbox.readFile({ path: `repository/${path}` }),
    reverify,
  };
}
