import { Sandbox } from "@vercel/sandbox";

// Authenticated provider handles own this association, never tool input.
const providers = new Map<string, Sandbox>();

export const registerVercelPreviewProvider = (id: string, provider: Sandbox) => {
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) {
      providers.delete(id);
    }
  };
};

/** Uses the same authenticated SDK instance and project-scoped OIDC boundary. */
export const getVercelPreviewProvider = async (
  sandboxId: string,
  signal?: AbortSignal,
  resume = true,
): Promise<Sandbox> => {
  signal?.throwIfAborted();
  const provider = providers.get(sandboxId);
  if (!provider) {
    throw new Error("The current App Builder sandbox is not connected for preview startup.");
  }
  if (resume && provider.status !== "running") {
    return await Sandbox.get({ name: provider.name, resume, signal });
  }
  return provider;
};
