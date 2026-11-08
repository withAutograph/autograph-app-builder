import { verifyLocalOAuthApproval } from "@/lib/auth/local-oauth-approval";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";

import { completeAuthorization } from "../completion";

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- Next.js discovers this named HTTP method export. Preserve function declaration hoisting and initialization timing.
export async function GET(
  _request: Request,
  context: { params: Promise<{ provider: string; approval: string }> },
) {
  let completion: ReturnType<typeof completeAuthorization>;
  try {
    const emulation = readProviderEmulation(process.env);
    if (!emulation || emulation.mode !== "preview") {
      throw new Error("Preview authentication emulation is unavailable.");
    }
    const { provider, approval } = await context.params;
    const verified = verifyLocalOAuthApproval(approval, emulation.relaySecret);
    if (verified.provider !== provider || verified.origin !== emulation.canonicalOrigin) {
      throw new Error("Invalid approval binding.");
    }
    completion = completeAuthorization(
      { params: Promise.resolve({ provider }) },
      verified.authorization,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "preview_oauth_approval_relay_failed",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
    return new Response("Invalid local OAuth approval", {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    });
  }
  return await completion;
}
