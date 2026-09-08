import type { ToolContext } from "eve/tools";

import type { ReadyRepositoryAccess } from "../integrations/repository-access";
import type { RepositoryAccessRuntime } from "./deployment-repository-access-runtime";
import {
  recordRepositoryAccessReceipt,
  type RepositoryAccessReceipt,
  repositoryAccessReceiptState,
} from "./repository-access-state";

export type RepositoryAccessToolInput = {
  repository: string;
  selectedInstallationId?: string;
};

export async function resolveRepositoryAccessForTool(
  input: RepositoryAccessToolInput,
  ctx: ToolContext,
  runtime: RepositoryAccessRuntime,
): Promise<
  | { kind: "selection"; access: Awaited<ReturnType<typeof runtime.classify>> }
  | {
      kind: "ready";
      access: ReadyRepositoryAccess;
      receipt: RepositoryAccessReceipt;
    }
> {
  const access = await runtime.classify(input);
  if (access.status === "scope-selection-required")
    return { kind: "selection", access };
  const provider = runtime.authorization({
    ...input,
    sessionId: ctx.session.id,
    requestId: ctx.callId,
  });
  const authOptions = {
    authKey: `github-repository:${ctx.session.id}:${input.repository.toLowerCase().replace("/", ":")}`,
    displayName:
      access.status === "authorization-required" && access.action === "update"
        ? "Update GitHub access"
        : "Connect GitHub",
  } as const;
  await ctx.getToken(provider, authOptions);
  const confirmed = await runtime.classify(input);
  if (confirmed.status === "authorization-required") {
    ctx.requireAuth(provider, authOptions);
  }
  if (confirmed.status !== "ready") {
    throw new Error(
      confirmed.status === "scope-selection-required"
        ? "Choose which connected GitHub account Autograph should use."
        : "GitHub could not confirm repository access.",
    );
  }
  let recorded: RepositoryAccessReceipt | undefined;
  repositoryAccessReceiptState.update((current) => {
    recorded = recordRepositoryAccessReceipt({
      current,
      sessionId: ctx.session.id,
      confirmedByCallId: ctx.callId,
      access: confirmed,
    });
    return recorded;
  });
  if (recorded === undefined)
    throw new Error("Confirmed repository access was not recorded.");
  return { kind: "ready", access: confirmed, receipt: recorded };
}
