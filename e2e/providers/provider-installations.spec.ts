import postgres from "postgres";
import { expect, test } from "playwright/test";
import type { Page } from "playwright/test";

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
  waitForBuilderReady,
} from "../support/harness";

type GitHubCallbackFixture =
  | "extensions"
  | "duplicate-code"
  | "duplicate-state"
  | "duplicate-installation-id"
  | "duplicate-setup-action";

async function setGitHubCallbackFixture(page: Page, fixture: GitHubCallbackFixture) {
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

async function completeGitHubConnection(page: Page) {
  await expect(page).toHaveURL(/\/github\/installations/u);
  await advanceProviderConnectionToApproval(page, "GitHub");
  await selectProviderIdentity(page, "GitHub");
}

async function startGitHubConnection(page: Page) {
  await openProviderConnection(page, "GitHub");
  await completeGitHubConnection(page);
}

async function openBuilderPage(page: Page) {
  await page.goto("/");
  await waitForBuilderReady(page);
}

async function expectProviderCheckpoint(page: Page, appName: string, brief: string) {
  const draftId = new URL(page.url()).searchParams.get("resume");
  expect(draftId).toBeTruthy();
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Navigation must already have awaited the committed snapshot. Deliberately
    // do not poll: eventual persistence after leaving the form is not enough.
    const rows = await sql`
      SELECT record->'draft'->'form'->>'appName' AS "appName",
             record->'draft'->'form'->>'brief' AS brief
      FROM builder_draft WHERE draft_id = ${draftId} AND status = 'active'
    `;
    expect([...rows]).toEqual([{ appName, brief }]);
  } finally {
    await sql.end();
  }
}

function expectGitHubControlAndNoOAuthLeak(page: Page, rawValues: readonly string[]) {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  return async () => {
    await expect(page.getByRole("checkbox", { name: /GitHub/u })).toBeVisible();
    for (const rawValue of rawValues) {
      expect(messages.join("\n")).not.toContain(rawValue);
    }
  };
}

test.beforeEach(async () => resetApplicationState());

