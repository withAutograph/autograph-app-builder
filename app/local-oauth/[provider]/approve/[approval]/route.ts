import { verifyLocalOAuthApproval } from "@/lib/auth/local-oauth-approval";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";

import { completeAuthorization } from "../route";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string; approval: string }> },
) {
  try {
    const emulation = readProviderEmulation(process.env);
    if (!emulation || emulation.mode !== "preview")
      throw new Error("Preview authentication emulation is unavailable.");
    const { provider, approval } = await context.params;
    const referer = new URL(request.headers.get("referer") ?? "");
    if (
      referer.origin !== emulation.canonicalOrigin ||
      referer.pathname !== `/local-oauth/${provider}/authorize`
    )
      throw new Error("Invalid approval referer.");
    const verified = verifyLocalOAuthApproval(
      approval,
      emulation.relaySecret,
    );
    if (
      verified.provider !== provider ||
      verified.origin !== emulation.canonicalOrigin
    )
      throw new Error("Invalid approval binding.");
    return completeAuthorization(
      request,
      { params: Promise.resolve({ provider }) },
      verified.authorization,
    );
  } catch {
    return new Response("Invalid local OAuth approval", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
