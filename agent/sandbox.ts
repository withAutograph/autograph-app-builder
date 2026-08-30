import { defineSandbox, type SandboxBackendPrewarmInput } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { microsandbox } from "eve/sandbox/microsandbox";

import {
  sandboxBackendPlan,
  selectSandboxDefinition,
} from "@/lib/sandbox/backend";
import {
  hostedArtifactWorkspaceInstallCommand,
  hostedToolchainBootstrapCommand,
  hostedToolchainRevalidationKey,
} from "@/lib/sandbox/hosted-toolchain";
import {
  configuredToolchainImage,
  sandboxRevalidationKey,
} from "@/lib/sandbox/toolchain";
import { createHostedVercelBackend } from "@/lib/sandbox/vercel-backend";
import { readHostedManagedSeedFiles } from "@/lib/sandbox/hosted-managed-seeds";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { ensureSandboxDirectories } from "@/lib/repository/sandbox-filesystem";

const image = configuredToolchainImage();
const useFixtureSandbox = hasTestCapability("simulated-target");
const useHostedArtifactProof =
  process.env.APP_BUILDER_HOSTED_ARTIFACT_PROOF === "1" &&
  hasTestCapability("mock-model");
const plan = sandboxBackendPlan({
  fixture: useFixtureSandbox,
  localImageConfigured: image !== undefined,
});

const bootstrapHostedVercelSandbox: NonNullable<
  SandboxBackendPrewarmInput["bootstrap"]
> = async ({ use }) => {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
  const sandbox = await use();
  const result = await sandbox.run({
    command: hostedToolchainBootstrapCommand(),
    abortSignal: AbortSignal.timeout(120_000),
  });
  if (result.exitCode !== 0)
    throw new Error("The pinned Vercel Sandbox toolchain failed to install.");
};

function createVercelDefinition() {
  return defineSandbox({
    backend: createHostedVercelBackend({
      runtimeRecoveryPrewarmInput: () => ({
        bootstrap: bootstrapHostedVercelSandbox,
        seedFiles: readHostedManagedSeedFiles(),
      }),
    }),
    bootstrap: bootstrapHostedVercelSandbox,
    async onSession({ use }) {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
      await use({ networkPolicy: "deny-all" });
    },
    revalidationKey: hostedToolchainRevalidationKey,
  });
}

function createMicrosandboxDefinition() {
  return defineSandbox({
    backend: microsandbox({
      image: image!,
      pullPolicy: "never",
      setup: { autoInstall: false },
      networkPolicy: "deny-all",
    }),
    async bootstrap({ use }) {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
      const sandbox = await use();
      if (useHostedArtifactProof) {
        const result = await sandbox.run({
          command: hostedArtifactWorkspaceInstallCommand(),
          abortSignal: AbortSignal.timeout(120_000),
        });
        if (result.exitCode !== 0)
          throw new Error(
            "The hosted planning artifact failed to materialize.",
          );
      }
    },
    revalidationKey: () =>
      `${sandboxRevalidationKey(image, plan.kind)}:${
        useHostedArtifactProof ? hostedToolchainRevalidationKey() : "base"
      }`,
  });
}

function createNonExecutingDefinition() {
  return defineSandbox({
    // A missing or invalid external image is not allowed to fall back to Eve's
    // floating default image. just-bash has no real target toolchain, so the
    // typed inspection receipt remains fail-closed.
    backend: justbash({ autoInstall: false }),
    async bootstrap({ use }) {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
      await use();
    },
    revalidationKey: () => sandboxRevalidationKey(undefined, plan.kind),
  });
}

// Select the environment before exporting the definition so a hosted bundle
// never constructs Eve's deliberately pruned local backends. Eve reserves
// function-valued sandbox exports for parent-sandbox selectors, so this module
// must export the selected object directly.
export default selectSandboxDefinition(plan.kind, {
  localMicrosandbox: createMicrosandboxDefinition,
  nonExecuting: createNonExecutingDefinition,
  vercelHosted: createVercelDefinition,
});
