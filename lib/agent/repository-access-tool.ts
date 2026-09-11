import { ConnectionAuthorizationFailedError } from "eve/connections";
import type { ToolContext } from "eve/tools";

import type {
  ReadyRepositoryAccess,
  RepositoryAccessResult,
} from "../integrations/repository-access";
import type { RepositoryAccessRuntime } from "./deployment-repository-access-runtime";
import {
  recordRepositoryAccessReceipt,
  repositoryAccessReceiptState,
} from "./repository-access-state";
import type { RepositoryAccessReceipt } from "./repository-access-state";

export interface RepositoryAccessToolInput {
  repository: string;
  selectedInstallationId?: string;
}

export async function resolveRepositoryAccessForTool(
  input: RepositoryAccessToolInput,
  ctx: ToolContext,
  runtime: RepositoryAccessRuntime
): Promise<
  | { kind: "selection"; access: Awaited<ReturnType<typeof runtime.classify>> }
  | {
      kind: "ready";
      access: ReadyRepositoryAccess;
      receipt: RepositoryAccessReceipt;
    }
> {
  const access = await runtime.classify(input);
  if (access.status === "scope-selection-required") {
    return { kind: "selection", access };
  }
  if (access.status === "provider-unavailable") {
    throw new ConnectionAuthorizationFailedError("github-repository-access", {
      reason: "provider_unavailable",
      retryable: true,
      message: "GitHub could not confirm repository access. Try again shortly.",
    });
  }
  let confirmed: RepositoryAccessResult = access;
  if (access.status !== "ready") {
    const provider = runtime.authorization({
      ...input,
      requestId: ctx.callId,
      sessionId: ctx.session.id,
    });
    const authOptions = {
      authKey: `github-repository:${ctx.session.id}:${input.repository.toLowerCase().replace("/", ":")}`,
      displayName:
        access.status === "authorization-required" && access.action === "update"
          ? "Update GitHub access"
          : "Connect GitHub",
    } as const;
    await ctx.getToken(provider, authOptions);
    confirmed = await runtime.classify(input);
    if (confirmed.status === "authorization-required") {
      ctx.requireAuth(provider, authOptions);
    }
  }
  if (confirmed.status === "provider-unavailable") {
    throw new ConnectionAuthorizationFailedError("github-repository-access", {
      reason: "provider_unavailable",
      retryable: true,
      message: "GitHub could not confirm repository access. Try again shortly.",
    });
  }
  if (confirmed.status !== "ready") {
    throw new Error(
      confirmed.status === "scope-selection-required"
        ? "Choose which connected GitHub account Autograph should use."
        : "GitHub could not confirm repository access."
    );
  }
  const ready = confirmed;
  let recorded: RepositoryAccessReceipt | undefined;
  repositoryAccessReceiptState.update((current) => {
    recorded = recordRepositoryAccessReceipt({
      access: ready,
      confirmedByCallId: ctx.callId,
      current,
      sessionId: ctx.session.id,
    });
    return recorded;
  });
  if (recorded === undefined) {
    throw new Error("Confirmed repository access was not recorded.");
  }
  return { access: confirmed, kind: "ready", receipt: recorded };
}
