import { instant } from "@next/playwright";
import { expect, test } from "playwright/test";

const signUpPath = "/auth/sign-up?callbackURL=%2F";

test("sign-up exposes its useful shell on the initial response", async ({ page, baseURL }) => {
  await instant(
    page,
    async () => {
      await page.goto(signUpPath);
      await expect(page.getByRole("heading", { name: "Autograph App Builder" })).toBeVisible();
      await expect(page.getByRole("status")).toHaveText("Loading your workspace…");
    },
    { baseURL },
  );

  await expect(page.getByRole("button", { name: "Continue with Passkey" })).toBeVisible();
});

test("the builder direct load has a branded static shell", async ({ page, baseURL }) => {
  await instant(
    page,
    async () => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Autograph App Builder" })).toBeVisible();
      await expect(page.getByLabel("App Builder loading")).toBeVisible();
    },
    { baseURL },
  );
});

test("sign-up exposes its useful shell on client navigation", async ({ page }) => {
  await page.goto("/auth/sign-in?callbackURL=%2F");

  await instant(page, async () => {
    await page.getByRole("link", { name: "Sign Up" }).click();
    await page.waitForURL((url) => url.pathname === "/auth/sign-up");
    // A completed prefetch may already contain the form. Both states provide
    // useful content without waiting for a navigation-time server response.
    await expect(
      page
        .getByRole("region", { name: "Authentication form loading" })
        .or(page.getByRole("button", { name: "Continue with Passkey" }))
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
  });

  await expect(page.getByRole("button", { name: "Continue with Passkey" })).toBeVisible();
});

test("a real provider back link exposes the labelled builder shell immediately", async ({
  page,
}) => {
  await page.goto("/github/installations");
  await expect(page.getByRole("button", { name: "Install or update GitHub access" })).toBeVisible();

  await instant(page, async () => {
    await page.getByRole("link", { name: "Back" }).click();
    await page.waitForURL("/");
    await expect(page.getByRole("heading", { name: "Create an app" })).toBeVisible();
    const shell = page.getByRole("region", { name: "Builder form loading" });
    await expect(shell).toBeVisible();
    await expect(shell.getByText("App Name", { exact: true })).toBeVisible();
    await expect(shell.getByText("What should this app do?", { exact: true })).toBeVisible();
  });
});
