import postgres from "postgres";
import { expect, type BrowserContext, type Page } from "playwright/test";

import { VirtualAuthenticator } from "../auth/virtual-authenticator";

const databasePort = process.env.APP_BUILDER_DATABASE_PORT || "54329";
const appPort = process.env.APP_BUILDER_LOCAL_PORT || "3001";
const appProtocol = "https";
const emulateBasePort = Number(process.env.EMULATE_BASE_PORT || "4000");
export const appOrigin = `${appProtocol}://localhost:${appPort}`;
export const githubEmulatorOrigin = `http://localhost:${emulateBasePort + 1}`;
export const databaseUrl = `postgresql://postgres@127.0.0.1:${databasePort}/autograph_app_builder`;

export function localApprovalButtonName(provider: "GitHub" | "Vercel") {
  return provider === "GitHub"
    ? "Connect emulated GitHub App installation"
    : "Connect emulated Vercel team";
}

export async function resetApplicationState() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(`
      TRUNCATE TABLE
        "vercel_installation_authorization_state",
        "github_installation_authorization_state",
        "hosted_vercel_installation",
        "hosted_github_installation_binding",
        "hosted_github_installation",
        "user",
        "organization",
        "passkey_onboarding"
      CASCADE
    `);
  } finally {
    await sql.end();
  }
}

export async function applicationCounts() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [counts] = await sql<
      Array<{
        users: number;
        passkeys: number;
        organizations: number;
        members: number;
        sessions: number;
        activeSessions: number;
        githubInstallations: number;
        vercelInstallations: number;
      }>
    >`
      SELECT
        (SELECT count(*)::int FROM "user") AS users,
        (SELECT count(*)::int FROM passkey) AS passkeys,
        (SELECT count(*)::int FROM organization) AS organizations,
        (SELECT count(*)::int FROM member) AS members,
        (SELECT count(*)::int FROM session) AS sessions,
        (SELECT count(*)::int FROM session WHERE active_organization_id IS NOT NULL) AS "activeSessions",
        (SELECT count(*)::int FROM hosted_github_installation_binding) AS "githubInstallations",
        (SELECT count(*)::int FROM hosted_vercel_installation) AS "vercelInstallations"
    `;
    return counts;
  } finally {
    await sql.end();
  }
}

export async function currentSession(page: Page) {
  try {
    return (await page.request.get("/api/auth/get-session")).json();
  } catch {
    return null;
  }
}

export async function signOut(page: Page) {
  await page.goto("/auth/sign-out");
  await expect(page).toHaveURL(/\/auth\/sign-in/u);
  await expect.poll(() => currentSession(page)).toBeNull();
}

export async function finishOAuth(
  page: Page,
  provider: "GitHub" | "Vercel",
  callbackURL = "/",
) {
  await page.goto(
    `/auth/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`,
  );
  await page.getByRole("button", { name: `Continue with ${provider}` }).click();
  await expect(page).toHaveURL(
    new RegExp(`/local-oauth/${provider.toLowerCase()}/authorize`),
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: `Continue with ${provider}` }).click();
  await expect
    .poll(() => currentSession(page), { timeout: 30_000 })
    .toMatchObject({ user: { email: "dev@autograph.local" } });
}

export async function registerPasskey(
  context: BrowserContext,
  page: Page,
  callbackURL = "/",
) {
  const authenticator = await VirtualAuthenticator.create(context, page);
  await page.goto(
    `/auth/sign-up?callbackURL=${encodeURIComponent(callbackURL)}`,
  );
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect
    .poll(() => currentSession(page), { timeout: 30_000 })
    .toMatchObject({ user: { emailVerified: false } });
  return authenticator;
}

export async function installProvider(
  page: Page,
  provider: "GitHub" | "Vercel",
) {
  const providerSlug = provider.toLowerCase();
  await page
    .getByRole("checkbox", {
      name: provider === "GitHub" ? /GitHub/u : /Vercel/u,
    })
    .check();
  await page.getByRole("button", { name: `Connect to ${provider}` }).click();
  await expect(page).toHaveURL(new RegExp(`/${providerSlug}/installations`), {
    timeout: 30_000,
  });
  await page
    .getByRole("button", {
      name:
        provider === "GitHub"
          ? "Install or update GitHub access"
          : "Connect to Vercel",
    })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/local-connections/${providerSlug}`),
  );
  await page
    .getByRole("button", {
      name: localApprovalButtonName(provider),
    })
    .click();
  if (provider === "GitHub") {
    await expect(page).toHaveURL(
      new RegExp(`^http://localhost:${emulateBasePort + 1}/`, "u"),
    );
    await page.getByRole("button", { name: /autograph-dev/u }).click();
  } else {
    await expect(page).toHaveURL(
      new RegExp(`^http://localhost:${emulateBasePort}/`, "u"),
    );
    await page.getByRole("button", { name: /autograph-dev/u }).click();
  }
  await expect(page).toHaveURL(new RegExp(`^${appOrigin}/`, "u"), {
    timeout: 30_000,
  });
  await expect(
    page.getByText(`${provider} connected successfully.`),
  ).toBeVisible();
  await expect(
    page.getByLabel(
      provider === "GitHub" ? "Git Scope" : "Select a Vercel Team",
    ),
  ).toBeFocused();
}

export async function installBrowserBoundaries(
  context: BrowserContext,
  mode: "success" | "blocked" = "success",
) {
  await context.addInitScript((boundaryMode) => {
    const state = {
      clipboard: [] as string[],
      opened: [] as string[],
    };
    Object.defineProperty(window, "__e2eBoundaries", {
      configurable: false,
      value: state,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (boundaryMode === "blocked") throw new Error("Clipboard blocked");
          state.clipboard.push(value);
        },
      },
    });
    window.open = ((url?: string | URL) => {
      if (boundaryMode === "blocked") throw new Error("Protocol blocked");
      state.opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  }, mode);
}

export async function browserBoundaryState(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __e2eBoundaries: { clipboard: string[]; opened: string[] };
      }
    ).__e2eBoundaries;
    return structuredClone(state);
  });
}
