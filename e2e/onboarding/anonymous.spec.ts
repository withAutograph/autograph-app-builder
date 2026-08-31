import { expect, test } from "playwright/test";

import { VirtualAuthenticator } from "../auth/virtual-authenticator";
import {
  applicationCounts,
  finishOAuth,
  registerPasskey,
  resetApplicationState,
} from "../support/harness";

test.beforeEach(async () => resetApplicationState());

test("anonymous brief continues through passkey signup into the builder", async ({
  context,
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Build an app" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign In" })).toHaveAttribute(
    "href",
    "/auth/sign-in?callbackURL=%2F",
  );
  await expect(page.getByRole("link", { name: "Sign Up" })).toHaveAttribute(
    "href",
    "/auth/sign-up?callbackURL=%2F",
  );

  const continueButton = page.getByRole("button", { name: "Continue" });
  await expect(continueButton).toBeDisabled();
  await page
    .getByLabel("What should this app do?")
    .fill("Build a customer renewal dashboard.");
  await continueButton.click();
  await expect(page).toHaveURL(/\/auth\/sign-in\?callbackURL=%2F/u);
  await expect(
    page.getByRole("button", { name: "Continue with Passkey" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with Vercel" }),
  ).toBeVisible();

  const authenticator = await VirtualAuthenticator.create(context, page);
  try {
    await page.getByRole("link", { name: "Sign Up" }).click();
    await expect(page).toHaveURL(/\/auth\/sign-up/u);
    await expect(
      page.getByText(
        "We couldn’t use an existing passkey. Continue to create a new one.",
      ),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Continue with Passkey" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator("#app-brief")).toHaveValue(
      "Build a customer renewal dashboard.",
    );
    await expect(
      page.getByRole("heading", { name: "Build an app" }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "Connections" })).toHaveCount(
      0,
    );
    expect(await applicationCounts()).toMatchObject({
      users: 1,
      organizations: 1,
      members: 1,
      activeSessions: 1,
    });
  } finally {
    await authenticator.dispose();
  }
});

for (const provider of ["GitHub", "Vercel"] as const) {
  test(`anonymous brief survives ${provider} authentication`, async ({
    page,
  }) => {
    const brief = `Build a ${provider} operations dashboard.`;
    await page.goto("/");
    await page.getByLabel("What should this app do?").fill(brief);
    await page.getByRole("button", { name: "Continue" }).click();
    await finishOAuth(page, provider);
    await page.goto("/");
    await expect(page.locator("#app-brief")).toHaveValue(brief);
  });
}

test("missing passkey keeps the permanent Sign Up link without entering setup", async ({
  context,
  page,
}) => {
  const authenticator = await registerPasskey(context, page);
  await page.goto("/auth/sign-out");
  await authenticator.removeCredential(
    (await authenticator.credentials())[0]!.credentialId,
  );
  const signUpLink = page.getByRole("link", { name: "Sign Up" });
  await expect(signUpLink).toBeVisible();
  await page.getByRole("button", { name: "Continue with Passkey" }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in/u);
  await expect(signUpLink).toBeVisible();
  await signUpLink.click();
  await expect(page).toHaveURL(/\/auth\/sign-up/u);
  await expect(
    page.getByText(
      "We couldn’t use an existing passkey. Continue to create a new one.",
    ),
  ).toHaveCount(0);
  await expect(page.getByText("Setting up your workspace")).toHaveCount(0);
  expect(await applicationCounts()).toMatchObject({ users: 1, passkeys: 1 });
  await authenticator.dispose();
});

test("anonymous account settings redirects through a safe local callback", async ({
  page,
}) => {
  await page.goto("/settings/account");
  await expect(page).toHaveURL(/\/auth\/sign-in\?callbackURL=%2F/u);
});

test("anonymous setup fails closed with a callback-preserving sign-in link", async ({
  page,
}) => {
  const callbackURL = "/?source=expired-session#complete";
  await page.goto(
    `/auth/setting-up?callbackURL=${encodeURIComponent(callbackURL)}`,
  );

  await expect(
    page.getByRole("heading", { name: "Workspace setup failed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Return to sign in" }),
  ).toHaveAttribute(
    "href",
    `/auth/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`,
  );
});
