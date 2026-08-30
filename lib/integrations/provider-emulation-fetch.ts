import type { ProviderEmulation } from "./local-provider-emulation";
import { invokePreviewEmulateRequest } from "./preview-emulate-handler";

export function providerEmulationFetch(
  input: string | URL,
  init: RequestInit | undefined,
  emulation: ProviderEmulation,
) {
  const url = new URL(input);
  if (emulation.mode === "local") return fetch(url, init);
  if (
    url.origin !== emulation.canonicalOrigin ||
    !url.pathname.startsWith("/api/emulate/")
  )
    throw new Error("Invalid Preview emulator request.");
  return invokePreviewEmulateRequest(new Request(url, init));
}
