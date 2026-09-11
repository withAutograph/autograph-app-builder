import { NextResponse } from "next/server";
import { verifyLocalVercelRelay } from "@/lib/integrations/local-oauth-relay";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";

export async function GET(request: Request) {
  let emulation;
  try {
    emulation = readProviderEmulation(process.env);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!emulation) return new Response("Not found", { status: 404 });
  const origin = emulation.canonicalOrigin;
  const query = new URL(request.url).searchParams;
  try {
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state) throw new Error("invalid");
    const relay = verifyLocalVercelRelay(
      state,
      emulation.relaySecret,
      Date.now(),
      origin,
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
