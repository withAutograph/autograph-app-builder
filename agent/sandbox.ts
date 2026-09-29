import { getBuilderSandboxId, simulatedSandboxIdentity } from "@/lib/sandbox/builder-sandbox";
import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
} from "@/lib/sandbox/development-toolchain";
import {
  HOSTED_BUN_RUNTIME_ENVIRONMENT,
  createHostedRuntimeInstaller,
  sanitizeHostedRuntimeFailure,
} from "@/lib/sandbox/hosted-bun-runtime";
import { createHostedVercelEnvironment } from "@/lib/sandbox/vercel-backend";
import { hasTestCapability } from "@/lib/testing/test-capability";

const installHostedRuntime = createHostedRuntimeInstaller();
const simulatedTarget = hasTestCapability("simulated-target");

export const environment = simulatedTarget
  ? JustBashSandbox.environment({ autoInstall: false })
  : createHostedVercelEnvironment({
      sandboxEnvironment:
        process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development"
          ? DEVELOPMENT_SANDBOX_ENVIRONMENT
          : HOSTED_BUN_RUNTIME_ENVIRONMENT,
    });

export default defineSandbox(async ({ session }) => {
  if (simulatedTarget) {
    simulatedSandboxIdentity.update(() => session.id);
  }
  const sandbox = await environment.open();
  if (simulatedTarget) {
    return sandbox;
  }
  if (process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development") {
    const setup = await sandbox.run({ command: developmentPinnedToolchainCommand() });
    if (setup.exitCode !== 0) {
      throw new Error(
        `The Vercel Sandbox runtime setup failed: ${sanitizeHostedRuntimeFailure(setup.stderr || setup.stdout)}`,
      );
    }
  } else {
    await installHostedRuntime({ id: getBuilderSandboxId(sandbox), run: sandbox.run });
  }
  return sandbox;
});
