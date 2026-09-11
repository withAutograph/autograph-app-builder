import { NextResponse } from "next/server";

import { parseLocalOAuthAuthorization } from "@/lib/auth/local-oauth-approval";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";
import { providerEmulationFetch } from "@/lib/integrations/provider-emulation-fetch";

export async function completeAuthorization(
  context: { params: Promise<{ provider: string }> },
  values: Record<string, string | undefined>
) {
  try {
    const { provider } = await context.params;
    const emulation = readProviderEmulation(process.env);
    if (!emulation) {
      throw new Error("Local authentication emulation is unavailable.");
    }
    const appOrigin = emulation.canonicalOrigin;
    const parsed = parseLocalOAuthAuthorization({
      appOrigin,
      emulation,
      githubClientId: emulation.githubClientId,
      provider,
      values,
      vercelClientId: emulation.vercelClientId,
    });
    const callback =
      parsed.provider === "github"
        ? new URL(`${emulation.githubOrigin}/login/oauth/callback`)
        : new URL(`${emulation.vercelOrigin}/oauth/authorize/callback`);
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
    const response = await providerEmulationFetch(
      callback,
      {
        body,
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual",
      },
      emulation
    );
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400) {
      throw new Error("Emulated OAuth approval failed.");
    }
    const destination = new URL(location);
    const callbackValidation = {
      codeCount: destination.searchParams.getAll("code").length,
      origin: destination.origin === appOrigin,
      path: destination.pathname === `/api/auth/callback/${parsed.provider}`,
      stateCount: destination.searchParams.getAll("state").length,
      stateMatches:
        destination.searchParams.get("state") === parsed.authorization.state,
    };
    if (
      !callbackValidation.origin ||
      !callbackValidation.path ||
      callbackValidation.codeCount !== 1 ||
      callbackValidation.stateCount !== 1 ||
      !callbackValidation.stateMatches
    ) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "local_oauth_callback_validation_failed",
          ...callbackValidation,
        })
      );
      throw new Error("Emulated OAuth callback is invalid.");
    }
    return NextResponse.redirect(destination, { status: 303 });
  } catch (error) {
    console.error(
      JSON.stringify({
        databaseHost: (() => {
          try {
            return new URL(process.env.DATABASE_URL ?? "").hostname;
          } catch {
            return "invalid";
          }
        })(),
        level: "error",
        message: "local_oauth_approval_failed",
        reason: error instanceof Error ? error.message : "unknown",
      })
    );
    return new Response("Invalid local OAuth approval", {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    });
  }
}
