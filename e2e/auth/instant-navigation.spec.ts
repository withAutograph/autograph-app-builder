import { instant } from "@next/playwright";
import { expect, test } from "playwright/test";

const signUpPath = "/auth/sign-up?callbackURL=%2F";

test("sign-up exposes its useful shell on the initial response", async ({ page, baseURL }) => {
  await instant(
    page,
    async () => {
      await page.goto(signUpPath);
      await expect(
        page.getByRole("heading", { name: "Create your Autograph account" }),
      ).toBeVisible();
      await expect(page.getByRole("region", { name: "Authentication form loading" })).toBeVisible();
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
      await expect(page.getByRole("heading", { name: "Create an app" })).toBeVisible();
      const shell = page.getByRole("region", { name: "Builder form loading" });
      await expect(shell).toBeVisible();
      await expect(shell.getByText("App Name", { exact: true })).toBeVisible();
      await expect(shell.getByText("What should this app do?", { exact: true })).toBeVisible();
    },
    { baseURL },
  );
});

for (const { path, title, region } of [
  {
    path: "/auth/sign-in?callbackURL=%2F",
    title: "Sign in to Autograph",
    region: "Authentication form loading",
  },
  {
    path: "/github/installations",
    title: "Connect a GitHub App installation",
    region: "Provider connection loading",
  },
  {
    path: "/vercel/installations",
    title: "Connect a Vercel team",
    region: "Provider connection loading",
  },
  {
    path: "/handoff/00000000-0000-4000-8000-000000000001",
    title: "Continue your app",
    region: "Handoff loading",
  },
]) {
  test(`${path} has its destination shell before request data`, async ({ page, baseURL }) => {
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
  });
}

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

for (const { label, pathname } of [
  { label: "Sign In", pathname: "/auth/sign-in" },
  { label: "Sign Up", pathname: "/auth/sign-up" },
]) {
  test(`the primary ${label} link navigates instantly from the builder`, async ({ page }) => {
    await page.goto("/?mode=anonymous");
    await expect(page.getByLabel("What should this app do?")).toBeEnabled();
    await instant(page, async () => {
      await page.getByRole("link", { name: label, exact: true }).click();
      await page.waitForURL((url) => url.pathname === pathname);
      await expect(
        page
          .getByRole("region", { name: "Authentication form loading" })
          .or(page.getByRole("button", { name: "Continue with Passkey" }))
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    });
    await expect(page.getByRole("button", { name: "Continue with Passkey" })).toBeEnabled();
  });
}

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
