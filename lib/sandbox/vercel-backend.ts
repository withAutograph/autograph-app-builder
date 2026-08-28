import { vercel } from "eve/sandbox/vercel";

import { HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS } from "./hosted-toolchain";
import { assertHostedSandboxCommandAuthority } from "./deployment-execution-lease";
import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";
import { createBoundedSandboxBackend } from "./sandbox-command-adapter";

export interface HostedVercelBackendOptions {
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

/**
 * Keeps network authority different for the reusable template and every live
 * session. Only template construction may download the pinned toolchain.
 */
export function createHostedVercelBackend(
  // Eve 0.43's implementation merges session-only creation options into the
  // provider request, although its public return type currently names only
  // mounts. Keep the compatibility assertion isolated at this boundary.
  factory: HostedVercelBackendFactory = vercel as unknown as HostedVercelBackendFactory,
): ReturnType<typeof vercel> {
  const backend = factory({
    networkPolicy: { allow: [...HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS] },
    resources: { vcpus: SANDBOX_EXECUTION_POLICY.provider.vcpus },
    timeout: SANDBOX_EXECUTION_POLICY.provider.timeoutMs,
    ports: SANDBOX_EXECUTION_POLICY.provider.ports,
    // Eve resolves this for every fresh live session, including a replacement
    // created after the provider loses the previously recorded sandbox.
    sessionCreateOptions: () => ({
      networkPolicy: SANDBOX_EXECUTION_POLICY.provider.networkPolicy,
    }),
  });
  return createBoundedSandboxBackend({
    backend,
    authorizeSessionCommand: (sessionId) =>
      assertHostedSandboxCommandAuthority({ sessionId }),
  }) as ReturnType<typeof vercel>;
}
