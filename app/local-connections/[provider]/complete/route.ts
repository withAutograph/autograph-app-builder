import { NextResponse } from "next/server";

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
    callback.searchParams.set("code", "emulated");
    callback.searchParams.set(
      "configurationId",
      process.env.EMULATE_VERCEL_CONFIGURATION_ID ?? "icfg_local_1",
    );
    callback.searchParams.set(
      "teamId",
      process.env.EMULATE_VERCEL_TEAM_ID ?? "autograph-local",
    );
  } else if (phase === "authorize") {
    callback.searchParams.set("code", "emulated");
  } else {
    callback.searchParams.set(
      "installation_id",
      process.env.EMULATE_GITHUB_INSTALLATION_ID ?? "1001",
    );
    callback.searchParams.set("setup_action", "install");
  }
  return NextResponse.redirect(callback, { status: 303 });
}
