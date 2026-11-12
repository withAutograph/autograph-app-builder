/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { readLocalPreviewAuthOrigin } from "@/lib/repository/local-preview-auth-origin";
import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
import { createHash } from "node:crypto";

import {
  bindProductBehaviorPreview,
  invalidateProductBehaviorPreview,
  currentProductBehaviorGeneration,
} from "@/lib/agent/product-behavior-state";
import { recoverHostedTemplateFoundation } from "@/lib/agent/hosted-template-foundation-recovery";
import { defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { z } from "zod";

import { previewWorkingDirectorySchema } from "@/lib/agent/preview-working-directory";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { priorValidatedPrivateArtifact } from "@/lib/agent/prior-validated-private-artifact";
import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";
import { finalizePreviewLaunch, resolvePreviewLaunch } from "@/lib/agent/preview-launch";
import { ensureCheckoutDependencies } from "@/lib/agent/checkout-dependencies";
import { nativeWorkingPreview } from "@/lib/agent/native-working-preview";
import {
  resolveProtectedRuntimeBindings,
  resolvePreparedRuntimeExecution,
} from "@/lib/agent/prepared-runtime-execution";
import { reportHostedRuntimeHandoffDiagnostic } from "@/lib/agent/hosted-runtime-handoff-diagnostic";
import type { DependencyAttemptResult } from "@/lib/agent/checkout-dependencies";
import type { ValidationLogStore } from "@/lib/repository/validation-log";
import { exactForwardedSessionAuthority } from "@/lib/hosted/session-authority";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";
import { createPostgresValidationLogStore } from "@/lib/repository/postgres-validation-log-store";
import { appDeclaresLocalSetup, prepareAppLocalPreview } from "./prepare-app-local-preview";
import { localRuntimeEnvironmentPath } from "@/lib/repository/runtime-environment";
import {
  hasLiveWorkingPreview,
  workingPreviewState,
  workingPreviewAttemptState,
} from "@/lib/agent/working-preview-state";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";
import { getVercelPreviewProvider } from "@/lib/sandbox/vercel-preview-provider";
import { getPriorPreviewCommand, startWorkingPreview } from "@/lib/sandbox/working-preview-runtime";

const recordPreviewDependencyAttempt = (attempt: DependencyAttemptResult) => {
  appBuilderWorkflowState.update((state) =>
    state.phase === "empty"
      ? state
      : {
          ...state,
          checkoutDependencyAttempts: [...(state.checkoutDependencyAttempts ?? []), attempt],
        },
  );
};

const dependencyLogStore = (ctx: ToolContext): ValidationLogStore | undefined => {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    return undefined;
  }
  // Authentication failures remain fatal; unavailable storage cannot block installation.
  exactForwardedSessionAuthority(ctx.session.auth);
  try {
    return createPostgresValidationLogStore({
      db: openHostedPostgresDatabase(databaseUrl),
      sessionAuth: ctx.session.auth,
      sessionId: ctx.session.id,
    });
  } catch {
    // The command result explicitly reports unavailable durability.
  }
  return undefined;
};

