import { defineSandbox, type SandboxBackendPrewarmInput } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { microsandbox } from "eve/sandbox/microsandbox";

import {
  sandboxBackendPlan,
  selectSandboxDefinition,
} from "@/lib/sandbox/backend";
import {
  DEVELOPMENT_SANDBOX_DOWNLOAD_HOSTS,
  DEVELOPMENT_SANDBOX_ENVIRONMENT,
  DEVELOPMENT_SOURCE_ARCHIVE_PATH,
  developmentPinnedToolchainCommand,
  developmentVercelDependencyCommand,
  developmentVercelProviderTemplateKey,
  developmentVercelRevalidationKey,
  readDevelopmentVercelBootstrapInput,
} from "@/lib/sandbox/development-toolchain";
import {
  HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS,
  HOSTED_TOOLCHAIN_PREWARM_TIMEOUT_MS,
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

const image = configuredToolchainImage();
const useFixtureSandbox = hasTestCapability("simulated-target");
const useHostedArtifactProof =
  process.env.APP_BUILDER_HOSTED_ARTIFACT_PROOF === "1" &&
  hasTestCapability("mock-model");
const plan = sandboxBackendPlan({
  fixture: useFixtureSandbox,
  localImageConfigured: image !== undefined,
});
let developmentBootstrap:
  ReturnType<typeof readDevelopmentVercelBootstrapInput> | undefined;

function getDevelopmentBootstrap() {
  developmentBootstrap ??= readDevelopmentVercelBootstrapInput();
  return developmentBootstrap;
}

const bootstrapHostedVercelSandbox: NonNullable<
  SandboxBackendPrewarmInput["bootstrap"]
> = async ({ use }) => {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
  const sandbox = await use();
  const result = await sandbox.run({
    command: hostedToolchainBootstrapCommand(),
    abortSignal: AbortSignal.timeout(HOSTED_TOOLCHAIN_PREWARM_TIMEOUT_MS),
  });
  if (result.exitCode !== 0)
    throw new Error("The hosted Vercel Sandbox toolchain failed to prewarm.");
};

const bootstrapDevelopmentVercelSandbox: NonNullable<
  SandboxBackendPrewarmInput["bootstrap"]
> = async ({ use }) => {
  const bootstrap = getDevelopmentBootstrap();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
  const sandbox = await use();
  await sandbox.writeBinaryFile({
    path: DEVELOPMENT_SOURCE_ARCHIVE_PATH,
    content: bootstrap.sourceArchive,
  });
  for (const [command, timeoutMs, successMarker] of [
    [
      developmentPinnedToolchainCommand(),
      300_000,
      "development_toolchain_ready",
    ],
    [
      developmentVercelDependencyCommand(bootstrap),
      900_000,
      "development_vercel_",
    ],
  ] as const) {
    const result = await sandbox.run({
      command,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    if (result.exitCode !== 0 && !result.stdout.includes(successMarker)) {
      const stage = result.stderr.match(
        /(?:development_toolchain_failed|development_vercel_bootstrap_failed):[a-z-]+/u,
      )?.[0];
      throw new Error(
        `The Development Vercel Sandbox failed to prepare (${stage ?? "unknown-stage"}).`,
      );
    }
  }
};

function createVercelDefinition() {
  if (plan.kind === "vercel-development") {
    const dependencyKey = process.env.APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY;
    if (dependencyKey === undefined)
      throw new Error("The Development Vercel dependency key was unavailable.");
    const providerTemplateKey =
      developmentVercelProviderTemplateKey(dependencyKey);
    return defineSandbox({
      backend: createHostedVercelBackend({
        bootstrapNetworkHosts: DEVELOPMENT_SANDBOX_DOWNLOAD_HOSTS,
        sandboxEnvironment: DEVELOPMENT_SANDBOX_ENVIRONMENT,
        providerTemplateKey: () => providerTemplateKey,
        reuseProcessSessionHandles: true,
        runtimeRecoveryPrewarmInput: () => ({
          bootstrap: bootstrapDevelopmentVercelSandbox,
          seedFiles: readHostedManagedSeedFiles(),
        }),
      }),
      bootstrap: bootstrapDevelopmentVercelSandbox,
      async onSession({ use }) {
        // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
        await use({ networkPolicy: "deny-all" });
      },
      revalidationKey: () =>
        developmentVercelRevalidationKey({ dependencyKey }),
    });
  }
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
    revalidationKey: () =>
      `${sandboxRevalidationKey(undefined, plan.kind)}:${hostedToolchainRevalidationKey()}`,
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
      const sandbox = await use(
        useHostedArtifactProof
          ? { networkPolicy: { allow: [...HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS] } }
          : undefined,
      );
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
    async onSession({ use }) {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
      await use({ networkPolicy: "deny-all" });
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
