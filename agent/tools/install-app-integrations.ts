import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { safeCommandOutput } from "@/lib/agent/command-output";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { invalidateProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";
import { appBuilderWorkflowState, updateExactWorkflow } from "@/lib/agent/workflow-state";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const appIntegrationsInstallCommand = (appId: string): string =>
  `mise run integrations:install ${appIdSchema.parse(appId)}`;

const installationFailureProblem = (stdout: string, appId: string): string | undefined => {
  try {
    const receipt = z
      .object({
        appId: z.literal(appId),
        status: z.literal("capability-gap"),
        problem: z.string(),
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
    const result = await input.sandbox.run({
      command,
      workingDirectory: input.root,
      ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
    });
    const stderr = safeCommandOutput(result.stderr);
    if (result.exitCode !== 0) {
      return {
        command,
        exitCode: result.exitCode,
        status: "failed" as const,
        problem:
          (result.exitCode === 2
            ? installationFailureProblem(result.stdout, input.appId)
            : undefined) ??
          "The app integration installer failed or reported an unavailable provider/server binding. Inspect the selected checkout's executable integration definition and repair the reported repository failure before retrying. No provider connection or activation is established by installation.",
        stderr,
        stdout: safeCommandOutput(result.stdout),
      };
    }
    const receipt = z
      .object({
        appId: z.literal(input.appId),
        status: z.enum(["omitted", "installed"]),
        files: z.array(z.string()),
        providers: z.array(z.enum(["quickbooks", "xero", "ramp"])),
      })
      .parse(JSON.parse(result.stdout));
    return {
      command,
      exitCode: 0,
      status: receipt.status,
      files: receipt.files.map((file) => safeCommandOutput(file)),
      providers: receipt.providers,
      providerReadiness: "unverified" as const,
      stderr,
    };
  } catch (error) {
    return {
      command,
      exitCode: null,
      status: "failed" as const,
      problem:
        "The private checkout's integration installer could not complete or return a valid result for the selected app. Retry this saved build after repairing the actual repository command or execution failure.",
      stderr: safeCommandOutput(error instanceof Error ? error.message : String(error)),
      stdout: "",
    };
  }
};

export default defineTool({
  description:
    "Install explicitly requested app integrations in the already approved private checkout using the repository-owned integrations:install operation. First author app/integrations/definition.ts with supported executable provider recipes bound to the app's generated schema, and a real authorized server host. The operation installs selected ingress and optional shared integrations page/navigation, leaves ordinary apps alone, and reports unavailable capabilities. It does not connect an account, activate a binding, publish, deploy, or establish provider readiness. Revalidate and review the resulting app changes afterward.",
  inputSchema: z.strictObject({}),
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
});
