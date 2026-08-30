import { NextResponse } from "next/server";
import { signLocalVercelRelay } from "@/lib/integrations/local-oauth-relay";

const allowed = new Set(["vercel", "github"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  const origin = new URL(process.env.APP_ORIGIN ?? request.url).origin;
  if (
    process.env.APP_BUILDER_LOCAL_PROVIDER_EMULATION !== "1" ||
    process.env.NODE_ENV === "production" ||
    !allowed.has(provider) ||
    request.headers.get("origin") !== origin
  )
    return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const state = form.get("state");
  const phase = form.get("phase");
  if (typeof state !== "string" || state.length > 2048)
    return new Response("Invalid request", { status: 400 });
  const callback = new URL(`/${provider}/installations/callback`, origin);
  callback.searchParams.set("state", state);
  if (provider === "vercel") {
    const secret = process.env.EMULATE_LOCAL_RELAY_SECRET;
    if (!secret)
      return new Response("Local relay unavailable", { status: 503 });
    const relay = signLocalVercelRelay(
      {
        state,
        configurationId:
          process.env.EMULATE_VERCEL_CONFIGURATION_ID ?? "icfg_local_1",
        teamId: process.env.EMULATE_VERCEL_TEAM_ID ?? "autograph-local",
        expiresAt: Date.now() + 600_000,
      },
      secret,
    );
    const authorize = new URL(
      "/oauth/authorize",
      process.env.VERCEL_EMULATOR_URL,
    );
    authorize.searchParams.set(
      "client_id",
      process.env.VERCEL_INTEGRATION_CLIENT_ID ?? "local-vercel-client",
    );
    authorize.searchParams.set(
      "redirect_uri",
      `${origin}/local-connections/vercel/oauth-callback`,
    );
    authorize.searchParams.set("state", relay);
    return NextResponse.redirect(authorize, { status: 303 });
  } else {
    callback.searchParams.set(
      "installation_id",
      process.env.EMULATE_GITHUB_INSTALLATION_ID ?? "1001",
    );
    callback.searchParams.set("setup_action", "install");
  }
  return NextResponse.redirect(callback, { status: 303 });
}
