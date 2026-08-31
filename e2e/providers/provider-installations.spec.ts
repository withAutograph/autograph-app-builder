import postgres from "postgres";
import { expect, test } from "playwright/test";

import {
  advanceProviderConnectionToApproval,
  appOrigin,
  applicationCounts,
  approveProviderConnection,
  databaseUrl,
  emulatedProviders,
  expectProviderSelection,
  finishOAuth,
  installProvider,
  localApprovalButtonName,
  openProviderConnection,
  providerDescriptor,
  reopenProviderConnection,
  resetApplicationState,
  selectProviderIdentity,
  signOut,
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
      url: appOrigin,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

async function completeGitHubConnection(page: import("playwright/test").Page) {
  await expect(page).toHaveURL(/\/github\/installations/u);
  await advanceProviderConnectionToApproval(page, "GitHub");
  await selectProviderIdentity(page, "GitHub");
}

async function startGitHubConnection(page: import("playwright/test").Page) {
  await openProviderConnection(page, "GitHub");
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

for (const provider of emulatedProviders) {
  test(`${provider} installation restores the draft and persists one binding`, async ({
    page,
  }) => {
    const descriptor = providerDescriptor(provider);
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
        return counts[descriptor.bindingCount];
      })
      .toBe(1);

    await expect(page.getByLabel(descriptor.selectedControl)).toBeFocused();
    await expectProviderSelection(page, provider);

    await page.goto("/");
    await expect(page).toHaveURL(`${appOrigin}/`);
    await expectProviderSelection(page, provider);
    expect((await applicationCounts())[descriptor.bindingCount]).toBe(1);
  });
}

for (const provider of emulatedProviders) {
  test(`reconnecting ${provider} updates the existing binding without duplication`, async ({
    page,
  }) => {
    const descriptor = providerDescriptor(provider);
    await finishOAuth(page, "GitHub");
    await page.goto("/");
    await installProvider(page, provider);
    await reopenProviderConnection(page, provider);
    await advanceProviderConnectionToApproval(page, provider);
    await approveProviderConnection(page, provider);
    expect((await applicationCounts())[descriptor.bindingCount]).toBe(1);
    await expectProviderSelection(page, provider);
  });
}

test("connections remain available when the user returns through the other OAuth provider", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await installProvider(page, "GitHub");
  await installProvider(page, "Vercel");

  await signOut(page);
  await finishOAuth(page, "Vercel");
  await page.goto("/");
  await expectProviderSelection(page, "GitHub");
  await expectProviderSelection(page, "Vercel");
  expect(await applicationCounts()).toMatchObject({
    users: 1,
    githubInstallations: 1,
    vercelInstallations: 1,
  });
});

test("the emulated approval Back action restores the unchanged builder draft", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await page.getByLabel("App Name").fill("Back Action Draft");
  await page.locator("#app-brief").fill("Keep this draft without connecting.");
  await openProviderConnection(page, "GitHub");
  await advanceProviderConnectionToApproval(page, "GitHub");
  await page.getByRole("link", { name: "Back" }).click();

  await expect(page).toHaveURL(/\/?resume=/u);
  await expect(page.getByLabel("App Name")).toHaveValue("Back Action Draft");
  await expect(page.locator("#app-brief")).toHaveValue(
    "Keep this draft without connecting.",
  );
  expect((await applicationCounts()).githubInstallations).toBe(0);
});

for (const provider of emulatedProviders) {
  test(`leaving the ${provider} installation page restores the draft without connecting`, async ({
    page,
  }) => {
    const descriptor = providerDescriptor(provider);
    await finishOAuth(page, "GitHub");
    await page.goto("/");
    await page
      .locator("#app-brief")
      .fill(`Keep this ${provider} draft when leaving connections.`);
    await page.getByLabel("App Name").fill(`${provider} Back Draft`);

    await openProviderConnection(page, provider);
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page).toHaveURL(/\/?resume=/u);
    await expect(page.getByLabel("App Name")).toHaveValue(
      `${provider} Back Draft`,
    );
    await expect(page.locator("#app-brief")).toHaveValue(
      `Keep this ${provider} draft when leaving connections.`,
    );
    expect((await applicationCounts())[descriptor.bindingCount]).toBe(0);
  });
}

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
  await expect(page).toHaveURL(`${appOrigin}/`);
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

for (const provider of emulatedProviders) {
  test(`a consumed ${provider} callback cannot be replayed`, async ({
    page,
  }) => {
    const descriptor = providerDescriptor(provider);
    const appName = `${provider} Replay Draft`;
    const brief = `Preserve this ${provider} draft after replay.`;
    await finishOAuth(page, "GitHub");
    await page.goto("/");
    await page.getByLabel("App Name").fill(appName);
    await page.locator("#app-brief").fill(brief);
    let callbackUrl = "";
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === descriptor.callbackPath)
        callbackUrl = request.url();
    });
    await installProvider(page, provider);
    expect(callbackUrl).toContain("state=");
    await page.goto(callbackUrl);
    await expect(page).toHaveURL(new RegExp(`${descriptor.slug}=failed`, "u"));
    await expect(page.getByLabel("App Name")).toHaveValue(appName);
    await expect(page.locator("#app-brief")).toHaveValue(brief);
    expect((await applicationCounts())[descriptor.bindingCount]).toBe(1);
  });
}

for (const provider of emulatedProviders) {
  test(`an expired ${provider} authorization returns to a recoverable draft`, async ({
    page,
  }) => {
    const descriptor = providerDescriptor(provider);
    const appName = `${provider} Expired State Draft`;
    const brief = `Preserve this ${provider} draft after expiry.`;
    await finishOAuth(page, "GitHub");
    await page.goto("/");
    await page.getByLabel("App Name").fill(appName);
    await page.locator("#app-brief").fill(brief);
    await openProviderConnection(page, provider);
    await advanceProviderConnectionToApproval(page, provider);

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql.unsafe(
        `UPDATE ${descriptor.authorizationStateTable}
         SET created_at = now() - interval '2 seconds',
             expires_at = now() - interval '1 second'`,
      );
    } finally {
      await sql.end();
    }
    await page
      .getByRole("button", { name: localApprovalButtonName(provider) })
      .click();
    if (new URL(page.url()).origin === descriptor.emulatorOrigin)
      await page.getByRole("button", { name: /autograph-dev/u }).click();

    await expect(page).toHaveURL(new RegExp(`${descriptor.slug}=failed`, "u"));
    await expect(page.getByLabel("App Name")).toHaveValue(appName);
    await expect(page.locator("#app-brief")).toHaveValue(brief);
    expect((await applicationCounts())[descriptor.bindingCount]).toBe(0);
  });
}
