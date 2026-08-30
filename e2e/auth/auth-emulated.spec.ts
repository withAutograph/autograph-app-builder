import postgres from "postgres";
import { expect, test, type Page } from "playwright/test";

import { VirtualAuthenticator } from "./virtual-authenticator";

const databaseUrl =
  "postgresql://postgres@127.0.0.1:54329/autograph_app_builder";

function reportPasskeyFailures(page: Page) {
  page.on("response", async (response) => {
    if (
      response.ok() ||
      !new URL(response.url()).pathname.startsWith("/api/auth/passkey/")
    ) {
      return;
    }
    console.error(
      "passkey request failed",
      response.status(),
      new URL(response.url()).pathname,
      await response.text(),
    );
  });
}

function reportOAuthFailures(page: Page) {
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (response.ok() || !path.startsWith("/api/auth/sign-in/")) return;
    console.error(
      "OAuth request failed",
      response.status(),
      path,
      await response.text(),
    );
  });
}

async function resetAuthState() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(
      'TRUNCATE TABLE "user", "organization", "passkey_onboarding" CASCADE',
    );
  } finally {
    await sql.end();
  }
}

async function authCounts() {
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
      }>
    >`
      SELECT
        (SELECT count(*)::int FROM "user") AS users,
        (SELECT count(*)::int FROM passkey) AS passkeys,
        (SELECT count(*)::int FROM organization) AS organizations,
        (SELECT count(*)::int FROM member) AS members,
        (SELECT count(*)::int FROM session) AS sessions,
        (SELECT count(*)::int FROM session WHERE active_organization_id IS NOT NULL) AS "activeSessions"
    `;
    return counts;
  } finally {
    await sql.end();
  }
}

async function signOut(page: Page) {
  await page.goto("/auth/sign-out");
  await expect(page).toHaveURL(/\/auth\/sign-in/u);
  await expect
    .poll(async () => (await page.request.get("/api/auth/get-session")).json())
    .toBeNull();
}

async function finishOAuth(page: Page, provider: "GitHub" | "Vercel") {
  reportOAuthFailures(page);
  await page.goto("/auth/sign-in");
  await page.getByRole("button", { name: `Continue with ${provider}` }).click();
  await expect(page).toHaveURL(
    new RegExp(`/local-oauth/${provider.toLowerCase()}/authorize`),
  );
  await page.getByRole("button", { name: `Continue with ${provider}` }).click();
  await expect
    .poll(
      async () => (await page.request.get("/api/auth/get-session")).json(),
      {
        timeout: 30_000,
      },
    )
    .toMatchObject({ user: { email: "dev@autograph.local" } });
}

test.beforeEach(async () => resetAuthState());

test("passkey registration provisions one account and returning login", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await page.goto("/auth/sign-up");
    await page.getByRole("button", { name: "Create a passkey" }).click();
    await expect
      .poll(() => authCounts(), { timeout: 30_000 })
      .toEqual({
        users: 1,
        passkeys: 1,
        organizations: 1,
        members: 1,
        sessions: 1,
        activeSessions: 1,
      });
    expect(await authenticator.credentials()).toHaveLength(1);

    await signOut(page);
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    await expect
      .poll(async () =>
        (await page.request.get("/api/auth/get-session")).json(),
      )
      .toMatchObject({ user: { emailVerified: false } });
    expect((await authCounts()).users).toBe(1);
  } finally {
    await authenticator.dispose();
  }
});

test("missing credential and verification failure remain authentication-only", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await page.goto("/auth/sign-in");
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    const retry = page.getByRole("button", {
      name: "Passkey failed (try again)",
    });
    await expect(retry).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/sign-in/u);
    await retry.click();
    await expect(retry).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Create an account/u }),
    ).toHaveAttribute("href", /\/auth\/sign-up/u);
    expect(await authCounts()).toEqual({
      users: 0,
      passkeys: 0,
      organizations: 0,
      members: 0,
      sessions: 0,
      activeSessions: 0,
    });

    await authenticator.setUserVerified(false);
    await retry.click();
    await expect(retry).toBeVisible();
    expect((await authCounts()).users).toBe(0);
  } finally {
    await authenticator.dispose();
  }
});

