import { vercel } from "eve/sandbox/vercel";

import { HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS } from "./hosted-toolchain";

export interface HostedVercelBackendOptions {
  readonly networkPolicy: {
    readonly allow: readonly string[];
  };
  readonly resources: { readonly vcpus: 2 };
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
  return factory({
    networkPolicy: { allow: [...HOSTED_TOOLCHAIN_DOWNLOAD_HOSTS] },
    resources: { vcpus: 2 },
    // Eve resolves this for every fresh live session, including a replacement
    // created after the provider loses the previously recorded sandbox.
    sessionCreateOptions: () => ({ networkPolicy: "deny-all" }),
  });
}
