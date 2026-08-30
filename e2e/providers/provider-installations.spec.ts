import postgres from "postgres";
import { expect, test } from "playwright/test";

import {
  appOrigin,
  applicationCounts,
  databaseUrl,
  finishOAuth,
  installProvider,
  localApprovalButtonName,
  resetApplicationState,
} from "../support/harness";

type GitHubCallbackFixture =
  | "extensions"
  | "duplicate-code"
  | "duplicate-state"
  | "duplicate-installation-id"
  | "duplicate-setup-action";

async function setGitHubCallbackFixture(
  page: import("playwright/test").Page,
  fixture: GitHubCallbackFixture,
) {
  await page.context().addCookies([
    {
      name: "autograph-e2e-github-callback",
      value: fixture,
      url: "https://localhost:3001",
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

async function completeGitHubConnection(page: import("playwright/test").Page) {
  await expect(page).toHaveURL(/\/github\/installations/u);
  await page
    .getByRole("button", { name: "Install or update GitHub access" })
    .click();
  await expect(page).toHaveURL(/\/local-connections\/github/u);
  await page.getByRole("button", { name: /Connect local GitHub/u }).click();
  await expect(page).toHaveURL(/localhost:4001/u);
  await page.getByRole("button", { name: /autograph-dev/u }).click();
}

async function startGitHubConnection(page: import("playwright/test").Page) {
  await page.getByRole("checkbox", { name: /GitHub/u }).check();
  await page.getByRole("button", { name: "Connect to GitHub" }).click();
  await completeGitHubConnection(page);
}

function expectGitHubControlAndNoOAuthLeak(
  page: import("playwright/test").Page,
  rawValues: ReadonlyArray<string>,
) {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  return async () => {
    await expect(page.getByRole("checkbox", { name: /GitHub/u })).toBeVisible();
    for (const rawValue of rawValues)
      expect(messages.join("\n")).not.toContain(rawValue);
  };
}

test.beforeEach(async () => resetApplicationState());

for (const provider of ["GitHub", "Vercel"] as const) {
  test(`${provider} installation restores the draft and persists one binding`, async ({
    page,
  }) => {
    await finishOAuth(page, "GitHub");
    await page.goto("/");
    await page
      .locator("#app-brief")
      .fill(`Keep this ${provider} brief through authorization.`);
    await page.getByLabel("App Name").fill(`${provider} Restored App`);

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
  await page.getByText("Add GitHub Scope").click();
  await expect(page).toHaveURL(/\/github\/installations/u);
  await page
    .getByRole("button", { name: "Install or update GitHub access" })
    .click();
  await page
    .getByRole("button", { name: localApprovalButtonName("GitHub") })
    .click();
  await page.getByRole("button", { name: /autograph-dev/u }).click();
  await expect(page).toHaveURL(new RegExp(`^${appOrigin}/`, "u"));
  expect((await applicationCounts()).githubInstallations).toBe(1);
});

test("GitHub installation update accepts OAuth provider extensions and retains the organization scope", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await installProvider(page, "GitHub");

  const assertNoLeak = expectGitHubControlAndNoOAuthLeak(page, [
    "opaque-provider-value",
    "opaque-provider-value-2",
  ]);

  await page.getByLabel("Git Scope").click();
  await page.getByText("Add GitHub Scope").click();
  await setGitHubCallbackFixture(page, "extensions");
  await completeGitHubConnection(page);

  await expect(page).toHaveURL(/\?github=connected&resume=/u);
  await expect(page.getByText("GitHub connected successfully.")).toBeVisible();
  await expect(page.getByLabel("Git Scope")).toHaveValue("autograph-local");
  expect((await applicationCounts()).githubInstallations).toBe(1);

  await page.goto("/");
  await expect(page).toHaveURL(/https:\/\/localhost:3001\/$/u);
  await expect(page.getByLabel("Git Scope")).toHaveValue("autograph-local");
  await assertNoLeak();
});

for (const key of [
  "code",
  "state",
  "installation_id",
  "setup_action",
] as const) {
  test(`GitHub OAuth callback rejects duplicate app-owned ${key}`, async ({
    page,
  }) => {
    await finishOAuth(page, "GitHub");
    await page.goto("/");
    const assertNoLeak = expectGitHubControlAndNoOAuthLeak(page, [
      "duplicate-app-owned-value",
    ]);

    await setGitHubCallbackFixture(
      page,
      `duplicate-${key.replaceAll("_", "-")}` as GitHubCallbackFixture,
    );
    await startGitHubConnection(page);
    await expect(page).toHaveURL(
      /github=failed&githubReason=callback-invalid/u,
    );
    expect((await applicationCounts()).githubInstallations).toBe(0);
    await assertNoLeak();
  });
}

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
  const storedDraft = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((candidate) =>
      candidate.startsWith("autograph-builder-draft:"),
    );
    return key ? sessionStorage.getItem(key) : null;
  });
  expect(storedDraft).toContain("Expired State Draft");
  expect(storedDraft).toContain("Preserve this draft after expiry.");

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      UPDATE github_installation_authorization_state
         SET expires_at = created_at + interval '1 millisecond'
    `;
  } finally {
    await sql.end();
  }
  await page
    .getByRole("button", { name: localApprovalButtonName("GitHub") })
    .click();
  await expect(page).toHaveURL(/github=failed/u);
  expect(
    await page.evaluate(
      (draft) => Object.values(sessionStorage).some((value) => value === draft),
      storedDraft,
    ),
  ).toBe(true);
  expect((await applicationCounts()).githubInstallations).toBe(0);
});
