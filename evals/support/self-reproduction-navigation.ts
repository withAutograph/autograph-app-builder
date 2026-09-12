import { instant } from "@next/playwright";
import { expect } from "playwright/test";
import type { Page } from "playwright";

/** Call inside a Playwright test, once per side in separate browser contexts.
 * Installed 16.3.4 guide: instant-navigation.md#prevent-regressions-with-e2e-tests.
 * Assertions inside instant see only immediately available UI. Assertions after
 * it prove the paused dynamic content actually resolves. No stopwatch proxy. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function assertParityNavigation(
  page: Page,
  recipe: {
    baseURL: string;
    destinationPath: string;
    sourcePath: string;
    linkSelector: string;
    shellSelector: string;
    resolvedSelector: string;
  },
) {
  const destination = new URL(recipe.destinationPath, recipe.baseURL).href;
  await instant(
    page,
    async () => {
      await page.goto(destination);
      await expect(page.locator(recipe.shellSelector)).toBeVisible();
    },
    { baseURL: recipe.baseURL },
  );
  await expect(page.locator(recipe.resolvedSelector)).toBeVisible();
  await page.goto(new URL(recipe.sourcePath, recipe.baseURL).href);
  await instant(page, async () => {
    await page.locator(recipe.linkSelector).click();
    await page.waitForURL(destination);
    await expect(page.locator(recipe.shellSelector)).toBeVisible();
  });
  await expect(page.locator(recipe.resolvedSelector)).toBeVisible();
}
