import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import * as axe from "axe-core";
import { expect, test, type Page } from "playwright/test";

import { vendorOnboardingPrototype } from "../../agent/agent";

const visualRoot = resolve(__dirname, "__visual__");
const evidenceRoot = resolve(
  process.env.APP_BUILDER_PRODUCT_EVAL_REPORT_DIR ??
    ".artifacts/product-quality",
  "vendor-onboarding",
);
const updatingBaseline =
  process.env.APP_BUILDER_PRODUCT_EVAL_UPDATE_VISUAL === "1";
let prototypeServer: Server | undefined;
let prototypeUrl = "";

async function attachVisualEvidence(page: Page, name: string): Promise<void> {
  const screenshot = await page.screenshot({ fullPage: true });
  const baselinePath = resolve(visualRoot, `${name}.png`);
  const screenshotDigest = createHash("sha256")
    .update(screenshot)
    .digest("hex");
  let status: "matched" | "drifted" | "unbaselined" | "updated";
  if (updatingBaseline) {
    await mkdir(visualRoot, { recursive: true });
    await writeFile(baselinePath, screenshot);
    status = "updated";
  } else if (!existsSync(baselinePath)) status = "unbaselined";
  else {
    const baseline = await readFile(baselinePath);
    status = baseline.equals(screenshot) ? "matched" : "drifted";
  }
  await test.info().attach(`${name}.png`, {
    body: screenshot,
    contentType: "image/png",
  });
  await test.info().attach(`${name}.json`, {
    body: Buffer.from(
      `${JSON.stringify({ status, screenshotDigest, baselinePath }, null, 2)}\n`,
    ),
    contentType: "application/json",
  });
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(resolve(evidenceRoot, `${name}.png`), screenshot);
  const semanticEvidence = await page.evaluate(() => ({
    title: document.title,
    landmarks: [...document.querySelectorAll("main, section")].map(
      (element) => ({
        tagName: element.tagName.toLowerCase(),
        label:
          element.getAttribute("aria-label") ??
          element.getAttribute("aria-labelledby"),
      }),
    ),
    headings: [...document.querySelectorAll("h1, h2, h3")].map((heading) =>
      heading.textContent?.trim(),
    ),
    buttons: [...document.querySelectorAll("button")].map((button) =>
      button.textContent?.trim(),
    ),
  }));
  await writeFile(
    resolve(evidenceRoot, `${name}.semantic.json`),
    `${JSON.stringify(semanticEvidence, null, 2)}\n`,
  );
}

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
    page.getByRole("heading", { name: "Vendor Onboarding" }),
  ).toBeVisible();
}

test.beforeAll(async () => {
  prototypeServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(vendorOnboardingPrototype);
  });
  await new Promise<void>((resolveServer) =>
    prototypeServer?.listen(0, "127.0.0.1", resolveServer),
  );
  const address = prototypeServer.address() as AddressInfo;
  prototypeUrl = `http://127.0.0.1:${address.port}/prototype/vendor-onboarding`;
});

test.afterAll(
  async () =>
    await new Promise<void>((resolveServer, rejectServer) =>
      prototypeServer?.close((error) =>
        error === undefined ? resolveServer() : rejectServer(error),
      ),
    ),
);

test.describe("recorded Vendor Onboarding prototype", () => {
  test("supports the desktop review flow and reports visual drift", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loadPrototype(page);
    await page.getByRole("button", { name: "Kiteworks GmbH" }).click();
    await expect(
      page.getByRole("heading", { name: "Kiteworks GmbH" }),
    ).toBeVisible();
    await expect(page.locator("#tax-step")).toBeHidden();
    await attachVisualEvidence(page, "vendor-onboarding-desktop");
  });

  test("keeps the workflow usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadPrototype(page);
    await expect(
      page.getByRole("button", { name: "Send to finance" }),
    ).toBeVisible();
    await attachVisualEvidence(page, "vendor-onboarding-mobile");
  });
});
