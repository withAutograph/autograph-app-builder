import postgres from "postgres";
import { expect, type BrowserContext, type Page } from "playwright/test";

import { VirtualAuthenticator } from "../auth/virtual-authenticator";

const databasePort = process.env.APP_BUILDER_DATABASE_PORT || "54329";
const appPort = process.env.APP_BUILDER_LOCAL_PORT || "3001";
const appProtocol = "https";
const emulateBasePort = Number(process.env.EMULATE_BASE_PORT || "4000");
export const appOrigin = `${appProtocol}://localhost:${appPort}`;
export const vercelEmulatorOrigin = `http://localhost:${emulateBasePort}`;
export const githubEmulatorOrigin = `http://localhost:${emulateBasePort + 1}`;
export const databaseUrl = `postgresql://postgres@127.0.0.1:${databasePort}/autograph_app_builder`;

export const emulatedProviders = ["GitHub", "Vercel"] as const;
export type EmulatedProvider = (typeof emulatedProviders)[number];

const providerDescriptors = {
  GitHub: {
    slug: "github",
    installationButton: "Install or update GitHub access",
    approvalButton: "Connect emulated GitHub",
    seededScopes: ["autograph-local/demo-app"],
    selectedControl: "Git Scope",
    selectedValue: "autograph-local",
    reconnectButton: "Add GitHub Scope",
    emulatorOrigin: githubEmulatorOrigin,
    callbackPath: "/github/installations/callback",
    authorizationStateTable: "github_installation_authorization_state",
    bindingCount: "githubInstallations",
  },
  Vercel: {
    slug: "vercel",
    installationButton: "Connect to Vercel",
    approvalButton: "Connect emulated Vercel",
    seededScopes: ["autograph-local", "icfg_local_1"],
    selectedControl: "Select a Vercel Team",
    selectedValue: "Autograph Local",
    reconnectButton: "Connect another Vercel team",
    emulatorOrigin: vercelEmulatorOrigin,
    callbackPath: "/vercel/installations/callback",
    authorizationStateTable: "vercel_installation_authorization_state",
    bindingCount: "vercelInstallations",
  },
} as const;

export function providerDescriptor(provider: EmulatedProvider) {
  return providerDescriptors[provider];
}

export function localApprovalButtonName(provider: EmulatedProvider) {
  return providerDescriptor(provider).approvalButton;
}

export async function resetApplicationState() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Recover cleanly if the rollback E2E was interrupted after installing its
    // task-owned failure trigger but before its local finally block ran.
    await sql.unsafe(
      'DROP TRIGGER IF EXISTS "fail_passkey_session_insert" ON "session"',
    );
    await sql.unsafe("DROP FUNCTION IF EXISTS fail_passkey_session_insert()");
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
        passkeyOnboardingContexts: number;
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
        (SELECT count(*)::int FROM passkey_onboarding) AS "passkeyOnboardingContexts",
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
    const response = await page.request.get("/api/auth/get-session");
    if (!response.ok()) return null;
    return response.json();
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
  provider: EmulatedProvider,
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
  await page.getByRole("button", { name: "Continue with Passkey" }).click();
  await expect
    .poll(() => currentSession(page), { timeout: 30_000 })
    .toMatchObject({ user: { emailVerified: false } });
  return authenticator;
}

export async function openProviderConnection(
  page: Page,
  provider: EmulatedProvider,
) {
  const descriptor = providerDescriptor(provider);
  await page.getByRole("checkbox", { name: new RegExp(provider, "u") }).check();
  await page.getByRole("button", { name: `Connect to ${provider}` }).click();
  await expect(page).toHaveURL(
    new RegExp(`/${descriptor.slug}/installations`, "u"),
    { timeout: 30_000 },
  );
}

export async function advanceProviderConnectionToApproval(
  page: Page,
  provider: EmulatedProvider,
) {
  const descriptor = providerDescriptor(provider);
  await page
    .getByRole("button", { name: descriptor.installationButton })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/local-connections/${descriptor.slug}`, "u"),
  );
  for (const scope of descriptor.seededScopes)
    await expect(page.getByText(scope, { exact: true })).toBeVisible();
}

export async function selectProviderIdentity(
  page: Page,
  provider: EmulatedProvider,
) {
  const descriptor = providerDescriptor(provider);
  await expect(page.getByText("Autograph Developer")).toBeVisible();
  for (const scope of descriptor.seededScopes)
    await expect(page.getByText(scope, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: descriptor.approvalButton }).click();
  if (provider === "GitHub") {
    await expect(page).toHaveURL(
      /\/local-connections\/github\?.*phase=authorize/u,
    );
    await expect(page.getByText("Authorize GitHub connection")).toBeVisible();
    await page
      .getByRole("button", { name: "Authorize emulated GitHub" })
      .click();
  }
  await expect(page).toHaveURL(new RegExp(`^${appOrigin}/`, "u"), {
    timeout: 30_000,
  });
}

export async function approveProviderConnection(
  page: Page,
  provider: EmulatedProvider,
) {
  const descriptor = providerDescriptor(provider);
  await selectProviderIdentity(page, provider);
  await expect(
    page.getByText(`${provider} connected successfully.`),
  ).toBeVisible();
  await expect(page.getByLabel(descriptor.selectedControl)).toBeFocused();
}

export async function installProvider(page: Page, provider: EmulatedProvider) {
  await openProviderConnection(page, provider);
  await advanceProviderConnectionToApproval(page, provider);
  await approveProviderConnection(page, provider);
}

export async function reopenProviderConnection(
  page: Page,
  provider: EmulatedProvider,
) {
  const descriptor = providerDescriptor(provider);
  const reconnect = page.getByRole("button", {
    name: descriptor.reconnectButton,
  });
  if (!(await reconnect.isVisible()))
    await page.getByLabel(descriptor.selectedControl).click();
  await reconnect.click();
  await expect(page).toHaveURL(
    new RegExp(`/${descriptor.slug}/installations`, "u"),
  );
}

export async function expectProviderSelection(
  page: Page,
  provider: EmulatedProvider,
) {
  const descriptor = providerDescriptor(provider);
  await page.getByRole("checkbox", { name: new RegExp(provider, "u") }).check();
  await expect(page.getByLabel(descriptor.selectedControl)).toHaveValue(
    descriptor.selectedValue,
  );
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
