import { defineSandbox } from "eve/sandbox";

import {
  DEVELOPMENT_SANDBOX_DOWNLOAD_HOSTS,
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  developmentPinnedToolchainCommand,
} from "@/lib/sandbox/development-toolchain";
import { createHostedVercelBackend } from "@/lib/sandbox/vercel-backend";

function createVercelDefinition() {
  return defineSandbox({
    backend: createHostedVercelBackend({
      ...(process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development"
        ? {
            bootstrapNetworkHosts: DEVELOPMENT_SANDBOX_DOWNLOAD_HOSTS,
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
      if (process.env.APP_BUILDER_EXECUTION_BUNDLE !== "local-development")
        await sandbox.setNetworkPolicy("deny-all");
    },
  });
}

export default createVercelDefinition();
