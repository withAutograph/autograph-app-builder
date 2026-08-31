import {
  SandboxTemplateNotProvisionedError,
  type SandboxBackend,
  type SandboxBackendPrewarmInput,
} from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

import { HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS } from "./hosted-toolchain";
import { assertHostedSandboxCommandAuthority } from "./deployment-execution-lease";
import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";
import { createBoundedSandboxBackend } from "./sandbox-command-adapter";

export interface HostedVercelBackendOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly networkPolicy: {
    readonly allow: readonly string[];
  };
  readonly resources: { readonly vcpus: 2 };
  readonly timeout: 900_000;
  readonly ports: readonly [];
  readonly sessionCreateOptions: () => {
    readonly networkPolicy: "deny-all";
  };
}

export type HostedVercelBackendFactory = (
  options: HostedVercelBackendOptions,
) => ReturnType<typeof vercel>;

type RuntimeRecoveryPrewarmInput<BO = Record<string, never>> = Readonly<{
  bootstrap: NonNullable<SandboxBackendPrewarmInput<BO>["bootstrap"]>;
  seedFiles: SandboxBackendPrewarmInput<BO>["seedFiles"];
}>;

export interface HostedVercelBackendInput {
  readonly factory?: HostedVercelBackendFactory;
  readonly bootstrapNetworkHosts?: readonly string[];
  readonly sandboxEnvironment?: Readonly<Record<string, string>>;
  /** Maps Eve's authored key to a provider cache key when reuse has a narrower identity. */
  readonly providerTemplateKey?: (authoredTemplateKey: string) => string;
  readonly runtimeRecoveryPrewarmInput: () => RuntimeRecoveryPrewarmInput;
}

function createRuntimeRecoveringBackend<BO, SO>(input: {
  readonly backend: SandboxBackend<BO, SO>;
  readonly providerTemplateKey?: (authoredTemplateKey: string) => string;
  readonly resolvePrewarmInput: () => RuntimeRecoveryPrewarmInput<BO>;
}): SandboxBackend<BO, SO> {
  const providerTemplateKey = (authoredTemplateKey: string | null) =>
    authoredTemplateKey === null
      ? null
      : (input.providerTemplateKey?.(authoredTemplateKey) ??
        authoredTemplateKey);
  return {
    name: input.backend.name,
    prewarm: (prewarmInput) =>
      input.backend.prewarm({
        ...prewarmInput,
        templateKey: providerTemplateKey(prewarmInput.templateKey)!,
      }),
    async create(createInput) {
      const providerCreateInput = {
        ...createInput,
        templateKey: providerTemplateKey(createInput.templateKey),
      };
      try {
        return await input.backend.create(providerCreateInput);
      } catch (error) {
        if (
          providerCreateInput.templateKey === null ||
          !SandboxTemplateNotProvisionedError.is(error) ||
          error.templateKey !== providerCreateInput.templateKey
        )
          throw error;

        const recovery = input.resolvePrewarmInput();
        await input.backend.prewarm({
          bootstrap: recovery.bootstrap,
          runtimeContext: createInput.runtimeContext,
          seedFiles: recovery.seedFiles,
          templateKey: providerCreateInput.templateKey,
        });
        return await input.backend.create(providerCreateInput);
      }
    },
  };
}

/**
 * Keeps network authority different for the reusable template and every live
 * session. Only template construction may download the pinned toolchain.
 */
export function createHostedVercelBackend(
  input: HostedVercelBackendInput,
): ReturnType<typeof vercel> {
  // Eve merges session-only creation options into the provider request,
  // although its public return type currently names only mounts. Keep the
  // compatibility assertion isolated at this boundary.
  const factory =
    input.factory ?? (vercel as unknown as HostedVercelBackendFactory);
  const backend = factory({
    ...(input.sandboxEnvironment === undefined
      ? {}
      : { env: { ...input.sandboxEnvironment } }),
    networkPolicy: {
      allow: [
        ...(input.bootstrapNetworkHosts ?? HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS),
      ],
    },
    resources: { vcpus: SANDBOX_EXECUTION_POLICY.provider.vcpus },
    timeout: SANDBOX_EXECUTION_POLICY.provider.timeoutMs,
    ports: SANDBOX_EXECUTION_POLICY.provider.ports,
    // Eve resolves this for every fresh live session, including a replacement
    // created after the provider loses the previously recorded sandbox.
    sessionCreateOptions: () => ({
      networkPolicy: SANDBOX_EXECUTION_POLICY.provider.networkPolicy,
    }),
  });
  const bounded = createBoundedSandboxBackend({
    backend,
    authorizeSessionCommand: (sessionId) =>
      assertHostedSandboxCommandAuthority({ sessionId }),
  });
  return createRuntimeRecoveringBackend({
    backend: bounded,
    providerTemplateKey: input.providerTemplateKey,
    resolvePrewarmInput: input.runtimeRecoveryPrewarmInput,
  }) as ReturnType<typeof vercel>;
}
