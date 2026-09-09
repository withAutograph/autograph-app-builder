import { expect, test } from "playwright/test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import { setupCursorClient } from "../../lib/auth/cursor-client";
import * as schema from "../../lib/db/schema";

import {
  browserBoundaryState,
  appOrigin,
  databaseUrl,
  finishOAuth,
  installBrowserBoundaries,
  installProvider,
  resetApplicationState,
} from "../support/harness";

test.beforeEach(async () => resetApplicationState());

async function completeHandoff(page: import("playwright/test").Page) {
  await page.getByRole("button", { name: "Create App" }).click();
  await expect(page).toHaveURL(/\/handoff\/[0-9a-f-]{36}$/u, {
    timeout: 30_000,
  });
  await expect(
    page.getByRole("region", { name: "Continue your app" }),
  ).toBeVisible();
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

  expect(await browserBoundaryState(page)).toEqual({
    clipboard: [],
    opened: [],
  });
  const handoffUrl = page.url();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Support Console" }),
  ).toBeVisible();
  await expect(
    page.getByText("Continued in your app", { exact: false }),
  ).toHaveCount(0);
  const response = await page.request.get(
    `/api/builder/handoffs/${new URL(handoffUrl).pathname.split("/").at(-1)}`,
  );
  expect(response.ok()).toBe(true);
  const saved = await response.json();
  expect(saved.status).toBe("prepared");
  expect(saved.intent.appName).toBe("Support Console");
  expect(saved.intent.repository.requestedName).toBe("support-console");
  await page
    .getByRole("button", { name: "Open in Codex", exact: true })
    .click();
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();

  const state = await browserBoundaryState(page);
  expect(state.clipboard).toHaveLength(1);
  expect(state.opened).toHaveLength(1);
  expect(state.clipboard[0]).toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u,
  );
  expect(state.clipboard[0]).not.toContain("Support Console");
  expect(state.clipboard[0]).not.toContain("support-console");
  expect(state.clipboard[0]).not.toMatch(
    /GitHub Resource|Vercel Resource|Installation[ _-]?ID|Repository ID|Head SHA|digest/iu,
  );
  expect(state.opened[0]).toMatch(/^codex:\/\/new\?prompt=/u);
  expect(new URL(state.opened[0]!).searchParams.get("prompt")).toBe(
    state.clipboard[0],
  );

  await expect(
    page.getByText("Launch requested for Codex", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Continued in your app", { exact: false }),
  ).toHaveCount(0);
  await page.getByText("Set up Autograph in Codex", { exact: true }).click();
  await expect(page.locator("pre code")).toContainText(
    "codex plugin add app-builder@autograph",
  );
  await page.getByRole("link", { name: "Create another app" }).click();
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
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await setupCursorClient(drizzle(sql, { schema }), `${appOrigin}/mcp`);
  } finally {
    await sql.end();
  }
  await page.goto("/");
  await page.locator("#app-brief").fill("Build a Cursor billing dashboard.");
  await page.getByRole("radio", { name: "Cursor" }).check();
  await completeHandoff(page);

  expect(await browserBoundaryState(page)).toEqual({
    clipboard: [],
    opened: [],
  });
  await expect(
    page.getByRole("radio", { name: "Cursor", exact: true }),
  ).toBeChecked();
  await page.getByText("Set up Autograph in Cursor", { exact: true }).click();
  const install = page.getByRole("link", { name: "Add Autograph to Cursor" });
  await expect(install).toBeVisible();
  const installUrl = new URL((await install.getAttribute("href"))!);
  expect(
    JSON.parse(
      Buffer.from(installUrl.searchParams.get("config")!, "base64").toString(
        "utf8",
      ),
    ),
  ).toEqual({
    url: `${appOrigin}/mcp`,
    auth: { CLIENT_ID: "autograph-cursor-desktop" },
  });
  await page
    .getByRole("button", { name: "Open in Cursor", exact: true })
    .click();
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();

  const state = await browserBoundaryState(page);
  expect(state.clipboard[0]).not.toContain("codex plugin");
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
  await page
    .getByRole("button", { name: "Open in Codex", exact: true })
    .click();
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await expect(
    page.getByText("The browser blocked Codex.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Copy failed.", { exact: false })).toBeVisible();
  await page.getByText("View prompt for manual copy", { exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Handoff prompt" }),
  ).toHaveValue(/autograph_start/u);
});

