import { NextResponse } from "next/server";

import { parseLocalOAuthAuthorization } from "@/lib/auth/local-oauth-approval";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";

export async function completeAuthorization(
  context: { params: Promise<{ provider: string }> },
  values: Record<string, string | undefined>,
) {
  try {
    const { provider } = await context.params;
    const emulation = readProviderEmulation(process.env);
    if (!emulation)
      throw new Error("Local authentication emulation is unavailable.");
    const appOrigin = emulation.canonicalOrigin;
    const parsed = parseLocalOAuthAuthorization({
      provider,
      values,
      appOrigin,
      emulation,
      githubClientId: emulation.githubClientId,
      vercelClientId: emulation.vercelClientId,
    });
    const callback =
      parsed.provider === "github"
        ? new URL("/login/oauth/callback", emulation.githubOrigin)
        : new URL("/oauth/authorize/callback", emulation.vercelOrigin);
    const body = new URLSearchParams({
      [parsed.provider === "github" ? "login" : "username"]: "autograph-dev",
      redirect_uri: parsed.authorization.redirect_uri,
      scope: parsed.authorization.scope,
      state: parsed.authorization.state,
      client_id: parsed.authorization.client_id,
      ...(parsed.authorization.code_challenge
        ? {
            code_challenge: parsed.authorization.code_challenge,
            code_challenge_method: parsed.authorization.code_challenge_method!,
          }
        : {}),
    });
    const response = await fetch(callback, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
      cache: "no-store",
    });
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400)
      throw new Error("Emulated OAuth approval failed.");
    const destination = new URL(location);
    if (
      destination.origin !== appOrigin ||
      destination.pathname !== `/api/auth/callback/${parsed.provider}` ||
      destination.searchParams.getAll("code").length !== 1 ||
      destination.searchParams.getAll("state").length !== 1 ||
      destination.searchParams.get("state") !== parsed.authorization.state
    )
      throw new Error("Emulated OAuth callback is invalid.");
    return NextResponse.redirect(destination, { status: 303 });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "local_oauth_approval_failed",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
    return new Response("Invalid local OAuth approval", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
