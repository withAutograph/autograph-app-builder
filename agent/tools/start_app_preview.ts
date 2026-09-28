import { createHash } from "node:crypto";

import {
  bindProductBehaviorPreview,
  currentProductBehaviorGeneration,
} from "@/lib/agent/product-behavior-state";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  previewWorkingDirectorySchema,
  resolvePreviewWorkingDirectory,
} from "@/lib/agent/preview-working-directory";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { ensureCheckoutDependencies } from "@/lib/agent/checkout-dependencies";
import { prepareAppLocalPreview } from "./prepare-app-local-preview";
import {
  hasLiveWorkingPreview,
  workingPreviewState,
  workingPreviewAttemptState,
} from "@/lib/agent/working-preview-state";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";
import { getVercelPreviewProvider } from "@/lib/sandbox/vercel-preview-provider";
import { startWorkingPreview } from "@/lib/sandbox/working-preview-runtime";

const validationAttemptDigest = (
  state: ReturnType<typeof appBuilderWorkflowState.get>,
): string | undefined => {
  if ("validationReceipt" in state) {
    return state.validationReceipt.digest;
  }
  if ("validationFailure" in state) {
    return state.validationFailure.attemptDigest;
  }
  if ("validationAttempt" in state) {
    return state.validationAttempt.digest;
  }
  return undefined;
};

const nextDependencyManifest = z.object({
  dependencies: z.object({ next: z.string().optional() }).optional(),
  devDependencies: z.object({ next: z.string().optional() }).optional(),
});

const usesNext = (source: string | null): boolean => {
  if (source === null) {
    return false;
  }
  try {
    const parsed = nextDependencyManifest.safeParse(JSON.parse(source));
    return (
      parsed.success &&
      (parsed.data.dependencies?.next !== undefined ||
        parsed.data.devDependencies?.next !== undefined)
    );
  } catch {
    throw new Error(
      "The selected app's package.json is not valid JSON. Repair its manifest before starting the private preview.",
    );
  }
};

export default defineTool({
  description:
    "Open the implemented app in its private Sandbox and return an actual working browser URL. Repeating the same request for the same applied build reuses its live preview instead of interrupting it. Use the repository's discovered development command as executable plus argument array (no shell wrappers), in workingDirectory relative to the applied repository root (default .). Use the discovered app package directory for a nested package; landingPath is an HTTP route, not a filesystem directory. Configure that command to listen on the supplied port; use landingPath for a nested app route. This uses the already-approved implementation, does not publish or provision app resources, and can reopen an expired preview. A reachable page is not proof of backend product behavior.",
  async execute(input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (!("applyReceipt" in current)) {
      throw new Error(
        "Build approval and an applied implementation are needed before opening the working app.",
      );
    }
    const cwd = resolvePreviewWorkingDirectory(
      current.applyReceipt.applyRoot,
      input.workingDirectory,
    );
    const evidenceGeneration = currentProductBehaviorGeneration();
    const sandbox = await ctx.getSandbox();
    await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
    const provider = await getVercelPreviewProvider(sandbox.id, ctx.abortSignal);
    const previous = workingPreviewState.get();
    const validationDigest = validationAttemptDigest(current);
    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          appId: current.appSpec.appId,
          applyDigest: current.applyReceipt.digest,
          command: input.command,
          cwd,
          landingPath: input.landingPath,
          port: input.port,
          validationDigest,
        }),
      )
      .digest("hex");
    if (
      previous?.requestDigest === requestDigest &&
      hasLiveWorkingPreview(previous, sandbox.id) &&
      previous.providerSessionId === provider.currentSession().sessionId
    ) {
      const command = await provider.getCommand(previous.commandId, { signal: ctx.abortSignal });
      if (command.exitCode === null) {
        bindProductBehaviorPreview(previous.commandId, evidenceGeneration);
        return { workingPreview: previous.receipt };
      }
    }
    const { appId } = current.appSpec;
    const packageManifest = await sandbox.readTextFile({ path: `${cwd}/package.json` });
    const dependencyInput = {
      root: current.applyReceipt.applyRoot,
      sandbox,
      signal: ctx.abortSignal,
    };
    await ensureCheckoutDependencies(
      usesNext(packageManifest)
        ? { ...dependencyInput, requiredExecutable: "next" }
        : dependencyInput,
    );
    const appContract = await sandbox.readTextFile({
      path: `${current.applyReceipt.applyRoot}/apps/${appId}/.config/app-spec.md`,
    });
    const repositoryTasks = await sandbox.readTextFile({
      path: `${current.applyReceipt.applyRoot}/.config/mise/config.toml`,
    });
    if (
      appContract?.includes(`mise run app:local -- ${appId} setup`) === true &&
      repositoryTasks?.includes('[tasks."app:local"]') === true
    ) {
      const setup = await prepareAppLocalPreview({
        appId,
        root: current.applyReceipt.applyRoot,
        sandbox,
        signal: ctx.abortSignal,
      });
      if (setup.status === "failed") {
        throw new Error(
          `The app's local data setup failed before preview startup. ${setup.problem}\nCommand: ${setup.command}\n${setup.stderr || setup.stdout || "No command output was returned."}`,
        );
      }
    }
    workingPreviewState.update(() => null);
    let ownedAttemptId: string | undefined;
    const preview = await startWorkingPreview({
      ...input,
      appId: current.appSpec.appId,
      cwd,
      onAttempt: (attempt) => {
        workingPreviewAttemptState.update((currentAttempt) => {
          if (attempt === null) {
            return currentAttempt?.attemptId === ownedAttemptId ? null : currentAttempt;
          }
          ownedAttemptId = attempt.attemptId;
          return attempt;
        });
      },
      previous,
      provider,
      requestDigest,
      sandboxId: sandbox.id,
      signal: ctx.abortSignal,
    });
    workingPreviewState.update(() => preview);
    bindProductBehaviorPreview(preview.commandId, evidenceGeneration);
    return { workingPreview: preview.receipt };
  },
  inputSchema: z.object({
    command: z.object({
      args: z.array(z.string().max(8192)).max(256),
      executable: z.string().min(1).max(1024),
    }),
    landingPath: z.string().min(1).max(2048).default("/"),
    port: z.number().int().min(1024).max(65_535).default(3000),
    workingDirectory: previewWorkingDirectorySchema,
  }),
});
