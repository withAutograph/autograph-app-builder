import { expect, test, type Page } from "playwright/test";

import { currentSession, resetApplicationState } from "../support/harness";

const html = (page: Page) => page.locator("html");

async function expectTheme(
  page: Page,
  theme: "light" | "dark",
  storedTheme?: "system" | "light" | "dark",
) {
  await expect(html(page)).toHaveClass(
    new RegExp(`(^|\\s)${theme}(\\s|$)`, "u"),
  );
  await expect(html(page)).toHaveCSS("color-scheme", theme);
  if (storedTheme) {
    await expect
      .poll(() => page.evaluate(() => localStorage.theme))
      .toBe(storedTheme);
  }
}

async function openAccountMenu(page: Page) {
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByRole("menuitem", { name: /Theme/u })).toBeVisible();
}

test.beforeEach(async () => resetApplicationState());

test("first visit follows System and reacts to an OS preference change", async ({
  page,
}) => {
  const hydrationMessages: string[] = [];
  page.on("console", (message) => {
    if (/hydration|did not match|server rendered html/iu.test(message.text())) {
      hydrationMessages.push(message.text());
    }
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expectTheme(page, "dark");
  await expect(
    page.getByRole("heading", { name: "Build an app" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.theme ?? null))
    .toBeNull();

  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  expect(hydrationMessages).toEqual([]);
});

test("stock menu and Appearance card share a persistent cross-tab preference", async ({
  context,
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/auth/sign-in?callbackURL=%2F");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect(page).toHaveURL(/\/local-oauth\/github\/authorize/u);
  await expectTheme(page, "dark");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect
    .poll(() => currentSession(page), { timeout: 30_000 })
    .toMatchObject({ user: { email: "dev@autograph.local" } });

  await page.goto("/");
  await openAccountMenu(page);
  const themeMenu = page.getByRole("menuitem", { name: /Theme/u });
  await expect(themeMenu.getByRole("tab", { name: "System" })).toBeVisible();
  await expect(themeMenu.getByRole("tab", { name: "Light" })).toBeVisible();
  await expect(themeMenu.getByRole("tab", { name: "Dark" })).toBeVisible();
  await themeMenu.getByRole("tab", { name: "Dark" }).click();
  await expectTheme(page, "dark", "dark");

  await page.reload();
  await expectTheme(page, "dark", "dark");
  await page.goto("/settings/account");
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();

  const secondPage = await context.newPage();
  try {
    await secondPage.emulateMedia({ colorScheme: "dark" });
    await secondPage.goto("/settings/account");
    await expectTheme(secondPage, "dark", "dark");

    await page.getByRole("radio", { name: "Light" }).click();
    await expectTheme(page, "light", "light");
    await expectTheme(secondPage, "light", "light");
    await expect(
      secondPage.getByRole("radio", { name: "Light" }),
    ).toBeChecked();

    await secondPage.getByRole("radio", { name: "System" }).click();
    await expectTheme(secondPage, "dark", "system");
    await expectTheme(page, "dark", "system");
    await expect(page.getByRole("radio", { name: "System" })).toBeChecked();
  } finally {
    await secondPage.close();
  }
});

test("explicit Dark remains active across anonymous, auth, builder, and account surfaces", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));

  await page.goto("/");
  await expectTheme(page, "dark", "dark");
  await expect(
    page.getByRole("heading", { name: "Build an app" }),
  ).toBeVisible();

  await page.goto("/auth/sign-in?callbackURL=%2F");
  await expectTheme(page, "dark", "dark");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect(page).toHaveURL(/\/local-oauth\/github\/authorize/u);
  await expectTheme(page, "dark", "dark");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect
    .poll(() => currentSession(page), { timeout: 30_000 })
    .toMatchObject({ user: { email: "dev@autograph.local" } });

  await page.goto("/");
  await expectTheme(page, "dark", "dark");
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();

  await page.goto("/settings/account");
  await expectTheme(page, "dark", "dark");
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
});
