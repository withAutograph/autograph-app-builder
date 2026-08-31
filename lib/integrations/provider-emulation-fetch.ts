import type { ProviderEmulation } from "./local-provider-emulation";

export async function providerEmulationFetch(
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
  // Keep the embedded emulator out of unrelated auth requests. Besides making
  // sign-in startup lighter, this gives the emulator its own traced chunk with
  // its runtime assets instead of evaluating provider UI code at module load.
  const { invokePreviewEmulateRequest } =
    await import("./preview-emulate-handler");
  return invokePreviewEmulateRequest(new Request(url, init));
}