test("a paused passkey ceremony returns to Sign In when it resumes", async ({
  context,
  page,
}) => {
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await authenticator.setPresence(false);
    await page.goto("/auth/sign-in");
    const continueWithPasskey = page.getByRole("button", {
      name: "Continue with Passkey",
    });
    await continueWithPasskey.click();
    await expect(continueWithPasskey).toBeDisabled();

    await authenticator.setPresence(true);
    await expect(page).toHaveURL(/\/auth\/sign-in/u);
    await expect(continueWithPasskey).toBeEnabled();
    expect((await authCounts()).users).toBe(0);
  } finally {
    await authenticator.dispose();
  }
});

test("an authenticator credential missing from server storage is not recreated", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await page.goto("/auth/sign-up");
    await page.getByRole("button", { name: "Create a passkey" }).click();
    await expect.poll(async () => (await authCounts()).passkeys).toBe(1);
    await signOut(page);
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`DELETE FROM passkey`;
    } finally {
      await sql.end();
    }
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    await expect(
      page.getByRole("button", { name: "Passkey failed (try again)" }),
    ).toBeVisible();
    expect((await authCounts()).passkeys).toBe(0);
    expect((await authCounts()).users).toBe(1);
  } finally {
    await authenticator.dispose();
  }
});

for (const provider of ["GitHub", "Vercel"] as const) {
  test(`${provider} Emulate completes OAuth provisioning and returning login`, async ({
    page,
  }) => {
    await finishOAuth(page, provider);
    expect(await authCounts()).toMatchObject({
      users: 1,
      organizations: 1,
      members: 1,
      activeSessions: 1,
    });
    await signOut(page);
    await finishOAuth(page, provider);
    expect((await authCounts()).users).toBe(1);
  });
}

test("provider account supports multiple passkeys but retains its final passkey", async ({
  context,
  page,
}) => {
  reportPasskeyFailures(page);
  let authenticator: VirtualAuthenticator | undefined =
    await VirtualAuthenticator.create(context, page);
  try {
    await finishOAuth(page, "GitHub");
    await page.goto("/settings/account");
    await page.getByRole("button", { name: "Add passkey" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("OAuth recovery passkey");
    await dialog.getByRole("button", { name: "Add passkey" }).click();
    await expect.poll(async () => (await authCounts()).passkeys).toBe(1);
    await expect(dialog).toBeHidden();

    // Chromium permits only one internal authenticator per browser context.
    // Removing the first authenticator models switching to a second device
    // while retaining the first credential in Better Auth's real database.
    await authenticator.dispose();
    authenticator = await VirtualAuthenticator.create(context, page);
    await page.getByRole("button", { name: "Add passkey" }).first().click();
    await dialog.getByLabel("Name").fill("Second passkey");
    await dialog.getByRole("button", { name: "Add passkey" }).click();
    await expect.poll(async () => (await authCounts()).passkeys).toBe(2);

    const list = await page.request.get("/api/auth/passkey/list-user-passkeys");
    expect(list.ok()).toBeTruthy();
    const credentials = (await list.json()) as Array<{ id: string }>;
    expect(credentials).toHaveLength(2);
    const deletePasskey = (id: string) =>
      page.evaluate(async (passkeyId) => {
        const response = await fetch("/api/auth/passkey/delete-passkey", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: passkeyId }),
        });
        return { ok: response.ok, status: response.status };
      }, id);
    expect((await deletePasskey(credentials[0].id)).ok).toBeTruthy();
    expect(await deletePasskey(credentials[1].id)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect((await authCounts()).passkeys).toBe(1);
  } finally {
    await authenticator?.dispose();
  }
});
