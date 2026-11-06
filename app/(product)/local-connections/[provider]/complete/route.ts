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
const invalidRequest = () => new Response("Invalid request", { status: 400 });

const parseFormString = (value: FormDataEntryValue | null): string | null =>
  value instanceof File ? null : value;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function validEmulatorRedirect(input: {
  response: Response;
  origin: string;
  path: string;
  state: string;
}) {
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
  const hasSingleCode = destination.searchParams.getAll("code").length === 1;
  const hasSingleState = destination.searchParams.getAll("state").length === 1;
  const matchesCallback =
    destination.origin === input.origin && destination.pathname === input.path;
  if (
    !(matchesCallback && hasSingleCode && hasSingleState) ||
    destination.searchParams.get("state") !== input.state
  ) {
    return null;
  }
  return destination;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function handlePost(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  let emulation;
  try {
    emulation = readProviderEmulation(process.env);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const origin = emulation?.canonicalOrigin;
  if (!emulation || !allowed.has(provider) || request.headers.get("origin") !== origin) {
    return new Response("Not found", { status: 404 });
  }
  const form = await request.formData();
  const state = parseFormString(form.get("state"));
  const phase = parseFormString(form.get("phase"));
  const validState = state !== null && state.length >= 20 && state.length <= 2048;
  const validPhase = phase === null || phase === "authorize";
  if (!(validState && validPhase)) {
    return invalidRequest();
  }
  const callback = new URL(`/${provider}/installations/callback`, origin);
  callback.searchParams.set("state", state);
  if (provider === "vercel") {
    if (phase !== null) {
      return invalidRequest();
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
    const clientId = parseFormString(form.get("client_id"));
    const redirectUri = parseFormString(form.get("redirect_uri"));
    const codeChallenge = parseFormString(form.get("code_challenge"));
    const codeChallengeMethod = parseFormString(form.get("code_challenge_method"));
    const validChallenge = codeChallenge !== null && /^[A-Za-z0-9_-]{43}$/u.test(codeChallenge);
    const validGithubAuthorization =
      clientId === emulation.githubClientId &&
      redirectUri === `${origin}/github/installations/callback` &&
      validChallenge &&
      codeChallengeMethod === "S256";
    if (!validGithubAuthorization) {
      return invalidRequest();
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
}

export { handlePost as POST };
