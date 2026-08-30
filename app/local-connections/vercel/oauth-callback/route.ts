import { NextResponse } from "next/server";
import { verifyLocalVercelRelay } from "@/lib/integrations/local-oauth-relay";

export async function GET(request: Request) {
  const origin = new URL(process.env.APP_ORIGIN ?? request.url).origin;
  if (
    process.env.APP_BUILDER_LOCAL_PROVIDER_EMULATION !== "1" ||
    process.env.NODE_ENV === "production"
  )
    return new Response("Not found", { status: 404 });
  const query = new URL(request.url).searchParams;
  try {
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state || !process.env.EMULATE_LOCAL_RELAY_SECRET)
      throw new Error("invalid");
    const relay = verifyLocalVercelRelay(
      state,
      process.env.EMULATE_LOCAL_RELAY_SECRET,
    );
    const callback = new URL("/vercel/installations/callback", origin);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", relay.state);
    callback.searchParams.set("configurationId", relay.configurationId);
    callback.searchParams.set("teamId", relay.teamId);
    return NextResponse.redirect(callback, { status: 303 });
  } catch {
    return new Response("Invalid local OAuth relay", { status: 400 });
  }
}
