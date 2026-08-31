import { NextResponse } from "next/server";
import { signLocalVercelRelay } from "@/lib/integrations/local-oauth-relay";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";
import {
  EMULATED_GITHUB_INSTALLATION_ID,
  EMULATED_VERCEL_CONFIGURATION_ID,
  EMULATED_VERCEL_TEAM_ID,
} from "@/lib/integrations/provider-emulation-seed";

const allowed = new Set(["vercel", "github"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  let emulation;
  try {
    emulation = readProviderEmulation(process.env);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const origin = emulation?.canonicalOrigin;
  if (
    !emulation ||
    !allowed.has(provider) ||
    request.headers.get("origin") !== origin
  )
    return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const state = form.get("state");
  if (typeof state !== "string" || state.length > 2048)
    return new Response("Invalid request", { status: 400 });
  const callback = new URL(`/${provider}/installations/callback`, origin);
  callback.searchParams.set("state", state);
  if (provider === "vercel") {
    const relay = signLocalVercelRelay(
      {
        state,
        configurationId:
          process.env.EMULATE_VERCEL_CONFIGURATION_ID ??
          EMULATED_VERCEL_CONFIGURATION_ID,
        teamId: process.env.EMULATE_VERCEL_TEAM_ID ?? EMULATED_VERCEL_TEAM_ID,
        origin,
        expiresAt: Date.now() + 600_000,
      },
      emulation.relaySecret,
    );
    const authorize = new URL(`${emulation.vercelOrigin}/oauth/authorize`);
    authorize.searchParams.set("client_id", emulation.vercelClientId);
    authorize.searchParams.set(
      "redirect_uri",
      `${origin}/local-connections/vercel/oauth-callback`,
    );
    authorize.searchParams.set("state", relay);
    return NextResponse.redirect(authorize, { status: 303 });
  } else {
    callback.searchParams.set(
      "installation_id",
      process.env.EMULATE_GITHUB_INSTALLATION_ID ??
        String(EMULATED_GITHUB_INSTALLATION_ID),
    );
    callback.searchParams.set("setup_action", "install");
  }
  return NextResponse.redirect(callback, { status: 303 });
}