test("expired handoff renews in place without changing intent or provisioning resources", async ({
  context,
  page,
}) => {
  await installBrowserBoundaries(context);
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await page
    .locator("#app-brief")
    .fill("Build a support console that survives handoff expiry.");
  await page.getByLabel("App Name").fill("Renewal Console");
  await completeHandoff(page);

  const handoffUrl = page.url();
  const handoffId = new URL(handoffUrl).pathname.split("/").at(-1)!;
  const statusPath = `/api/builder/handoffs/${handoffId}`;
  const preparedResponse = await page.request.get(statusPath);
  expect(preparedResponse.ok()).toBe(true);
  const prepared = await preparedResponse.json();
  expect(prepared.status).toBe("prepared");

  const provisioningRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/builder/provision"
    )
      provisioningRequests.push(request.url());
  });
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Include any existing resource receipts, without requiring provisioning
    // to be enabled for this real database expiry/CAS acceptance case.
    const journalSnapshot = () => sql`
      SELECT j.request_id, j.request_digest, j.state, j.revision, j.record
      FROM builder_provisioning_journal j
      JOIN builder_handoff h ON
        j.issuer = h.issuer AND j.audience = h.audience AND
        j.workspace_id = h.workspace_id AND j.owner_user_id = h.owner_user_id
      WHERE h.handoff_id = ${handoffId}
      ORDER BY j.request_id
    `;
    const journalsBefore = await journalSnapshot();
    const expired = await sql`
      UPDATE builder_handoff
      SET created_at = now() - interval '2 minutes',
          expires_at = now() - interval '1 minute'
      WHERE handoff_id = ${handoffId} AND redeemed_at IS NULL AND session_id IS NULL
      RETURNING handoff_id
    `;
    expect(expired).toHaveLength(1);

    await page.reload();
    await expect(
      page.getByText("This handoff has expired.", { exact: false }),
    ).toBeVisible();
    const launch = page.getByRole("button", {
      name: "Open in Codex",
      exact: true,
    });
    await expect(launch).toBeDisabled();
    const renewalResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `${statusPath}/renew`,
    );
    await page
      .getByRole("button", { name: "Renew handoff", exact: true })
      .click();
    const renewedResponse = await renewalResponse;
    expect(renewedResponse.ok()).toBe(true);
    expect((await renewedResponse.json()).handoffId).toBe(handoffId);
    await expect(launch).toBeEnabled();
    await expect(page).toHaveURL(handoffUrl);
    await expect(
      page.getByText("This handoff has expired.", { exact: false }),
    ).toHaveCount(0);

    const statusResponse = await page.request.get(statusPath);
    expect(statusResponse.ok()).toBe(true);
    const renewed = await statusResponse.json();
    expect(renewed.handoffId).toBe(handoffId);
    expect(renewed.status).toBe("prepared");
    expect(renewed.intent).toEqual(prepared.intent);
    const rows = await sql`
      SELECT intent, expires_at > now() AS unexpired, redeemed_at, session_id
      FROM builder_handoff WHERE handoff_id = ${handoffId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intent: prepared.intent,
      unexpired: true,
      redeemed_at: null,
      session_id: null,
    });
    expect(await journalSnapshot()).toEqual(journalsBefore);
    expect(provisioningRequests).toEqual([]);
    expect(await browserBoundaryState(page)).toEqual({
      clipboard: [],
      opened: [],
    });
  } finally {
    await sql.end();
  }
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
  await page
    .getByRole("button", { name: "Open in Codex", exact: true })
    .click();
  const state = await browserBoundaryState(page);
  expect(state.opened.at(-1)?.length).toBeLessThan(8_000);
  expect(decodeURIComponent(state.opened.at(-1) ?? "")).not.toContain(
    "x".repeat(100),
  );
});
