/* oxlint-disable sonarjs/expression-complexity -- The provider replacement must match every exact owned name, Drive and active registration guard. */
import { assertPrivateComputeResumeAllowed } from "./private-compute-resume";
import { Sandbox } from "@vercel/sandbox";

// Authenticated provider handles own this association, never tool input.
interface ProviderRegistration {
  provider: Sandbox;
  closing: boolean;
  resuming: Promise<Sandbox> | null;
}
const providers = new Map<string, ProviderRegistration>();

const notConnected = () =>
  new Error("The current App Builder sandbox is not connected for preview startup.");

export const registerVercelPreviewProvider = (id: string, provider: Sandbox) => {
  const registration: ProviderRegistration = { closing: false, provider, resuming: null };
  providers.set(id, registration);
  return {
    get current() {
      if (registration.closing || providers.get(id) !== registration) {
        throw notConnected();
      }
      return registration.provider;
    },
    async currentForCleanup(allowUnregistered = false) {
      registration.closing = true;
      try {
        await registration.resuming;
      } catch {
        // A failed resume still leaves the original SDK handle to clean up.
      }
      const owner = providers.get(id);
      return owner === registration || (allowUnregistered && owner === undefined)
        ? registration.provider
        : undefined;
    },
    unregister() {
      if (providers.get(id) === registration) {
        providers.delete(id);
      }
    },
  };
};

/** Uses the same authenticated SDK instance and project-scoped OIDC boundary. */
export const getVercelPreviewProvider = async (
  sandboxId: string,
  signal?: AbortSignal,
  resume = true,
): Promise<Sandbox> => {
  signal?.throwIfAborted();
  const registration = providers.get(sandboxId);
  if (!registration || registration.closing) {
    throw notConnected();
  }
  const { provider } = registration;
  if (resume && provider.status !== "running") {
    registration.resuming ??= (async () => {
      try {
        const observed = await Sandbox.get({ name: provider.name, resume: false, signal });
        if (observed.status !== "running") {
          await assertPrivateComputeResumeAllowed(observed, () => {
            signal?.throwIfAborted();
          });
        }
        const reattached =
          observed.status === "running"
            ? observed
            : await Sandbox.get({ name: provider.name, resume, signal });
        // Cleanup waits for this owned resume, including when close has begun.
        if (providers.get(sandboxId) === registration) {
          registration.provider = reattached;
        }
        return reattached;
      } finally {
        registration.resuming = null;
      }
    })();
    const reattached = await registration.resuming;
    if (registration.closing || providers.get(sandboxId) !== registration) {
      throw notConnected();
    }
    return reattached;
  }
  return provider;
};
/** Replace only the same owned registration after a verified same-name provider session transition. */
export const replaceVercelPreviewProvider = (
  id: string,
  expected: Sandbox,
  replacement: Sandbox,
): void => {
  const registration = providers.get(id);
  if (
    !registration ||
    registration.closing ||
    registration.provider !== expected ||
    expected.name !== id ||
    replacement.name !== id ||
    JSON.stringify(expected.mounts) !== JSON.stringify(replacement.mounts)
  ) {
    throw new Error("The provider registration changed during the private compute transition.");
  }
  registration.provider = replacement;
};

/** Observe an existing local SDK registration without provider network or resume effects. */
export const peekVercelPreviewProvider = (sandboxId: string): Sandbox | undefined => {
  const registration = providers.get(sandboxId);
  return registration === undefined || registration.closing ? undefined : registration.provider;
};
