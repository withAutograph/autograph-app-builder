import { expect, test } from "playwright/test";

import {
  browserBoundaryState,
  finishOAuth,
  installBrowserBoundaries,
  installProvider,
  resetApplicationState,
} from "../support/harness";

test.beforeEach(async () => resetApplicationState());

async function completeHandoff(page: import("playwright/test").Page) {
  await page.getByRole("button", { name: "Create App" }).click();
  await expect(page.getByRole("heading", { name: "Handoff" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "App Brief Ready!" }),
  ).toBeVisible({ timeout: 10_000 });
}

test("builder keeps generated fields user-owned and feature-gated", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  const appName = page.getByLabel("App Name");
  const appBrief = page.locator("#app-brief");
  const createApp = page.getByRole("button", { name: "Create App" });
  await expect(appName).toHaveValue("Product");
  await expect(page.getByRole("group", { name: "Connections" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Web Chat/u })).toHaveCount(0);
  await expect(createApp).toBeEnabled();

  await appBrief.fill("");
  await expect(createApp).toBeDisabled();

  await appBrief.fill("Build a customer support workspace.");
  await expect(appName).toHaveValue("Customer Support Workspace");
  await appName.fill("Operator Console");
  await appBrief.fill("Build a billing reconciliation tool.");
  await expect(appName).toHaveValue("Operator Console");
  await expect(createApp).toBeEnabled();
});

test("Codex handoff carries only opaque server-owned state and supports reset", async ({
  context,
  page,
}) => {
  await installBrowserBoundaries(context);
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await installProvider(page, "GitHub");
  await installProvider(page, "Vercel");

  await page.locator("#app-brief").fill("Build a support operations console.");
  await page.getByLabel("App Name").fill("Support Console");
  await page.locator("#repository-name").fill("support-console");
  await page.getByLabel("Private repository").uncheck();
  await completeHandoff(page);

  const state = await browserBoundaryState(page);
  expect(state.clipboard).toHaveLength(1);
  expect(state.opened).toHaveLength(1);
  expect(state.clipboard[0]).toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u,
  );
  expect(state.clipboard[0]).not.toContain("Support Console");
  expect(state.clipboard[0]).not.toContain("support-console");
  expect(state.clipboard[0]).not.toMatch(
    /GitHub Resource|Vercel Resource|Installation|Repository ID|Head SHA|digest/iu,
  );
  expect(state.opened[0]).toMatch(/^codex:\/\/new\?prompt=/u);
  expect(new URL(state.opened[0]!).searchParams.get("prompt")).toBe(
    state.clipboard[0],
  );

  await expect(
    page.getByText("Launch requested for ChatGPT / Codex"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy install command" }).click();
  await expect(page.getByText("Install command copied.")).toBeVisible();
  await page
    .getByRole("button", { name: "Dismiss install instructions" })
    .click();
  await expect(page.getByText("Install App Builder Plugin")).toHaveCount(0);
  await page.getByRole("button", { name: "Create Another App" }).click();
  await expect(
    page.getByRole("heading", { name: "Build an app" }),
  ).toBeVisible();
});

test("Cursor handoff carries the exact copied prompt", async ({
  context,
  page,
}) => {
  await installBrowserBoundaries(context);
  await finishOAuth(page, "Vercel");
  await page.goto("/");
  await page.locator("#app-brief").fill("Build a Cursor billing dashboard.");
  await page.getByRole("radio", { name: "Cursor" }).check();
  await completeHandoff(page);

  const state = await browserBoundaryState(page);
  expect(state.opened[0]).toMatch(
    /^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=/u,
  );
  expect(new URL(state.opened[0]!).searchParams.get("text")).toBe(
    state.clipboard[0],
  );
  await expect(
    page.getByRole("button", { name: "Open in Cursor" }),
  ).toBeVisible();
});

test("blocked handoffs remain actionable", async ({ context, page }) => {
  await installBrowserBoundaries(context, "blocked");
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await page.locator("#app-brief").fill("Build a fallback status test.");
  await completeHandoff(page);
  await expect(
    page.getByText("The browser blocked ChatGPT / Codex."),
  ).toBeVisible();
  await expect(page.getByText("Clipboard access was blocked.")).toBeVisible();
});

test("large briefs use fixed-size opaque handoff links", async ({
  context,
  page,
}) => {
  await installBrowserBoundaries(context);
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await page.locator("#app-brief").fill("x".repeat(8_100));
  await completeHandoff(page);
  const state = await browserBoundaryState(page);
  expect(state.opened.at(-1)?.length).toBeLessThan(8_000);
  expect(decodeURIComponent(state.opened.at(-1) ?? "")).not.toContain(
    "x".repeat(100),
  );
});
