import { expect, test, type Page } from "playwright/test";

const authenticatedStory =
  "/iframe.html?id=create-app-page--default&viewMode=story";
const anonymousStory =
  "/iframe.html?id=create-app-flow-anonymous-entry--empty&viewMode=story";

const screenshotOptions = {
  animations: "disabled" as const,
  caret: "hide" as const,
  maxDiffPixelRatio: 0.005,
  scale: "css" as const,
  threshold: 0.2,
};

async function openAuthenticatedStory(page: Page) {
  await page.goto(authenticatedStory);
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
  await expect(page.getByLabel("App Name")).toBeVisible();
  await page.getByLabel("App Name").fill("Visual Regression");
  await expect(page.getByLabel("App Name")).toHaveValue("Visual Regression");
  await page.evaluate(() => document.fonts.ready);
}

async function openAnonymousStory(page: Page) {
  await page.goto(anonymousStory);
  await expect(
    page.getByRole("heading", { name: "Build an app" }),
  ).toBeVisible();
  await expect(page.getByLabel("What should this app do?")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test.describe("App Builder visual regression — desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("authenticated", async ({ page }) => {
    await openAuthenticatedStory(page);
    await expect(page).toHaveScreenshot(
      "app-builder-authenticated-desktop.png",
      screenshotOptions,
    );
  });

  test("anonymous", async ({ page }) => {
    await openAnonymousStory(page);
    await expect(page).toHaveScreenshot(
      "app-builder-anonymous-desktop.png",
      screenshotOptions,
    );
  });
});

test.describe("App Builder visual regression — mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("authenticated", async ({ page }) => {
    await openAuthenticatedStory(page);
    await expect(page).toHaveScreenshot(
      "app-builder-authenticated-mobile.png",
      screenshotOptions,
    );
  });

  test("anonymous", async ({ page }) => {
    await openAnonymousStory(page);
    await expect(page).toHaveScreenshot(
      "app-builder-anonymous-mobile.png",
      screenshotOptions,
    );
  });
});
