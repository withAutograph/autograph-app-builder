import { Sandbox } from "@vercel/sandbox";
import type { SandboxBackend, SandboxBackendHandle } from "eve/sandbox";

// This association comes from the authenticated Eve backend, never tool input.
const handles = new Map<string, SandboxBackendHandle<unknown>>();

export const withVercelPreviewProvider = <BO, SO>(
  backend: SandboxBackend<BO, SO>,
): SandboxBackend<BO, SO> => ({
  ...backend,
  async create(input) {
    const handle = await backend.create(input);
    const registered = handle as SandboxBackendHandle<unknown>;
    handles.set(handle.session.id, registered);
    const close = async (operation: "stop" | "shutdown") => {
      try {
        await handle[operation]();
      } finally {
        if (handles.get(handle.session.id) === registered) {
          handles.delete(handle.session.id);
        }
      }
    };
    return { ...handle, shutdown: () => close("shutdown"), stop: () => close("stop") };
  },
});

/** Uses the official SDK with the project's existing OIDC credentials. */
export const getVercelPreviewProvider = async (
  sandboxId: string,
  signal?: AbortSignal,
  resume = true,
): Promise<Sandbox> => {
  signal?.throwIfAborted();
  const handle = handles.get(sandboxId);
  if (!handle) {
    throw new Error("The current App Builder sandbox is not connected for preview startup.");
  }
  const { metadata } = await handle.captureState();
  if (typeof metadata.sandboxName !== "string") {
    throw new TypeError("The Vercel backend did not return its sandbox name for preview startup.");
  }
  signal?.throwIfAborted();
  return Sandbox.get({ name: metadata.sandboxName, resume, signal });
};
