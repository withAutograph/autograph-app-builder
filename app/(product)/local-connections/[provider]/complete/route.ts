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
const invalidRequest = "Invalid request";

const formString = (value: FormDataEntryValue | null): string | null =>
  value instanceof File ? null : value;

const validEmulatorRedirect = (input: {
  response: Response;
  origin: string;
  path: string;
  state: string;
}): URL | null => {
  const location = input.response.headers.get("location");
  if (
    location === null ||
    location === "" ||
    input.response.status < 300 ||
    input.response.status >= 400
  ) {
    return null;
  }
  const destination = new URL(location);
  const matchesRoute = destination.origin === input.origin && destination.pathname === input.path;
  const hasSingleCode = destination.searchParams.getAll("code").length === 1;
  const hasSingleState = destination.searchParams.getAll("state").length === 1;
  const matchesState = destination.searchParams.get("state") === input.state;
  if (!matchesRoute || !hasSingleCode || !hasSingleState || !matchesState) {
    return null;
  }
  return destination;
};

const post = async (request: Request, context: { params: Promise<{ provider: string }> }) => {
  const { provider } = await context.params;
  let emulation;
  try {
    emulation = readProviderEmulation(process.env);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const origin = emulation?.canonicalOrigin;
  const providerAllowed = allowed.has(provider);
  const originMatches = request.headers.get("origin") === origin;
  if (!emulation || !providerAllowed || !originMatches) {
    return new Response("Not found", { status: 404 });
  }
  const form = await request.formData();
  const state = formString(form.get("state"));
  const phase = formString(form.get("phase"));
  const validState = state !== null && state.length >= 20 && state.length <= 2048;
  if (!validState || (phase !== null && phase !== "authorize")) {
    return new Response(invalidRequest, { status: 400 });
  }
  const callback = new URL(`/${provider}/installations/callback`, origin);
  callback.searchParams.set("state", state);
  if (provider === "vercel") {
    if (phase !== null) {
      return new Response(invalidRequest, { status: 400 });
    }
    const relay = signLocalVercelRelay(
      {
        configurationId:
          process.env.EMULATE_VERCEL_CONFIGURATION_ID ?? EMULATED_VERCEL_CONFIGURATION_ID,
        expiresAt: Date.now() + 600_000,
        origin,
        state,
        teamId: process.env.EMULATE_VERCEL_TEAM_ID ?? EMULATED_VERCEL_TEAM_ID,
      },
      emulation.relaySecret,
    );
    const redirectUri = `${origin}/local-connections/vercel/oauth-callback`;
    const response = await providerEmulationFetch(
      new URL(`${emulation.vercelOrigin}/oauth/authorize/callback`),
      {
        body: new URLSearchParams({
          client_id: emulation.vercelClientId,
          redirect_uri: redirectUri,
          state: relay,
          username: "autograph-dev",
        }),
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual",
      },
      emulation,
    );
    const destination = validEmulatorRedirect({
      origin,
      path: "/local-connections/vercel/oauth-callback",
      response,
      state: relay,
    });
    if (!destination) {
      return new Response("Invalid emulated Vercel approval", { status: 400 });
    }
    return NextResponse.redirect(destination, { status: 303 });
  }

  if (phase === "authorize") {
    const clientId = formString(form.get("client_id"));
    const redirectUri = formString(form.get("redirect_uri"));
    const codeChallenge = formString(form.get("code_challenge"));
    const codeChallengeMethod = formString(form.get("code_challenge_method"));
    const clientMatches = clientId === emulation.githubClientId;
    const redirectMatches = redirectUri === `${origin}/github/installations/callback`;
    const challengeValid = codeChallenge !== null && /^[A-Za-z0-9_-]{43}$/u.test(codeChallenge);
    const methodMatches = codeChallengeMethod === "S256";
    if (!clientMatches || !redirectMatches || !challengeValid || !methodMatches) {
      return new Response(invalidRequest, { status: 400 });
    }
    const response = await providerEmulationFetch(
      new URL(`${emulation.githubOrigin}/login/oauth/callback`),
      {
        body: new URLSearchParams({
          client_id: clientId,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          login: "autograph-dev",
          redirect_uri: redirectUri,
          state,
        }),
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual",
      },
      emulation,
    );
    const destination = validEmulatorRedirect({
      origin,
      path: "/github/installations/callback",
      response,
      state,
    });
    if (!destination) {
      return new Response("Invalid emulated GitHub approval", { status: 400 });
    }
    return NextResponse.redirect(destination, { status: 303 });
  }

  {
    callback.searchParams.set(
      "installation_id",
      process.env.EMULATE_GITHUB_INSTALLATION_ID ?? String(EMULATED_GITHUB_INSTALLATION_ID),
    );
    callback.searchParams.set("setup_action", "install");
  }
  return NextResponse.redirect(callback, { status: 303 });
};

export const POST = post;