test("GitHub return preserves edits made while its checkpoint is in flight", async ({ page }) => {
  await finishOAuth(page, "GitHub");
  await openBuilderPage(page);
  let checkpointStarted = false;
  const releaseCheckpoint = Promise.withResolvers<undefined>();
  let held = false;
  await page.route(`${appOrigin}/`, async (route) => {
    const request = route.request();
    if (
      held ||
      request.method() !== "POST" ||
      !request.headers()["next-action"] ||
      !request.postData()?.includes("clientMutationId")
    ) {
      return route.continue();
    }
    held = true;
    const response = await route.fetch();
    checkpointStarted = true;
    await releaseCheckpoint.promise;
    await route.fulfill({ response });
  });
  try {
    await page.locator("#app-brief").fill("Keep this GitHub brief through authorization.");
    await page.getByRole("checkbox", { name: /GitHub/u }).check();
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    await expect.poll(() => checkpointStarted).toBe(true);
    await page.getByLabel("App Name").fill("Edited During Checkpoint");
    releaseCheckpoint.resolve(undefined);
    await expect(page).toHaveURL(/\/github\/installations\?/u);
    await expectProviderCheckpoint(
      page,
      "Edited During Checkpoint",
      "Keep this GitHub brief through authorization.",
    );
    await advanceProviderConnectionToApproval(page, "GitHub");
    await approveProviderConnection(page, "GitHub");
    await expect(page.getByLabel("App Name")).toHaveValue("Edited During Checkpoint");
    await page.reload();
    await waitForBuilderReady(page);
    await expect(page.getByLabel("App Name")).toHaveValue("Edited During Checkpoint");
  } finally {
    releaseCheckpoint.resolve(undefined);
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const provider of emulatedProviders) {
  test(`${provider} installation restores the draft and persists one binding`, async ({ page }) => {
    const descriptor = providerDescriptor(provider);
    await finishOAuth(page, "GitHub");
    await openBuilderPage(page);
    await page.locator("#app-brief").fill(`Keep this ${provider} brief through authorization.`);
    await expect(page.locator("#app-brief")).toHaveValue(
      `Keep this ${provider} brief through authorization.`,
    );
    await page.getByLabel("App Name").fill(`${provider} Restored App`);
    // This checks the visible edit. The assertions after OAuth and reload
    // below independently verify the durable checkpoint, not just the DOM.
    await expect(page.getByLabel("App Name")).toHaveValue(`${provider} Restored App`);

    await openProviderConnection(page, provider);
    await expectProviderCheckpoint(
      page,
      `${provider} Restored App`,
      `Keep this ${provider} brief through authorization.`,
    );
    await advanceProviderConnectionToApproval(page, provider);
    await approveProviderConnection(page, provider);
    await expect(page.getByLabel("App Name")).toHaveValue(`${provider} Restored App`);
    await expect(page.locator("#app-brief")).toHaveValue(
      `Keep this ${provider} brief through authorization.`,
    );
    await expect(page.getByText(`${provider} connected successfully.`)).toBeVisible();
    await expect
      .poll(async () => {
        const counts = await applicationCounts();
        return counts[descriptor.bindingCount];
      })
      .toBe(1);

    await expect(page.getByLabel(descriptor.selectedControl)).toBeFocused();
    await expectProviderSelection(page, provider);

    await openBuilderPage(page);
    await expect(page).toHaveURL(`${appOrigin}/`);
    await expect(page.getByLabel("App Name")).toHaveValue(`${provider} Restored App`);
    await expect(page.locator("#app-brief")).toHaveValue(
      `Keep this ${provider} brief through authorization.`,
    );
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
    await openBuilderPage(page);
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
  await openBuilderPage(page);
  await installProvider(page, "GitHub");
  await installProvider(page, "Vercel");

  await signOut(page);
  await finishOAuth(page, "Vercel");
  await openBuilderPage(page);
  await expectProviderSelection(page, "GitHub");
  await expectProviderSelection(page, "Vercel");
  expect(await applicationCounts()).toMatchObject({
    users: 1,
    githubInstallations: 1,
    vercelInstallations: 1,
  });
});

test("the emulated approval Back action restores the unchanged builder draft", async ({ page }) => {
  await finishOAuth(page, "GitHub");
  await openBuilderPage(page);
  await page.getByLabel("App Name").fill("Back Action Draft");
  await page.locator("#app-brief").fill("Keep this draft without connecting.");
  await openProviderConnection(page, "GitHub");
  await advanceProviderConnectionToApproval(page, "GitHub");
  await page.getByRole("link", { name: "Back" }).click();

  await expect(page).toHaveURL(/\/?resume=/u);
  await waitForBuilderReady(page);
  await expect(page.getByLabel("App Name")).toHaveValue("Back Action Draft");
  await expect(page.locator("#app-brief")).toHaveValue("Keep this draft without connecting.");
  expect((await applicationCounts()).githubInstallations).toBe(0);
});

for (const provider of emulatedProviders) {
  test(`leaving the ${provider} installation page restores the draft without connecting`, async ({
    page,
  }) => {
    const descriptor = providerDescriptor(provider);
    await finishOAuth(page, "GitHub");
    await openBuilderPage(page);
    await page.locator("#app-brief").fill(`Keep this ${provider} draft when leaving connections.`);
    await expect(page.locator("#app-brief")).toHaveValue(
      `Keep this ${provider} draft when leaving connections.`,
    );
    await page.getByLabel("App Name").fill(`${provider} Back Draft`);
    await expect(page.getByLabel("App Name")).toHaveValue(`${provider} Back Draft`);

    await openProviderConnection(page, provider);
    await page.getByRole("link", { name: "Back" }).click();
    await expect(page).toHaveURL(/\/?resume=/u);
    await waitForBuilderReady(page);
    await expect(page.getByLabel("App Name")).toHaveValue(`${provider} Back Draft`);
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
  await openBuilderPage(page);
  await installProvider(page, "GitHub");

  const assertNoLeak = expectGitHubControlAndNoOAuthLeak(page, [
    "opaque-provider-value",
    "opaque-provider-value-2",
  ]);

  await page.getByLabel("Git Scope").click();
  await page.getByText("Update GitHub access").click();
  await setGitHubCallbackFixture(page, "extensions");
  await completeGitHubConnection(page);

  await expect(page).toHaveURL(/\?github=connected&resume=/u);
  await expect(page.getByText("GitHub connected successfully.")).toBeVisible();
  await expect(page.getByLabel("Git Scope")).toHaveValue("autograph-local");
  expect((await applicationCounts()).githubInstallations).toBe(1);

  await openBuilderPage(page);
  await expect(page).toHaveURL(`${appOrigin}/`);
  await expect(page.getByLabel("Git Scope")).toHaveValue("autograph-local");
  await assertNoLeak();
});

for (const key of ["code", "state", "installation_id", "setup_action"] as const) {
  test(`GitHub OAuth callback rejects duplicate app-owned ${key}`, async ({ page }) => {
    await finishOAuth(page, "GitHub");
    await openBuilderPage(page);
    const assertNoLeak = expectGitHubControlAndNoOAuthLeak(page, ["duplicate-app-owned-value"]);

    await setGitHubCallbackFixture(
      page,
      `duplicate-${key.replaceAll("_", "-")}` as GitHubCallbackFixture,
    );
    await startGitHubConnection(page);
    await expect(page).toHaveURL(/github=failed&githubReason=callback-invalid/u);
    expect((await applicationCounts()).githubInstallations).toBe(0);
    await assertNoLeak();
  });
}

test("provider substitution and malformed callback fail without a binding", async ({ page }) => {
  await finishOAuth(page, "GitHub");
  await openBuilderPage(page);
  await page.getByRole("checkbox", { name: /GitHub/u }).check();
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  await page.getByRole("button", { name: "Install or update GitHub access" }).click();
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
  test(`a consumed ${provider} callback cannot be replayed`, async ({ page }) => {
    const descriptor = providerDescriptor(provider);
    const appName = `${provider} Replay Draft`;
    const brief = `Preserve this ${provider} draft after replay.`;
    await finishOAuth(page, "GitHub");
    await openBuilderPage(page);
    await page.getByLabel("App Name").fill(appName);
    await page.locator("#app-brief").fill(brief);
    await expect(page.getByLabel("App Name")).toHaveValue(appName);
    await expect(page.locator("#app-brief")).toHaveValue(brief);
    let callbackUrl = "";
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === descriptor.callbackPath) {
        callbackUrl = request.url();
      }
    });
    await installProvider(page, provider);
    expect(callbackUrl).toContain("state=");
    await page.goto(callbackUrl);
    await expect(page).toHaveURL(new RegExp(`${descriptor.slug}=failed`, "u"));
    await waitForBuilderReady(page);
    await expect(page.getByLabel("App Name")).toHaveValue(appName);
    await expect(page.locator("#app-brief")).toHaveValue(brief);
    expect((await applicationCounts())[descriptor.bindingCount]).toBe(1);
  });
}

for (const provider of emulatedProviders) {
  test(`an expired ${provider} authorization returns to a recoverable draft`, async ({ page }) => {
    const descriptor = providerDescriptor(provider);
    const appName = `${provider} Expired State Draft`;
    const brief = `Preserve this ${provider} draft after expiry.`;
    await finishOAuth(page, "GitHub");
    await openBuilderPage(page);
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
    await page.getByRole("button", { name: localApprovalButtonName(provider) }).click();
    if (new URL(page.url()).origin === descriptor.emulatorOrigin) {
      await page.getByRole("button", { name: /autograph-dev/u }).click();
    }

    await expect(page).toHaveURL(new RegExp(`${descriptor.slug}=failed`, "u"));
    await waitForBuilderReady(page);
    await expect(page.getByLabel("App Name")).toHaveValue(appName);
    await expect(page.locator("#app-brief")).toHaveValue(brief);
    expect((await applicationCounts())[descriptor.bindingCount]).toBe(0);
  });
}
