import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import { microsandbox } from "eve/sandbox/microsandbox";

import { sandboxBackendPlan } from "@/lib/sandbox/backend";
import {
  hostedToolchainBootstrapCommand,
  hostedToolchainRevalidationKey,
} from "@/lib/sandbox/hosted-toolchain";
import {
  configuredToolchainImage,
  sandboxRevalidationKey,
} from "@/lib/sandbox/toolchain";
import { createHostedVercelBackend } from "@/lib/sandbox/vercel-backend";
import { hasTestCapability } from "@/lib/testing/test-capability";

const image = configuredToolchainImage();
const useFixtureSandbox = hasTestCapability("simulated-target");
const plan = sandboxBackendPlan({
  fixture: useFixtureSandbox,
  localImageConfigured: image !== undefined,
});

const vercelDefinition = defineSandbox({
  backend: createHostedVercelBackend(),
  async bootstrap({ use }) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
    const sandbox = await use();
    const result = await sandbox.run({
      command: hostedToolchainBootstrapCommand(),
      abortSignal: AbortSignal.timeout(120_000),
    });
    if (result.exitCode !== 0)
      throw new Error("The pinned Vercel Sandbox toolchain failed to install.");
  },
  async onSession({ use }) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
    await use({ networkPolicy: "deny-all" });
  },
  revalidationKey: hostedToolchainRevalidationKey,
});

const microsandboxDefinition = defineSandbox({
  backend: microsandbox({
    image: image!,
    pullPolicy: "never",
    setup: { autoInstall: false },
    networkPolicy: "deny-all",
  }),
  async bootstrap({ use }) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Eve lifecycle callback, not a React hook.
    await use();
  },
  revalidationKey: () => sandboxRevalidationKey(image, plan.kind),
});

const nonExecutingDefinition = defineSandbox({
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

export default plan.kind === "vercel-preview"
  ? vercelDefinition
  : plan.kind === "local-microsandbox"
    ? microsandboxDefinition
    : nonExecutingDefinition;
