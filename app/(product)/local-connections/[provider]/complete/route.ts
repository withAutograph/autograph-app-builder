import { NextResponse } from "next/server";
import { signLocalVercelRelay } from "@/lib/integrations/local-oauth-relay";
import { readProviderEmulation } from "@/lib/integrations/local-provider-emulation";
import { providerEmulationFetch } from "@/lib/integrations/provider-emulation-fetch";
import {
  EMULATED_GITHUB_INSTALLATION_ID,
  EMULATED_VERCEL_CONFIGURATION_ID,
  EMULATED_VERCEL_TEAM_ID,
} from "@/lib/integrations/provider-emulation-seed";

const INVALID_REQUEST = "Invalid request";
const allowed = new Set(["vercel", "github"]);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function validEmulatorRedirect(input: {
  response: Response;
  origin: string;
  path: string;
  state: string;
}) {
  const location = input.response.headers.get("location");
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  if (!location || input.response.status < 300 || input.response.status >= 400) {
    return;
  }
  /* oxlint-enable typescript/strict-boolean-expressions */
  const destination = new URL(location);
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
    destination.origin !== input.origin ||
    destination.pathname !== input.path ||
    destination.searchParams.getAll("code").length !== 1 ||
    destination.searchParams.getAll("state").length !== 1 ||
    destination.searchParams.get("state") !== input.state
  ) {
    return;
  }
  // oxlint-disable-next-line typescript/consistent-return -- Preserve invalid emulator redirects as absent.
  return destination;
}

// oxlint-disable-next-line sonarjs/function-name, eslint/func-style -- Next.js discovers this named HTTP method export. Preserve function declaration hoisting and initialization timing.
export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
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
  const state = form.get("state");
  const phase = form.get("phase");
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity, anti-slop/no-runtime-typeof -- Preserve the existing conditions and their evaluation order; Preserve this runtime check and existing input handling.
    typeof state !== "string" ||
    state.length < 20 ||
    state.length > 2048 ||
    (phase !== null && phase !== "authorize")
  ) {
    return new Response(INVALID_REQUEST, { status: 400 });
  }
  const callback = new URL(`/${provider}/installations/callback`, origin);
  callback.searchParams.set("state", state);
  if (provider === "vercel") {
    if (phase !== null) {
      return new Response(INVALID_REQUEST, { status: 400 });
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
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    const codeChallenge = form.get("code_challenge");
    const codeChallengeMethod = form.get("code_challenge_method");
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
      clientId !== emulation.githubClientId ||
      redirectUri !== `${origin}/github/installations/callback` ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
      typeof codeChallenge !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) ||
      codeChallengeMethod !== "S256"
    ) {
      return new Response(INVALID_REQUEST, { status: 400 });
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
