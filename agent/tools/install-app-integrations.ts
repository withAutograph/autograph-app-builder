import { appIntegrationInstallReadinessSchema } from "../../lib/repository/app-integration-metadata";
import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { safeCommandOutput } from "@/lib/agent/command-output";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { invalidateProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
type SandboxRunInput = Parameters<SandboxSession["run"]>[0];
interface IntegrationInstallSuccess {
  capabilityState: "source-omitted" | "source-installed";
  command: string;
  exitCode: 0;
  files: string[];
  nextStep: string;
  providerReadiness: "unverified";
  providers: z.infer<ReturnType<typeof integrationInstallReceipt>>["providers"];
  readiness?: z.infer<typeof appIntegrationInstallReadinessSchema>;
  status: "installed" | "omitted";
  stderr: string;
}

export const appIntegrationsInstallCommand = (appId: string): string =>
  `mise //apps/integrations:install ${appIdSchema.parse(appId)}`;

const integrationInstallReceipt = (appId: string) => {
  const common = { appId: z.literal(appId), files: z.array(z.string()) };
  return z.discriminatedUnion("status", [
    z.object({
      ...common,
      providers: z.array(z.enum(["quickbooks", "xero", "ramp"])).max(0),
      readiness: z.never().optional(),
      status: z.literal("omitted"),
    }),
    z.object({
      ...common,
      providers: z.array(z.enum(["quickbooks", "xero", "ramp"])).min(1),
      readiness: appIntegrationInstallReadinessSchema.optional(),
      status: z.literal("installed"),
    }),
  ]);
};

const installationFailureProblem = (stdout: string, appId: string): string | undefined => {
  try {
    const receipt = z
      .object({
        appId: z.literal(appId),
        problem: z.string(),
        status: z.literal("capability-gap"),
      })
      .safeParse(JSON.parse(stdout));
    return receipt.success ? safeCommandOutput(receipt.data.problem) : undefined;
  } catch {
    return undefined;
  }
};

/** Fixed repository operation; neither input nor product prose can supply a command. */
export const installAppIntegrations = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}) => {
  const command = appIntegrationsInstallCommand(input.appId);
  try {
    const commandInput: SandboxRunInput = {
      command,
      workingDirectory: input.root,
    };
    if (input.signal !== undefined) commandInput.abortSignal = input.signal;
    const result = await input.sandbox.run(commandInput);
    const stderr = safeCommandOutput(result.stderr);
    if (result.exitCode !== 0) {
      return {
        command,
        exitCode: result.exitCode,
        problem:
          (result.exitCode === 2
            ? installationFailureProblem(result.stdout, input.appId)
            : undefined) ??
          "The app integration installer failed or reported an unavailable provider/server binding. Inspect the selected checkout's executable integration definition and repair the reported repository failure before retrying. No provider connection or activation is established by installation.",
        status: "failed" as const,
        stderr,
        stdout: safeCommandOutput(result.stdout),
      };
    }
    const receipt = integrationInstallReceipt(input.appId).parse(JSON.parse(result.stdout));
    const successResult: IntegrationInstallSuccess = {
      capabilityState: receipt.status === "omitted" ? "source-omitted" : "source-installed",
      command,
      exitCode: 0,
      files: receipt.files.map((file) => safeCommandOutput(file)),
      nextStep:
        receipt.status === "omitted"
          ? "Continue normal app validation and delivery planning. Source opt-in is omitted; preserve retained bindings and resources through their existing release reconciliation."
          : "Validate the installed source. Any runtime capability setup and provider effects remain separate approved operations.",
      providerReadiness: "unverified",
      providers: receipt.providers,
      status: receipt.status,
      stderr,
    };
    if (receipt.readiness !== undefined) {
      successResult.readiness = receipt.readiness;
    }
    return successResult;
  } catch (error) {
    return {
      command,
      exitCode: null,
      problem:
        "The private checkout's integration installer could not complete or return a valid result for the selected app. Retry this saved build after repairing the actual repository command or execution failure.",
      status: "failed" as const,
      stderr: safeCommandOutput(error instanceof Error ? error.message : String(error)),
      stdout: "",
    };
  }
};

export default defineTool({
  description:
    "Install or reconcile explicitly requested app integrations in the already approved private checkout using the repository-owned integrations:install operation. For an active opt-in, first author app/integrations/definition.ts with supported executable provider recipes bound to the app's generated schema, and a real authorized server host. The operation installs selected ingress and optional shared integrations page/navigation, leaves ordinary apps alone, and reports unavailable capabilities. After an accepted revision defers integrations, remove the executable provider selection (or select providers:[]) and call this operation to reconcile unchanged generated surfaces. An omitted result continues ordinary app validation/delivery and never revokes retained bindings or deletes provider data. App-owned conflicts require an ordinary reviewed source repair. It does not connect an account, activate a binding, publish, deploy, or establish provider readiness. Revalidate and review the resulting app changes afterward.",
  async execute(_input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "applied" &&
      current.phase !== "validation_failed" &&
      current.phase !== "validated"
    ) {
      throw new Error(
        "Apply the accepted private app build before installing integrations; revalidate its changes afterward.",
      );
    }
    const sandbox = await getSourceBoundSandbox(ctx);
    updateExactWorkflow({
      expected: current,
      operation: "integration installation invalidates prior validation",
      transition: () => ({ ...current, phase: "applied" }),
    });
    invalidateProductBehaviorEvidence("source-repair");
    return await installAppIntegrations({
      appId: current.appSpec.appId,
      root: current.applyReceipt.applyRoot,
      sandbox,
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.strictObject({}),
});
