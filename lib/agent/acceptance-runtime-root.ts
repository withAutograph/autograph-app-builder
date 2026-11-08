/* oxlint-disable unicorn/no-useless-undefined -- Undefined means the described source cannot run against this installed release. */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { defineState } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { setBuilderSandboxNetworkPolicy } from "../sandbox/builder-sandbox";
import { ensureSandboxDirectories } from "../repository/sandbox-filesystem";
import { sanitizeValidationDiagnosticText } from "../repository/validation-output-sanitize";
import { attachCheckoutDependencyView } from "../repository/dependency-cache";
import { prepareWithVerifiedGitHubFetchRecovery } from "./verified-github-fetch-recovery";
import { repositoryAccessRuntimeForSession } from "./deployment-repository-access-runtime";
import {
  repositoryAccessReceiptSchema,
  repositoryAccessReceiptState,
} from "./repository-access-state";
import {
  draftReconciliationCompletions,
  draftReconciliationState,
  publishedDraftRepairCompletions,
} from "./draft-reconciliation-state";
import { currentDraftCandidateSource } from "./published-draft-repair";
import { resolveProtectedRuntimeBindings } from "./prepared-runtime-execution";
import type { AppBuilderWorkflowState } from "./workflow-state";

const recoveredRoots = defineState<Record<string, string>>(
  "autograph-app-builder.acceptance-runtime-roots.v1",
  () => ({}),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

/** Fetch the recorded source into a separate checkout without rewriting retained private work. */
export const recoverAcceptanceCheckout = async (input: {
  sandbox: Pick<SandboxSession, "run">;
  repositoryUrl: string;
  revision: string;
  root: string;
  workingDirectory: string;
  signal: AbortSignal;
}): Promise<string> => {
  const commands = [
    `git clone --filter=blob:none --no-checkout ${quote(input.repositoryUrl)} ${quote(input.root)}`,
    `git -C ${quote(input.root)} fetch --no-tags origin ${quote(input.revision)}`,
    `git -C ${quote(input.root)} checkout --detach ${quote(input.revision)}`,
  ];
  // oxlint-disable-next-line react-doctor/async-await-in-loop -- Git checkout commands depend on their predecessor.
  for (const command of commands) {
    input.signal.throwIfAborted();
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Recover source in order, retaining every existing checkout.
    const result = await input.sandbox.run({
      command,
      workingDirectory: input.workingDirectory,
      abortSignal: input.signal,
    });
    if (
      result.exitCode === 128 &&
      /remote: Repository not found\./u.test(`${result.stderr}\n${result.stdout}`)
    ) {
      // Preserve the verified-fetch recovery signal without exposing transport output or credentials.
      throw new Error(
        "Builder could not fetch the current draft head (exit 128): remote: Repository not found.",
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Builder could not recover the published acceptance source (exit ${result.exitCode}). Check its repository access and retry; existing work is preserved.`,
      );
    }
  }
  return input.root;
};

/** Borrow only from a retained directory that still exists; missing history is not a recovery prerequisite. */
export const attachAvailableAcceptanceDependencies = async (input: {
  sandbox: Pick<SandboxSession, "run">;
  roots: string[];
  recoveredRoot: string;
  workspaceRoot: string;
  signal: AbortSignal;
}): Promise<void> => {
  for (const root of new Set(input.roots)) {
    input.signal.throwIfAborted();
    if (root === input.recoveredRoot) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect retained sources in preference order.
    const existing = await input.sandbox.run({
      command: `test -d ${quote(root)}`,
      workingDirectory: input.workspaceRoot,
      abortSignal: input.signal,
    });
    if (existing.exitCode !== 1) {
      if (existing.exitCode !== 0) {
        throw new Error(
          "Builder could not inspect the retained dependency source. The recovered checkout is preserved; inspect sandbox file access before retrying.",
        );
      }
      // The maintained attachment implementation enforces owned paths and rebases workspace links.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Attach the first existing source only.
      await attachCheckoutDependencyView({
        sandbox: input.sandbox,
        checkoutRoot: root,
        candidateRoot: input.recoveredRoot,
        workspaceRoot: input.workspaceRoot,
      });
      return;
    }
  }
  // Let the repository-owned describe command reveal any actual missing dependency.
};

/** Source edits are allowed. Only the installed release must be compatible before credentials are restored. */
export const resolveCompatibleAcceptanceRoot = async (input: {
  roots: string[];
  releaseId: string;
  describe: (root: string) => Promise<string | undefined>;
  recover: () => Promise<string>;
  signal?: AbortSignal;
}): Promise<string> => {
  for (const root of new Set(input.roots)) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Probe retained roots in preference order without changing them.
      if ((await input.describe(root)) === input.releaseId) {
        return root;
      }
    } catch {
      input.signal?.throwIfAborted();
      // An expired or incomplete retained workspace can fail to run. Recover once, then
      // preserve the recovered command's actual failure rather than calling it a release mismatch.
    }
  }
  const root = await input.recover();
  if ((await input.describe(root)) !== input.releaseId) {
    throw new Error(
      "The recovered published app could not describe the installed release. Preserve its checkout and inspect the repository command before retrying acceptance.",
    );
  }
  return root;
};

/** Recover a private execution checkout; never overwrite the app's original or evolving candidate work. */
export const resolveAcceptanceRuntimeRoot = async (input: {
  appId: string;
  fallbackRoot: string;
  sandbox: SandboxSession;
  state: AppBuilderWorkflowState;
  ctx: ToolContext;
}): Promise<string> => {
  const { state, sandbox, ctx, appId } = input;
  const projection = await resolveProtectedRuntimeBindings({
    appId,
    sessionAuth: ctx.session.auth,
    sessionId: ctx.session.id,
    signal: ctx.abortSignal,
    callbackExecution: hostedOperatorCallbackExecution(ctx.session),
  });
  if (projection === null) {
    return input.fallbackRoot;
  }
  const candidate = draftReconciliationState.get();
  const completions = [
    ...publishedDraftRepairCompletions.get(),
    ...draftReconciliationCompletions.get(),
  ].filter((entry) => entry.appId === appId);
  const current =
    state.phase === "reviewed" &&
    candidate?.appId === appId &&
    currentDraftCandidateSource(state, candidate) !== undefined
      ? candidate.root
      : undefined;
  const retainedRoots = [
    current,
    recoveredRoots.get()[appId],
    ...completions.toReversed().map((entry) => entry.root),
    input.fallbackRoot,
  ].filter((entry): entry is string => entry !== undefined);
  const selectedRoot = await resolveCompatibleAcceptanceRoot({
    roots: retainedRoots,
    releaseId: projection.plan.release.id,
    signal: ctx.abortSignal,
    describe: async (root) => {
      ctx.abortSignal.throwIfAborted();
      try {
        const result = await sandbox.run({
          command: `mise run app:describe ${quote(appId)}`,
          workingDirectory: root,
          abortSignal: ctx.abortSignal,
        });
        if (result.exitCode !== 0) {
          const diagnostic = sanitizeValidationDiagnosticText(
            `${result.stderr}\n${result.stdout}`,
          ).slice(-4000);
          throw new Error(
            `The acceptance workspace could not run mise run app:describe (exit ${result.exitCode}). ${diagnostic}`,
          );
        }
        const value = z
          .object({
            app: z.object({ id: z.string() }),
            backend: z.object({ release: z.object({ id: z.string() }) }),
          })
          .parse(JSON.parse(result.stdout));
        return value.app.id === appId ? value.backend.release.id : undefined;
      } catch (error) {
        ctx.abortSignal.throwIfAborted();
        // oxlint-disable-next-line eslint/preserve-caught-error -- Raw sandbox errors may contain credentials; retain only sanitized diagnostics.
        throw new Error(
          `Acceptance workspace description failed: ${sanitizeValidationDiagnosticText(error instanceof Error ? error.message : String(error)).slice(-4000)}`,
        );
      }
    },
    recover: async () => {
      const access = repositoryAccessReceiptSchema.parse(repositoryAccessReceiptState.get());
      const { delivery } = projection.plan;
      if (
        access.sessionId !== ctx.session.id ||
        delivery?.gitSha === undefined ||
        access.repository.repositoryId !== delivery.repoId
      ) {
        throw new Error(
          "The prepared app's repository access must be reconnected in this same Builder session before its runtime can recover.",
        );
      }
      const revision = delivery.gitSha;
      const runtime = await repositoryAccessRuntimeForSession(ctx.session.auth);
      const { prepared } = await prepareWithVerifiedGitHubFetchRecovery({
        acquireCredential: async () =>
          await runtime.acquireExistingSourceCredential({
            installationId: access.scope.installationId,
            repository: access.repository,
            sessionId: ctx.session.id,
          }),
        sandbox: {
          setNetworkPolicy: async (policy) => {
            await setBuilderSandboxNetworkPolicy(sandbox, policy);
          },
        },
        prepare: async () => {
          // A rejected fetch may leave a partial clone. Keep it intact and retry into a new checkout.
          const destination = `/workspace/.app-builder/acceptance/${randomUUID()}`;
          await ensureSandboxDirectories(sandbox, ["/workspace/.app-builder/acceptance"]);
          await recoverAcceptanceCheckout({
            sandbox,
            repositoryUrl: `https://github.com/${access.repository.owner}/${access.repository.name}.git`,
            revision,
            root: destination,
            workingDirectory: "/workspace",
            signal: ctx.abortSignal,
          });
          // Retain the fetched source even if dependency attachment or description subsequently fails.
          recoveredRoots.update((value) => ({ ...value, [appId]: destination }));
          await attachAvailableAcceptanceDependencies({
            sandbox,
            roots: retainedRoots,
            recoveredRoot: destination,
            workspaceRoot: "/workspace",
            signal: ctx.abortSignal,
          });
          return destination;
        },
      });
      recoveredRoots.update((value) => ({ ...value, [appId]: prepared }));
      return prepared;
    },
  });
  return selectedRoot;
};
