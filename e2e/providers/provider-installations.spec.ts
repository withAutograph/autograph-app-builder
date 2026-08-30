import postgres from "postgres";
import { expect, test } from "playwright/test";

import {
  applicationCounts,
  databaseUrl,
  finishOAuth,
  installProvider,
  resetApplicationState,
} from "../support/harness";

test.beforeEach(async () => resetApplicationState());

for (const provider of ["GitHub", "Vercel"] as const) {
  test(`${provider} installation restores the draft and persists one binding`, async ({
    page,
  }) => {
    await finishOAuth(page, "GitHub");
    await page.goto("/");
    await page.getByLabel("App Name").fill(`${provider} Restored App`);
    await page
      .locator("#app-brief")
      .fill(`Keep this ${provider} brief through authorization.`);

    await installProvider(page, provider);
    await expect(page.getByLabel("App Name")).toHaveValue(
      `${provider} Restored App`,
    );
    await expect(page.locator("#app-brief")).toHaveValue(
      `Keep this ${provider} brief through authorization.`,
    );
    await expect(
      page.getByText(`${provider} connected successfully.`),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const counts = await applicationCounts();
        return provider === "GitHub"
          ? counts.githubInstallations
          : counts.vercelInstallations;
      })
      .toBe(1);

    const expectedFocus =
      provider === "GitHub" ? "Git Scope" : "Select a Vercel Team";
    await expect(page.getByLabel(expectedFocus)).toBeFocused();
  });
}

test("reconnecting a provider updates the existing binding without duplication", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await installProvider(page, "GitHub");
  await page.getByLabel("Git Scope").click();
  await page.getByText("Connect another GitHub account").click();
  await expect(page).toHaveURL(/\/github\/installations/u);
  await page
    .getByRole("button", { name: "Install or update GitHub access" })
    .click();
  await page.getByRole("button", { name: /Connect local GitHub/u }).click();
  await page.getByRole("button", { name: /autograph-dev/u }).click();
  await expect(page).toHaveURL(/https:\/\/localhost:3001\//u);
  expect((await applicationCounts()).githubInstallations).toBe(1);
});

test("provider substitution and malformed callback fail without a binding", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await page.getByRole("checkbox", { name: /GitHub/u }).check();
  await page.getByRole("button", { name: "Connect to GitHub" }).click();
  await page
    .getByRole("button", { name: "Install or update GitHub access" })
    .click();
  const state = new URL(page.url()).searchParams.get("state");
  expect(state).toBeTruthy();

  await page.goto(
    `/vercel/installations/callback?code=substituted&state=${encodeURIComponent(state!)}`,
  );
  await expect(page).toHaveURL(/vercel=failed/u);
  expect((await applicationCounts()).vercelInstallations).toBe(0);

  await page.goto("/github/installations/callback?installation_id=1001");
  await expect(page).toHaveURL(/github=failed/u);
  expect((await applicationCounts()).githubInstallations).toBe(0);
});

test("a consumed provider callback cannot be replayed", async ({ page }) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  let callbackUrl = "";
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/github/installations/callback") {
      callbackUrl = request.url();
    }
  });
  await installProvider(page, "GitHub");
  expect(callbackUrl).toContain("state=");
  await page.goto(callbackUrl);
  await expect(page).toHaveURL(/github=failed/u);
  expect((await applicationCounts()).githubInstallations).toBe(1);
});

test("an expired provider authorization returns to a recoverable draft", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await page.getByLabel("App Name").fill("Expired State Draft");
  await page.locator("#app-brief").fill("Preserve this draft after expiry.");
  await page.getByRole("checkbox", { name: /GitHub/u }).check();
  await page.getByRole("button", { name: "Connect to GitHub" }).click();
  await page
    .getByRole("button", { name: "Install or update GitHub access" })
    .click();

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      UPDATE github_installation_authorization_state
         SET expires_at = created_at + interval '1 millisecond'
    `;
  } finally {
    await sql.end();
  }
  await page.getByRole("button", { name: /Connect local GitHub/u }).click();
  await expect(page).toHaveURL(/github=failed/u);
  await expect(page.getByLabel("App Name")).toHaveValue("Expired State Draft");
  await expect(page.locator("#app-brief")).toHaveValue(
    "Preserve this draft after expiry.",
  );
  expect((await applicationCounts()).githubInstallations).toBe(0);
});