const resolveNativePreview = async (
  input: { appId?: string; landingPath: string },
  ctx: ToolContext,
  current: ReturnType<typeof appBuilderWorkflowState.get>,
  buildNativePreview: typeof nativeWorkingPreview,
) => {
  const protectedAppId = "appSpec" in current ? current.appSpec.appId : input.appId;
  const diagnostic: Omit<
    Extract<
      Parameters<typeof reportHostedRuntimeHandoffDiagnostic>[0],
      { stage: "native_preview_candidate" }
    >,
    "stage"
  > = {
    acceptedAppIdPresent: "appSpec" in current,
    inputAppIdPresent: input.appId !== undefined,
    lookupAttempted: protectedAppId !== undefined,
  };
  if (input.appId !== undefined && protectedAppId !== undefined) {
    diagnostic.appIdMatches = input.appId === protectedAppId;
  }
  reportHostedRuntimeHandoffDiagnostic({ ...diagnostic, stage: "native_preview_candidate" });
  if (protectedAppId !== undefined) {
    if (input.appId !== undefined && input.appId !== protectedAppId) {
      throw new Error("The requested app does not match the accepted app.");
    }
    const bindings = await resolveProtectedRuntimeBindings({
      appId: protectedAppId,
      sessionAuth: ctx.session.auth,
      sessionId: ctx.session.id,
      callbackExecution: hostedOperatorCallbackExecution(ctx.session),
      signal: ctx.abortSignal,
    });
    if (bindings) {
      if (
        !("identityReceipt" in current) ||
        current.identityReceipt.identity.appId !== protectedAppId
      ) {
        throw new Error(
          "The protected Preview requires the selected app's accepted route identity.",
        );
      }
      const native = buildNativePreview({
        appId: protectedAppId,
        baseRoute: current.identityReceipt.identity.baseRoutes[0],
        bindings,
        landingPath: input.landingPath,
      });
      return native;
    }
  }
  return null;
};

