import { defineSandbox, type SandboxBackendPrewarmInput } from "eve/sandbox";

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
import { createHostedVercelBackend } from "@/lib/sandbox/vercel-backend";
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
  await use();
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
  return defineSandbox({
    backend: createHostedVercelBackend({}),
    async onSession({ use }) {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
      await use({ networkPolicy: "deny-all" });
    },
  });
}

export default createVercelDefinition();
