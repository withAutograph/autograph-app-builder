import { NextResponse } from "next/server";

import { parseLocalOAuthAuthorization } from "@/lib/auth/local-oauth-approval";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider } = await context.params;
    const emulation = readProviderEmulation(process.env);
    if (!emulation)
      throw new Error("Local authentication emulation is unavailable.");
    const appOrigin = emulation.canonicalOrigin;
    if (request.headers.get("origin") !== appOrigin)
      throw new Error("Invalid approval origin.");
    const form = await request.formData();
    const parsed = parseLocalOAuthAuthorization({
      provider,
      values: Object.fromEntries(
        [
          "response_type",
          "client_id",
          "state",
          "scope",
          "redirect_uri",
          "code_challenge",
          "code_challenge_method",
        ].map((name) => [
          name,
          typeof form.get(name) === "string"
            ? String(form.get(name))
            : undefined,
        ]),
      ),
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
  } catch {
    return new Response("Invalid local OAuth approval", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