export const createStartAppPreview = ({
  nativePreview = nativeWorkingPreview,
}: { nativePreview?: typeof nativeWorkingPreview } = {}) =>
  defineTool({
    description:
      "Open the selected existing app or applied new app and return a working browser URL. An approved protected runtime publishes its verified native Gateway app route; other apps start a private Sandbox preview. Omit command to run the app's development script in its repository-owned app workspace and open its registered route. The standard generated Next script falls back to a private sandbox port when its port discovery fails. For a prepared existing GitHub checkout, supply appId. Supply command, workingDirectory and port for a custom development server. Use artifact=prior-validated to preview the exact last validated local artifact while a newer plan remains unapplied. A reachable page is not proof of backend product behavior.",
    async execute(input, ctx) {
      let current = appBuilderWorkflowState.get();
      const native =
        input.artifact === undefined
          ? await resolveNativePreview(
              { ...input, landingPath: input.landingPath ?? "/" },
              ctx,
              current,
              nativePreview,
            )
          : null;
      if (native) {
        invalidateProductBehaviorPreview("preview-replaced");
        workingPreviewState.update(() => null);
        return native;
      }
      const sandbox = await ctx.getSandbox();
      const prior =
        input.artifact === "prior-validated"
          ? await priorValidatedPrivateArtifact({
              appId: input.appId,
              sandbox,
              state: current,
              sessionId: ctx.session.id,
              signal: ctx.abortSignal,
            })
          : undefined;
      const artifact =
        prior === undefined
          ? undefined
          : { applyDigest: prior.revision, validationDigest: prior.validationDigest };
      let selected = prior ?? (await runnableSelectedApp({ appId: input.appId, state: current }));
      await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
      prior?.assertCurrent();
      const resolveLaunch = async () => {
        const accepted =
          prior === undefined && "identityReceipt" in current
            ? current.identityReceipt.identity
            : undefined;
        const identity =
          accepted?.appId === selected.appId
            ? { routes: accepted.baseRoutes, workspacePath: accepted.workspacePath }
            : undefined;
        const launchInput: Parameters<typeof resolvePreviewLaunch>[0] = {
          appId: selected.appId,
          root: selected.root,
          request: input,
          sandbox,
          signal: ctx.abortSignal,
        };
        if (identity !== undefined) {
          launchInput.identity = identity;
        }
        return await resolvePreviewLaunch(launchInput);
      };
      let launch = await resolveLaunch();
      let evidenceGeneration = currentProductBehaviorGeneration();
      const provider = await getVercelPreviewProvider(
        getBuilderSandboxId(sandbox),
        ctx.abortSignal,
      );
      const runtime =
        prior === undefined
          ? await resolvePreparedRuntimeExecution({
              appId: selected.appId,
              root: selected.root,
              sandboxId: getBuilderSandboxId(sandbox),
              sessionAuth: ctx.session.auth,
              sessionId: ctx.session.id,
              callbackExecution: hostedOperatorCallbackExecution(ctx.session),
              signal: ctx.abortSignal,
              state: current,
            })
          : null;
      const previous = workingPreviewState.get();
      const previewRequestDigest = () =>
        createHash("sha256")
          .update(
            JSON.stringify({
              appId: selected.appId,
              command: launch.command,
              cwd: launch.cwd,
              evidenceGeneration,
              landingPath: launch.landingPath,
              port: launch.port,
              portCommand: launch.portCommand,
              revision: selected.revision,
              runtimeStateDirectory: runtime?.stateDirectory,
            }),
          )
          .digest("hex");
      let requestDigest = previewRequestDigest();
      const samePriorArtifact =
        previous?.priorValidatedArtifact?.applyDigest === artifact?.applyDigest &&
        previous?.priorValidatedArtifact?.validationDigest === artifact?.validationDigest;
      const reusableLaunch =
        selected.reusable && previous?.requestDigest === requestDigest && samePriorArtifact;
      if (
        reusableLaunch &&
        hasLiveWorkingPreview(previous, getBuilderSandboxId(sandbox)) &&
        previous.providerSessionId === provider.currentSession().sessionId
      ) {
        const command = await getPriorPreviewCommand(provider, previous.commandId, ctx.abortSignal);
        prior?.assertCurrent();
        if (command?.exitCode === null) {
          bindProductBehaviorPreview(previous.commandId, evidenceGeneration);
          return {
            commandAdjustment: launch.adjustment,
            installationProof: runtime?.installationProof,
            workingPreview: previous.receipt,
          };
        }
      }
      const { appId } = selected;
      const assertCurrentDependencies = () => {
        ctx.abortSignal.throwIfAborted();
        prior?.assertCurrent();
        if (currentProductBehaviorGeneration() !== evidenceGeneration) {
          throw new Error(
            "The selected app changed while preparing preview dependencies. Retry the preview for the current app.",
          );
        }
      };
      const dependencyInput = {
        assertCurrent: assertCurrentDependencies,
        root: selected.root,
        sandbox,
        signal: ctx.abortSignal,
      };
      let dependencies =
        prior === undefined
          ? await ensureCheckoutDependencies({
              ...dependencyInput,
              checkoutIdentity: selected.revision,
              logStore: dependencyLogStore(ctx),
              onAttempt: recordPreviewDependencyAttempt,
              reconcileWorkspace: true,
              sessionId: ctx.session.id,
            })
          : await ensureCheckoutDependencies({
              ...dependencyInput,
              checkoutIdentity: selected.revision,
              sessionId: ctx.session.id,
            });
      let environmentPath = runtime?.environmentPath;
      if (!runtime && (await appDeclaresLocalSetup({ appId, root: selected.root, sandbox }))) {
        const setup = await prepareAppLocalPreview({
          appId,
          root: selected.root,
          sandbox,
          signal: ctx.abortSignal,
          recover:
            prior === undefined
              ? async () => {
                  const changed = await recoverHostedTemplateFoundation(ctx, {
                    appId,
                    root: selected.root,
                  });
                  if (changed) {
                    const refreshed = appBuilderWorkflowState.get();
                    if (
                      refreshed.phase !== "applied" ||
                      current.phase === "empty" ||
                      !("applyReceipt" in current)
                    ) {
                      throw new Error("The selected app is no longer applied.");
                    }
                    const sameApp = [
                      refreshed.appSpec.digest === current.appSpec.digest,
                      refreshed.applyReceipt.digest === current.applyReceipt.digest,
                      refreshed.workspace.workspaceId === current.workspace.workspaceId,
                    ].every(Boolean);
                    if (!sameApp) {
                      throw new Error(
                        "The selected approved app changed during local source recovery.",
                      );
                    }
                    current = refreshed;
                    selected = await runnableSelectedApp({ appId, state: current });
                    launch = await resolveLaunch();
                    evidenceGeneration = currentProductBehaviorGeneration();
                    dependencies = await ensureCheckoutDependencies({
                      ...dependencyInput,
                      root: selected.root,
                      checkoutIdentity: selected.revision,
                      logStore: dependencyLogStore(ctx),
                      reconcileWorkspace: true,
                      sessionId: ctx.session.id,
                      onAttempt: recordPreviewDependencyAttempt,
                    });
                    requestDigest = previewRequestDigest();
                  }
                  return changed;
                }
              : undefined,
        });
        if (setup.status === "failed") {
          throw new Error(
            `The app's local data setup failed before preview startup. ${setup.problem}\nCommand: ${setup.command}\n${setup.stderr || setup.stdout || "No command output was returned."}`,
          );
        }
        environmentPath = localRuntimeEnvironmentPath(selected.root, appId);
      }
      await prior?.verifyCurrent();
      const runnableLaunch = await finalizePreviewLaunch(launch, sandbox, ctx.abortSignal);
      assertCurrentDependencies();
      invalidateProductBehaviorPreview("preview-replaced");
      workingPreviewState.update(() => null);
      let ownedAttemptId: string | undefined;
      let prepareAuthenticatedOrigin = runtime?.prepareAuthenticatedOrigin;
      if (!runtime && environmentPath !== undefined) {
        prepareAuthenticatedOrigin = async (authOrigin) => {
          prior?.assertCurrent();
          const expectedPreviousAuthOrigin = await readLocalPreviewAuthOrigin({
            appId,
            root: selected.root,
            sandbox,
            signal: ctx.abortSignal,
          });
          prior?.assertCurrent();
          const setup = await prepareAppLocalPreview({
            appId,
            authOrigin,
            expectedPreviousAuthOrigin,
            root: selected.root,
            sandbox,
            signal: ctx.abortSignal,
          });
          if (setup.status === "failed") {
            const diagnostic =
              setup.stderr || setup.stdout || "No setup command output was returned.";
            throw new Error(`${setup.problem}\n${diagnostic}`);
          }
        };
      }
      const preview = await startWorkingPreview({
        appId: selected.appId,
        command: runnableLaunch.command,
        cwd: runnableLaunch.cwd,
        landingPath: runnableLaunch.landingPath,
        port: runnableLaunch.port,
        environmentPath,
        onAttempt: (attempt) => {
          workingPreviewAttemptState.update((currentAttempt) => {
            if (attempt === null) {
              return currentAttempt?.attemptId === ownedAttemptId ? null : currentAttempt;
            }
            ownedAttemptId = attempt.attemptId;
            return attempt;
          });
        },
        prepareAuthenticatedOrigin,
        assertCurrent: assertCurrentDependencies,
        previous,
        provider,
        requestDigest,
        sandboxId: getBuilderSandboxId(sandbox),
        signal: ctx.abortSignal,
      });
      workingPreviewState.update(() =>
        artifact === undefined ? preview : { ...preview, priorValidatedArtifact: artifact },
      );
      bindProductBehaviorPreview(preview.commandId, evidenceGeneration);
      return {
        commandAdjustment: runnableLaunch.adjustment,
        dependencies,
        installationProof: runtime?.installationProof,
        workingPreview: preview.receipt,
      };
    },
    inputSchema: z.object({
      artifact: z.literal("prior-validated").optional(),
      appId: z
        .string()
        .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
        .optional(),
      command: z
        .object({
          args: z.array(z.string().max(8192)).max(256),
          executable: z.string().min(1).max(1024),
        })
        .optional(),
      landingPath: z.string().min(1).max(2048).optional(),
      port: z.number().int().min(1024).max(65_535).optional(),
      workingDirectory: previewWorkingDirectorySchema,
    }),
  });

export default createStartAppPreview();
