import { NextResponse } from "next/server";
import { signLocalVercelRelay } from "@/lib/integrations/local-oauth-relay";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";
import { providerEmulationFetch } from "@/lib/integrations/provider-emulation-fetch";
import {
  EMULATED_GITHUB_INSTALLATION_ID,
  EMULATED_VERCEL_CONFIGURATION_ID,
  EMULATED_VERCEL_TEAM_ID,
} from "@/lib/integrations/provider-emulation-seed";

const allowed = new Set(["vercel", "github"]);

function validEmulatorRedirect(input: {
  response: Response;
  origin: string;
  path: string;
  state: string;
}) {
  const location = input.response.headers.get("location");
  if (!location || input.response.status < 300 || input.response.status >= 400)
    return undefined;
  const destination = new URL(location);
  if (
    destination.origin !== input.origin ||
    destination.pathname !== input.path ||
    destination.searchParams.getAll("code").length !== 1 ||
    destination.searchParams.getAll("state").length !== 1 ||
    destination.searchParams.get("state") !== input.state
  )
    return undefined;
  return destination;
}

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
  const phase = form.get("phase");
  if (
    typeof state !== "string" ||
    state.length < 20 ||
    state.length > 2048 ||
    (phase !== null && phase !== "authorize")
  )
    return new Response("Invalid request", { status: 400 });
  const callback = new URL(`/${provider}/installations/callback`, origin);
  callback.searchParams.set("state", state);
  if (provider === "vercel") {
    if (phase !== null) return new Response("Invalid request", { status: 400 });
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
    const redirectUri = `${origin}/local-connections/vercel/oauth-callback`;
    const response = await providerEmulationFetch(
      new URL(`${emulation.vercelOrigin}/oauth/authorize/callback`),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: "autograph-dev",
          client_id: emulation.vercelClientId,
          redirect_uri: redirectUri,
          state: relay,
        }),
        redirect: "manual",
        cache: "no-store",
      },
      emulation,
    );
    const destination = validEmulatorRedirect({
      response,
      origin,
      path: "/local-connections/vercel/oauth-callback",
      state: relay,
    });
    if (!destination)
      return new Response("Invalid emulated Vercel approval", { status: 400 });
    return NextResponse.redirect(destination, { status: 303 });
  }

  if (phase === "authorize") {
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    const codeChallenge = form.get("code_challenge");
    const codeChallengeMethod = form.get("code_challenge_method");
    if (
      clientId !== emulation.githubClientId ||
      redirectUri !== `${origin}/github/installations/callback` ||
      typeof codeChallenge !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) ||
      codeChallengeMethod !== "S256"
    )
      return new Response("Invalid request", { status: 400 });
    const response = await providerEmulationFetch(
      new URL(`${emulation.githubOrigin}/login/oauth/callback`),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          login: "autograph-dev",
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
        }),
        redirect: "manual",
        cache: "no-store",
      },
      emulation,
    );
    const destination = validEmulatorRedirect({
      response,
      origin,
      path: "/github/installations/callback",
      state,
    });
    if (!destination)
      return new Response("Invalid emulated GitHub approval", { status: 400 });
    return NextResponse.redirect(destination, { status: 303 });
  }

  {
    callback.searchParams.set(
      "installation_id",
      process.env.EMULATE_GITHUB_INSTALLATION_ID ??
        String(EMULATED_GITHUB_INSTALLATION_ID),
    );
    callback.searchParams.set("setup_action", "install");
  }
  return NextResponse.redirect(callback, { status: 303 });
}
