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
  await expect(appName).toHaveValue(/^[A-Z][a-z]+ [A-Z][a-z]+$/u);
  await expect(page.getByRole("group", { name: "Connections" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Web Chat/u })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create App" })).toBeDisabled();

  await page.locator("#app-brief").fill("Build a customer support workspace.");
  await expect(appName).toHaveValue("Customer Support Workspace");
  await appName.fill("Operator Console");
  await page.locator("#app-brief").fill("Build a billing reconciliation tool.");
  await expect(appName).toHaveValue("Operator Console");
  await expect(page.getByRole("button", { name: "Create App" })).toBeEnabled();
});

test("Codex handoff includes connected provider choices and supports reset", async ({
  context,
  page,
}) => {
  await installBrowserBoundaries(context);
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await installProvider(page, "GitHub");
  await installProvider(page, "Vercel");

  await page.getByLabel("App Name").fill("Support Console");
  await page.locator("#app-brief").fill("Build a support operations console.");
  await page.getByLabel("Repository Name").fill("support-console");
  await page.getByLabel("Private repository").uncheck();
  await completeHandoff(page);

  const state = await browserBoundaryState(page);
  expect(state.clipboard).toHaveLength(1);
  expect(state.opened).toHaveLength(1);
  expect(state.clipboard[0]).toContain("App Name:\nSupport Console");
  expect(state.clipboard[0]).toContain("Repository:\nsupport-console");
  expect(state.clipboard[0]).toContain("Vercel Installation:\nicfg_local_1");
  expect(state.clipboard[0]).toContain("GitHub Installation:\n1001");
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

test("blocked and oversized handoffs expose actionable fallbacks", async ({
  context,
  page,
}) => {
  await installBrowserBoundaries(context, "blocked");
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await page.locator("#app-brief").fill("Build a fallback status test.");
  await completeHandoff(page);
  await expect(
    page.getByText("The browser blocked ChatGPT / Codex."),
  ).toBeVisible();
  await expect(page.getByText("Clipboard access was blocked.")).toBeVisible();

  await page.getByRole("button", { name: "Create Another App" }).click();
  await page.locator("#app-brief").fill("x".repeat(8_100));
  await completeHandoff(page);
  await expect(
    page.getByText("This brief is too long to open automatically"),
  ).toBeVisible();
});
