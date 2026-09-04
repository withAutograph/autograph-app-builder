import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

import {
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
} from "@/lib/sandbox/development-toolchain";
import { createHostedVercelBackend } from "@/lib/sandbox/vercel-backend";
import { hasTestCapability } from "@/lib/testing/test-capability";

function createVercelDefinition() {
  // Deterministic evals exercise fixture target behavior and must not acquire
  // provider credentials. Production and development continue to use Vercel.
  if (hasTestCapability("simulated-target")) {
    return defineSandbox({ backend: justbash({ autoInstall: false }) });
  }
  return defineSandbox({
    backend: createHostedVercelBackend({
      ...(process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development"
        ? {
            sandboxEnvironment: DEVELOPMENT_SANDBOX_ENVIRONMENT,
          }
        : {}),
    }),
    async onSession({ use }) {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
      const sandbox = await use({ networkPolicy: "allow-all" });
      if (process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development") {
        const setup = await sandbox.run({
          command: developmentPinnedToolchainCommand(),
          abortSignal: AbortSignal.timeout(300_000),
        });
        if (setup.exitCode !== 0)
          throw new Error(
            `The Vercel Sandbox runtime setup failed: ${(setup.stderr || setup.stdout).trim().slice(0, 2_000)}`,
          );
      }
    },
  });
}

export default createVercelDefinition();
