import { createServer } from "node:http";
import type { Server } from "node:http";

import axe from "axe-core";
import { expect, test } from "playwright/test";
import type { Page } from "playwright/test";

import { vendorOnboardingPrototype } from "../../agent/agent";

// Recorded HTML interaction coverage only, not evidence of Arrusted component
// inheritance. Component-backed preview proof must exercise the real renderer.

let prototypeServer: Server | undefined;
let prototypeUrl = "";

declare global {
  interface Window {
    axe?: { run: () => Promise<{ violations: unknown[] }> };
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function loadPrototype(page: Page) {
  await page.goto(prototypeUrl);
  await page.addScriptTag({ content: axe.source });
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
  const accessibility = await page.evaluate(async () => {
    const runner = window.axe;
    if (!runner) {
      throw new Error("axe-core was not loaded");
    }
    return await runner.run();
  });
  expect(accessibility.violations).toEqual([]);
  await expect(page.getByRole("heading", { name: "Vendor Review" })).toBeVisible();
}

test.beforeAll(async () => {
  prototypeServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(vendorOnboardingPrototype);
  });
  const { promise, resolve } = Promise.withResolvers<null>();
  prototypeServer.listen(0, "127.0.0.1", () => {
    resolve(null);
  });
  await promise;
  const address = prototypeServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Prototype server did not bind to a TCP address");
  }
  prototypeUrl = `http://127.0.0.1:${address.port}/prototype/vendor-onboarding`;
});

test.afterAll(() => {
  if (prototypeServer) {
    prototypeServer.closeAllConnections();
    prototypeServer.close();
  }
});

test.describe("recorded Vendor Onboarding prototype", () => {
  test("supports the desktop review flow", async ({ page }) => {
    await page.setViewportSize({ height: 902, width: 1592 });
    await loadPrototype(page);
    await page.getByRole("button", { name: "Kiteworks GmbH" }).click();
    await expect(page.getByRole("heading", { name: "Kiteworks GmbH" })).toBeVisible();
    await expect(page.locator("#tax-step")).toBeHidden();
  });

  test("keeps the workflow usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await loadPrototype(page);
    await expect(page.getByRole("button", { name: "Send to finance" })).toBeVisible();
  });
});
