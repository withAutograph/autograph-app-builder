import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import * as axe from "axe-core";
import { expect, test, type Page } from "playwright/test";

import { vendorOnboardingPrototype } from "../../agent/agent";

// Recorded HTML interaction coverage only, not evidence of Arrusted component
// inheritance. Component-backed preview proof must exercise the real renderer.

let prototypeServer: Server | undefined;
let prototypeUrl = "";

async function loadPrototype(page: Page) {
  await page.goto(prototypeUrl);
  await page.addScriptTag({ content: axe.source });
  const accessibility = await page.evaluate(async () => {
    const runner = (
      globalThis as typeof globalThis & {
        axe: { run: () => Promise<{ violations: unknown[] }> };
      }
    ).axe;
    return runner.run();
  });
  expect(accessibility.violations).toEqual([]);
  await expect(
    page.getByRole("heading", { name: "Vendor Review" }),
  ).toBeVisible();
}

test.beforeAll(async () => {
  prototypeServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(vendorOnboardingPrototype);
  });
  await new Promise<void>((resolveServer) => {
    prototypeServer?.listen(0, "127.0.0.1", resolveServer);
  });
  const address = prototypeServer.address() as AddressInfo;
  prototypeUrl = `http://127.0.0.1:${address.port}/prototype/vendor-onboarding`;
});

test.afterAll(
  async () =>
    await new Promise<void>((resolveServer, rejectServer) => {
      prototypeServer?.close((error) => {
        if (error === undefined) resolveServer();
        else rejectServer(error);
      });
    }),
);

test.describe("recorded Vendor Onboarding prototype", () => {
  test("supports the desktop review flow", async ({ page }) => {
    await page.setViewportSize({ width: 1592, height: 902 });
    await loadPrototype(page);
    await page.getByRole("button", { name: "Kiteworks GmbH" }).click();
    await expect(
      page.getByRole("heading", { name: "Kiteworks GmbH" }),
    ).toBeVisible();
    await expect(page.locator("#tax-step")).toBeHidden();
  });

  test("keeps the workflow usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadPrototype(page);
    await expect(
      page.getByRole("button", { name: "Send to finance" }),
    ).toBeVisible();
  });
});
