import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { drizzle } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { expect, test } from "playwright/test";
import type { Page } from "playwright/test";
import postgres from "postgres";

import { cursorClientId, cursorRedirectUri, setupCursorClient } from "../../lib/auth/cursor-client";
import { previewOAuthScopes } from "../../lib/auth/preview-oauth-contract";
import * as schema from "../../lib/db/schema";
import {
  appOrigin,
  applicationCounts,
  currentSession,
  databaseUrl,
  finishOAuth,
  githubEmulatorOrigin,
  installProvider,
  resetApplicationState,
  vercelEmulatorOrigin,
} from "../support/harness";

// Authorization codes, browser cookies, and tokens must not enter artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.beforeEach(async () => resetApplicationState());
let callbackServer: Server | undefined;
test.afterEach(async () => {
  const server = callbackServer;
  callbackServer = undefined;
  if (server?.listening) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

const issuer = `${appOrigin}/api/auth`;
const resource = `${appOrigin}/mcp`;
interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
}

async function exchange(page: Page, form: Record<string, string>): Promise<Tokens> {
  // Catch transport/JSON failures so Playwright cannot render token request
  // parameters or raw provider errors in a failed assertion/report.
  try {
    const response = await page.request.post(`${issuer}/oauth2/token`, {
      headers: { origin: appOrigin },
      form: { client_id: cursorClientId, resource, ...form },
      maxRedirects: 0,
    });
    if (response.status() !== 200) {
      throw new Error("Token endpoint request failed.");
    }
    const value = await response.json();
    if (
      typeof value.access_token !== "string" ||
      typeof value.refresh_token !== "string" ||
      value.token_type !== "Bearer" ||
      value.scope !== previewOAuthScopes.join(" ")
    ) {
      throw new Error("Token response did not include the expected fields.");
    }
    return value as Tokens;
  } catch {
    throw new Error("Client OAuth token exchange failed; sensitive details omitted.");
  }
}

async function verifyOwner(page: Page, tokens: Tokens, ownerUserId: string, workspaceId: string) {
  let stage = "JWKS readback";
  try {
    const response = await page.request.get(`${issuer}/jwks`);
    if (!response.ok()) {
      throw new Error("JWKS request failed.");
    }
    stage = "signature, issuer, audience, and lifetime verification";
    const { payload } = await jwtVerify(
      tokens.access_token,
      createLocalJWKSet(await response.json()),
      {
        issuer,
        audience: resource,
        algorithms: ["ES256"],
      },
    );
    stage = "web owner comparison";
    if (payload.sub !== ownerUserId) {
      throw new Error("JWT owner does not match.");
    }
    stage = "web workspace comparison";
    if (payload.workspace_id !== workspaceId) {
      throw new Error("JWT workspace does not match.");
    }
  } catch {
    throw new Error(`Client OAuth ${stage} failed; sensitive details omitted.`);
  }
}

test("web login and both emulated connections survive Cursor consent, token refresh, and repeat grants", async ({
  page,
}) => {
  // The first cold Next development run compiles two provider callbacks,
  // provisioning, handoff, and consent routes within this single journey.
  test.setTimeout(180_000);
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await installProvider(page, "GitHub");
  await installProvider(page, "Vercel");
  const browserSession = await currentSession(page);
  const ownerUserId = browserSession?.user?.id;
  const organizationId = browserSession?.session?.activeOrganizationId;
  expect(typeof ownerUserId).toBe("string");
  expect(typeof organizationId).toBe("string");
  const before = await applicationCounts();
  expect(before.githubInstallations).toBeGreaterThan(0);
  expect(before.vercelInstallations).toBeGreaterThan(0);

  // Explicit local setup after the real browser login initializes OAuth. This
  // is the existing deployment helper, never request-time registration.
  const sql = postgres(databaseUrl, { max: 1 });
  let workspaceId: string;
  try {
    // Better Auth organization IDs and hosted workspace IDs are distinct.
    // Resolve the existing web membership instead of assuming they are equal.
    const memberships = await sql<{ workspace_id: string }[]>`
      SELECT o.workspace_id FROM organization o
      JOIN member m ON m.organization_id = o.id
      WHERE o.id = ${organizationId} AND m.user_id = ${ownerUserId}
        AND o.issuer = ${issuer} AND o.audience = ${resource}
    `;
    expect(memberships.length).toBe(1);
    workspaceId = memberships[0].workspace_id;
    expect(typeof workspaceId).toBe("string");
    await setupCursorClient(drizzle(sql, { schema }), resource);
  } finally {
    await sql.end();
  }
  await page.locator("#app-brief").fill("Build an authenticate-once acceptance app.");
  await page.getByLabel("App Name").fill("OAuth Continuity");
  await page.getByRole("radio", { name: "Cursor", exact: true }).check();
  await page.getByRole("button", { name: "Create App", exact: true }).click();
  await expect(page).toHaveURL(/\/handoff\/[0-9a-f-]{36}$/u, {
    timeout: 30_000,
  });
  const handoffPath = new URL(page.url()).pathname;
  const handoffId = handoffPath.split("/").at(-1)!;
  await page.getByText("Set up Autograph in Cursor", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Add Autograph to Cursor" })).toBeVisible();

  const providerAuthorizationRequests: string[] = [];
  let consentSubmissions = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    // The signed-in user's avatar is a provider read, not authorization.
    const avatarRead =
      url.origin === githubEmulatorOrigin &&
      url.pathname.startsWith("/avatars/") &&
      request.method() === "GET" &&
      request.resourceType() === "image";
    if (
      ([githubEmulatorOrigin, vercelEmulatorOrigin].includes(url.origin) && !avatarRead) ||
      /^\/(?:local-oauth|local-connections)\//u.test(url.pathname) ||
      /\/api\/auth\/(?:sign-in|oauth2\/authorize-provider|oauth2\/link)/u.test(url.pathname)
    ) {
      providerAuthorizationRequests.push(
        `${request.method()} ${url.pathname} ${request.resourceType()} prefetch=${request.headers()["next-router-prefetch"] ?? "none"}`,
      );
    }
    if (
      url.origin === appOrigin &&
      url.pathname === "/api/auth/oauth2/consent" &&
      request.method() === "POST"
    ) {
      consentSubmissions += 1;
    }
  });

  let callback: URL | undefined;
  // A loopback test receiver handles both consent's browser navigation and
  // repeat consent's HTTP redirect. It stands in for the desktop callback
  // listener only; no authorization response or token is fabricated.
  callbackServer = createServer((request, response) => {
    const target = new URL(request.url ?? "/", cursorRedirectUri);
    if (request.method !== "GET" || target.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    callback = target;
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end("<!doctype html><title>OAuth callback received</title>");
  });
  await new Promise<void>((resolve, reject) => {
    callbackServer!.once("error", () =>
      reject(new Error("Local OAuth callback port 8787 is unavailable.")),
    );
    callbackServer!.listen(8787, "127.0.0.1", resolve);
  });

  async function grant(first: boolean) {
    callback = undefined;
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const url = new URL(`${issuer}/oauth2/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: cursorClientId,
      redirect_uri: cursorRedirectUri,
      scope: previewOAuthScopes.join(" "),
      resource,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    try {
      await page.goto(url.toString());
    } catch {
      throw new Error("OAuth browser navigation failed; URL omitted.");
    }
    if (first) {
      // Read pathname/signature presence as booleans, avoiding sensitive URLs in reports.
      await expect.poll(() => new URL(page.url()).pathname).toBe("/auth/consent");
      expect(new URL(page.url()).searchParams.has("sig")).toBe(true);
      await expect(page.getByText("dev@autograph.local", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Allow", exact: true }).click();
    }
    await expect.poll(() => Boolean(callback), { timeout: 30_000 }).toBe(true);
    const received = callback as URL | undefined;
    if (
      !received ||
      received.searchParams.get("state") !== state ||
      !received.searchParams.get("code") ||
      received.searchParams.has("error")
    ) {
      throw new Error(
        "Cursor OAuth callback did not contain a valid state-bound authorization code.",
      );
    }
    const code = received.searchParams.get("code")!;
    try {
      // Receiving the request precedes the browser committing the callback
      // document. Wait for that navigation before leaving it.
      await page.waitForURL((target) => target.origin + target.pathname === cursorRedirectUri, {
        waitUntil: "load",
      });
      await page.goto(`${appOrigin}${handoffPath}`);
    } catch {
      throw new Error("OAuth callback navigation failed; URL omitted.");
    }
    return exchange(page, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: cursorRedirectUri,
    });
  }

  const first = await grant(true);
  await verifyOwner(page, first, ownerUserId, workspaceId);
  expect(consentSubmissions).toBe(1);
  const refreshed = await exchange(page, {
    grant_type: "refresh_token",
    refresh_token: first.refresh_token,
  });
  await verifyOwner(page, refreshed, ownerUserId, workspaceId);
  expect(refreshed.refresh_token !== first.refresh_token).toBe(true);
  const repeated = await grant(false);
  await verifyOwner(page, repeated, ownerUserId, workspaceId);
  expect(consentSubmissions).toBe(1);
  expect(providerAuthorizationRequests).toEqual([]);

  const after = await applicationCounts();
  expect(after.githubInstallations).toBe(before.githubInstallations);
  expect(after.vercelInstallations).toBe(before.vercelInstallations);
  expect(after.sessions).toBe(before.sessions);
  expect((await currentSession(page))?.user?.id === ownerUserId).toBe(true);
  const handoff = await page.request.get(`/api/builder/handoffs/${handoffId}`);
  expect(handoff.ok()).toBe(true);
  expect((await handoff.json()).status).toBe("prepared");
  await expect(page.getByText("Continued in your app", { exact: false })).toHaveCount(0);

  // dev-emulated configures browser OAuth but not MCP_OAUTH_* or the hosted
  // forwarder/workload identity. Do not fake /mcp redemption or engine proof.
});
