import { createHash, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { expect, test, type Page } from "playwright/test";
import postgres from "postgres";

import {
  cursorClientId,
  cursorRedirectUri,
  setupCursorClient,
} from "../../lib/auth/cursor-client";
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

const issuer = `${appOrigin}/api/auth`;
const resource = `${appOrigin}/mcp`;
type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
};

async function exchange(
  page: Page,
  form: Record<string, string>,
): Promise<Tokens> {
  // Catch transport/JSON failures so Playwright cannot render token request
  // parameters or raw provider errors in a failed assertion/report.
  try {
    const response = await page.request.post(`${issuer}/oauth2/token`, {
      headers: { origin: appOrigin },
      form: { client_id: cursorClientId, resource, ...form },
      maxRedirects: 0,
    });
    if (response.status() !== 200) throw new Error();
    const value = await response.json();
    if (
      typeof value.access_token !== "string" ||
      typeof value.refresh_token !== "string" ||
      value.token_type !== "Bearer" ||
      value.scope !== previewOAuthScopes.join(" ")
    )
      throw new Error();
    return value as Tokens;
  } catch {
    throw new Error(
      "Client OAuth token exchange failed; sensitive details omitted.",
    );
  }
}

async function verifyOwner(
  page: Page,
  tokens: Tokens,
  ownerUserId: string,
  workspaceId: string,
) {
  try {
    const response = await page.request.get(`${issuer}/jwks`);
    if (!response.ok()) throw new Error();
    const { payload } = await jwtVerify(
      tokens.access_token,
      createLocalJWKSet(await response.json()),
      {
        issuer,
        audience: resource,
        algorithms: ["ES256"],
      },
    );
    if (payload.sub !== ownerUserId || payload.workspace_id !== workspaceId)
      throw new Error();
  } catch {
    throw new Error(
      "Client OAuth token did not verify against the web user's identity and workspace.",
    );
  }
}

test("web login and both emulated connections survive Cursor consent, token refresh, and repeat grants", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await installProvider(page, "GitHub");
  await installProvider(page, "Vercel");
  const browserSession = await currentSession(page);
  const ownerUserId = browserSession?.user?.id;
  const workspaceId = browserSession?.session?.activeOrganizationId;
  expect(typeof ownerUserId).toBe("string");
  expect(typeof workspaceId).toBe("string");
  const before = await applicationCounts();
  expect(before.githubInstallations).toBeGreaterThan(0);
  expect(before.vercelInstallations).toBeGreaterThan(0);

  // Explicit local setup after the real browser login initializes OAuth. This
  // is the existing deployment helper, never request-time registration.
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await setupCursorClient(drizzle(sql, { schema }), resource);
  } finally {
    await sql.end();
  }
  await page
    .locator("#app-brief")
    .fill("Build an authenticate-once acceptance app.");
  await page.getByLabel("App Name").fill("OAuth Continuity");
  await page.getByRole("radio", { name: "Cursor", exact: true }).check();
  await page.getByRole("button", { name: "Create App", exact: true }).click();
  await expect(page).toHaveURL(/\/handoff\/[0-9a-f-]{36}$/u, {
    timeout: 30_000,
  });
  const handoffPath = new URL(page.url()).pathname;
  const handoffId = handoffPath.split("/").at(-1)!;
  await page.getByText("Set up Autograph in Cursor", { exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Add Autograph to Cursor" }),
  ).toBeVisible();

  let providerAuthorizationRequests = 0;
  let consentSubmissions = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      [githubEmulatorOrigin, vercelEmulatorOrigin].includes(url.origin) ||
      /^\/(?:local-oauth|local-connections)\//u.test(url.pathname) ||
      /\/api\/auth\/(?:sign-in|oauth2\/authorize-provider|oauth2\/link)/u.test(
        url.pathname,
      )
    )
      providerAuthorizationRequests += 1;
    if (
      url.origin === appOrigin &&
      url.pathname === "/api/auth/oauth2/consent" &&
      request.method() === "POST"
    )
      consentSubmissions += 1;
  });

  let callback: URL | undefined;
  // Capture the actual authorization redirect at the native callback boundary.
  // No desktop listener is started; neither code issuance nor tokens are mocked.
  await page.route(
    (url) => url.origin + url.pathname === cursorRedirectUri,
    async (route) => {
      callback = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>OAuth callback received</title>",
      });
    },
  );

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
    await page.goto(url.toString());
    if (first) {
      // Read pathname/signature presence as booleans, avoiding sensitive URLs in reports.
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe("/auth/consent");
      expect(new URL(page.url()).searchParams.has("sig")).toBe(true);
      await expect(
        page.getByText("dev@autograph.local", { exact: true }),
      ).toBeVisible();
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
    await page.goto(`${appOrigin}${handoffPath}`);
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
  expect(providerAuthorizationRequests).toBe(0);

  const after = await applicationCounts();
  expect(after.githubInstallations).toBe(before.githubInstallations);
  expect(after.vercelInstallations).toBe(before.vercelInstallations);
  expect(after.sessions).toBe(before.sessions);
  expect((await currentSession(page))?.user?.id === ownerUserId).toBe(true);
  const handoff = await page.request.get(`/api/builder/handoffs/${handoffId}`);
  expect(handoff.ok()).toBe(true);
  expect((await handoff.json()).status).toBe("prepared");
  await expect(
    page.getByText("Continued in your app", { exact: false }),
  ).toHaveCount(0);

  // dev-emulated configures browser OAuth but not MCP_OAUTH_* or the hosted
  // forwarder/workload identity. Do not fake /mcp redemption or engine proof.
});
