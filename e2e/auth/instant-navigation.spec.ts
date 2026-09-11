import { instant } from "@next/playwright";
import { expect, test } from "playwright/test";

const signUpPath = "/auth/sign-up?callbackURL=%2F";

test("sign-up exposes its useful shell on the initial response", async ({
  page,
  baseURL,
}) => {
  await instant(
    page,
    async () => {
      await page.goto(signUpPath);
      await expect(page.getByRole("status")).toHaveText("Loading App Builder…");
    },
    { baseURL },
  );

  await expect(
    page.getByRole("button", { name: "Continue with Passkey" }),
  ).toBeVisible();
});

test("sign-up exposes its useful shell on client navigation", async ({
  page,
}) => {
  await page.goto("/auth/sign-in?callbackURL=%2F");

  await instant(page, async () => {
    await page.getByRole("link", { name: "Sign Up" }).click();
    await page.waitForURL((url) => url.pathname === "/auth/sign-up");
    await expect(
      page.getByRole("button", { name: "Continue with Passkey" }),
    ).toBeVisible();
  });
});
