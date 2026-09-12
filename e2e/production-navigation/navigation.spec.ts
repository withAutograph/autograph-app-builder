import { instant } from "@next/playwright";
import { expect, test } from "playwright/test";

import { blockExternalRequests, seedIdentity } from "./fixture";

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

for (const { path, title, region, button } of [
  {
    path: "/auth/sign-in?callbackURL=%2F",
    title: "Sign in to Autograph",
    region: "Authentication form loading",
    button: /GitHub/iu,
  },
  {
    path: "/auth/sign-up?callbackURL=%2F",
    title: "Create your Autograph account",
    region: "Authentication form loading",
    button: /GitHub/iu,
  },
  {
    path: "/github/installations",
    title: "Connect a GitHub App installation",
    region: "Provider connection loading",
    button: "Install or update GitHub access",
  },
  {
    path: "/vercel/installations",
    title: "Connect a Vercel team",
    region: "Provider connection loading",
    button: "Connect to Vercel",
  },
]) {
  test(`${path} streams its meaningful production shell and resolves`, async ({
    page,
    baseURL,
  }) => {
    await instant(
      page,
      async () => {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: region })).toBeVisible();
        await expect(page.getByText("Autograph", { exact: true })).toBeVisible();
      },
      { baseURL },
    );
    await expect(page.getByRole("button", { name: button })).toBeEnabled();
    await expect(page.getByRole("region", { name: region })).toHaveCount(0);
  });
}

test("builder shell streams before an authenticated saved draft", async ({
  context,
  page,
  baseURL,
}) => {
  const identity = await seedIdentity(context, "Production restored app");
  await instant(
    page,
    async () => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Create an app" })).toBeVisible();
      const shell = page.getByRole("region", { name: "Builder form loading" });
      await expect(shell.getByText("App Name", { exact: true })).toBeVisible();
      await expect(shell.getByText("What should this app do?", { exact: true })).toBeVisible();
    },
    { baseURL },
  );
  await expect(page.getByLabel("App Name", { exact: true })).toHaveValue(identity.appName);
  await expect(page.getByLabel("What should this app do?")).toHaveValue(
    `Saved brief for ${identity.appName}`,
  );
});

for (const { label, pathname } of [
  { label: "Sign In", pathname: "/auth/sign-in" },
  { label: "Sign Up", pathname: "/auth/sign-up" },
]) {
  test(`real ${label} Link uses a prefetched production destination`, async ({ page }) => {
    await page.goto("/?mode=anonymous");
    await expect(page.getByLabel("What should this app do?")).toBeEnabled();
    await instant(page, async () => {
      await page.getByRole("link", { name: label, exact: true }).click();
      await page.waitForURL((url) => url.pathname === pathname);
      await expect(
        page
          .getByRole("region", { name: "Authentication form loading" })
          .or(page.getByRole("button", { name: /GitHub/iu }))
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    });
    await expect(page.getByRole("button", { name: /GitHub/iu })).toBeEnabled();
  });
}

test("provider Back Link commits the builder before deferred content", async ({ page }) => {
  await page.goto("/github/installations");
  await expect(page.getByRole("button", { name: "Install or update GitHub access" })).toBeEnabled();
  await instant(page, async () => {
    await page.getByRole("link", { name: "Back", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByRole("heading", { name: "Create an app" })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Builder form loading" })
        .or(page.getByLabel("What should this app do?"))
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });
  await expect(page.getByLabel("What should this app do?")).toBeEnabled();
});

test("handoff direct load streams and resolves to account recovery", async ({ page, baseURL }) => {
  await instant(
    page,
    async () => {
      await page.goto("/handoff/00000000-0000-4000-8000-000000000001");
      await expect(page.getByRole("heading", { name: "Continue your app" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Handoff loading" })).toBeVisible();
    },
    { baseURL },
  );
  await expect(
    page
      .getByRole("heading", { name: "Handoff unavailable" })
      .or(page.getByRole("button", { name: /GitHub/iu }))
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
});

test("two authenticated contexts keep drafts and sign-up identity request-fresh", async ({
  browser,
  baseURL,
}) => {
  const first = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
  });
  const second = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
  });
  try {
    await blockExternalRequests(first);
    await blockExternalRequests(second);
    await seedIdentity(first, "First device workspace");
    await seedIdentity(second, "Second device workspace");
    const firstPage = await first.newPage();
    const secondPage = await second.newPage();
    await firstPage.goto("/");
    await secondPage.goto("/");
    await expect(firstPage.getByLabel("App Name", { exact: true })).toHaveValue(
      "First device workspace",
    );
    await expect(secondPage.getByLabel("App Name", { exact: true })).toHaveValue(
      "Second device workspace",
    );
    await firstPage.goto("/auth/sign-up?callbackURL=%2F");
    await firstPage.waitForURL((url) => url.pathname === "/");
    await expect(firstPage.getByLabel("App Name", { exact: true })).toHaveValue(
      "First device workspace",
    );
    await first.clearCookies();
    await firstPage.goto("/auth/sign-up?callbackURL=%2F");
    await expect(firstPage.getByRole("button", { name: /GitHub/iu })).toBeEnabled();
    await secondPage.reload();
    await expect(secondPage.getByLabel("App Name", { exact: true })).toHaveValue(
      "Second device workspace",
    );
  } finally {
    await first.close();
    await second.close();
  }
});
