import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "playwright/test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";

import {
  cursorClientId,
  setupCursorClient,
} from "../../lib/auth/cursor-client";
import * as schema from "../../lib/db/schema";

import {
  browserBoundaryState,
  appOrigin,
  databaseUrl,
  currentSession,
  finishOAuth,
  installBrowserBoundaries,
  installProvider,
  resetApplicationState,
  registerPasskey,
} from "../support/harness";

// OAuth callbacks and browser cookies must not enter failure artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

// These browser cases exercise the web UI with local auth/Postgres. The explicit
// binding fixture below proves UI observation only, not MCP redemption.
// Native manual QA still needs fresh Codex/Cursor profiles on the same Preview
// endpoint: record client versions, one initial consent, no repeated provider
// auth, actual autograph_start redemption, and authenticated provider readbacks.
// Record sanitized outcomes only; never attach cookies, tokens, callback URLs,
// or raw status responses. No native-client acceptance is claimed by this suite.

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

async function getWithTransientRetry(page: Page, path: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await page.request.get(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT)/u.test(message);
      if (!retryable || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

async function prepareNamedHandoff(
  page: Page,
  appName: string,
  brief: string,
  destination: "Codex" | "Cursor" = "Codex",
) {
  await page.goto("/");
  // A cold tab can expose the SSR textarea before React installs its value
  // and handlers. Exercise an actual form interaction before replacing text;
  // otherwise browser fill can insert ahead of the late default example.
  await page
    .getByRole("button", { name: "Try another app brief example" })
    .click();
  await expect(page.locator("#app-brief")).toHaveValue(
    /^# Customer feedback portal/u,
  );
  await page.locator("#app-brief").fill(brief);
  await page.getByLabel("App Name").fill(appName);
  if (destination === "Cursor")
    await page.getByRole("radio", { name: "Cursor", exact: true }).check();
  await expect(page.locator("#app-brief")).toHaveValue(brief);
  await completeHandoff(page);
  const url = page.url();
  const pathname = new URL(url).pathname;
  const id = pathname.split("/").at(-1)!;
  return { url, pathname, id, statusPath: `/api/builder/handoffs/${id}` };
}

test("multiple handoffs reload independently without replacing saved app context", async ({
  context,
  page,
}) => {
  await installBrowserBoundaries(context);
  await finishOAuth(page, "GitHub");
  const first = await prepareNamedHandoff(
    page,
    "First Console",
    "Keep the first prepared app independent.",
  );
  const otherPage = await context.newPage();
  try {
    const second = await prepareNamedHandoff(
      otherPage,
      "Second Console",
      "Keep the second prepared app independent.",
      "Cursor",
    );
    expect(first.id).not.toBe(second.id);
    for (const [
      activePage,
      handoff,
      otherHandoff,
      name,
      brief,
      destination,
    ] of [
      [
        page,
        first,
        second,
        "First Console",
        "Keep the first prepared app independent.",
        "Codex",
      ],
      [
        otherPage,
        second,
        first,
        "Second Console",
        "Keep the second prepared app independent.",
        "Cursor",
      ],
    ] as const) {
      await activePage.bringToFront();
      await activePage.reload();
      await expect(activePage).toHaveURL(handoff.url);
      await expect(
        activePage.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      await activePage.getByText("Prepared brief", { exact: true }).click();
      await expect(activePage.getByText(brief, { exact: true })).toBeVisible();
      await expect(
        activePage.getByRole("radio", { name: destination, exact: true }),
      ).toBeChecked();
      const response = await getWithTransientRetry(
        activePage,
        handoff.statusPath,
      );
      expect(response.ok()).toBe(true);
      const status = await response.json();
      expect(status.handoffId).toBe(handoff.id);
      expect(status.intent.appName).toBe(name);
      expect(status.intent.brief).toBe(brief);
      expect(status.status).toBe("prepared");
      await activePage
        .getByRole("button", { name: "Copy prompt", exact: true })
        .click();
      const boundary = await browserBoundaryState(activePage);
      expect(boundary.clipboard.at(-1)).toContain(handoff.id);
      expect(boundary.clipboard.at(-1)).not.toContain(otherHandoff.id);
    }
  } finally {
    await otherPage.close();
  }
});

test("fresh anonymous and distinct passkey accounts cannot read another user's handoff", async ({
  browser,
  context,
  page,
}) => {
  await finishOAuth(page, "GitHub");
  const ownerId = (await currentSession(page))?.user?.id;
  expect(typeof ownerId).toBe("string");
  const handoff = await prepareNamedHandoff(
    page,
    "Owner Private Console",
    "This prepared brief belongs only to its owner.",
  );
  const stranger = await browser.newContext({
    baseURL: appOrigin,
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
  });
  let authenticator: Awaited<ReturnType<typeof registerPasskey>> | undefined;
  try {
    const strangerPage = await stranger.newPage();
    const anonymousResponse = await strangerPage.request.get(
      handoff.statusPath,
    );
    expect(anonymousResponse.status()).toBe(401);
    const anonymousBody = await anonymousResponse.json();
    expect(Object.keys(anonymousBody)).toEqual(["error"]);
    expect(anonymousBody.error).toBe("authentication_required");
    expect(anonymousResponse.headers()["cache-control"]).toContain("no-store");
    await strangerPage.goto(handoff.url);
    await expect(strangerPage).toHaveURL(/\/auth\/sign-in\?/u);
    expect(new URL(strangerPage.url()).searchParams.get("callbackURL")).toBe(
      handoff.pathname,
    );
    await expect(
      strangerPage.getByRole("heading", { name: "Owner Private Console" }),
    ).toHaveCount(0);

    // Copy only the test's passkey feature flag, never the owner's auth cookies.
    await stranger.addCookies(
      (await context.cookies()).filter(
        ({ name }) => name === "vercel-flag-overrides",
      ),
    );
    authenticator = await registerPasskey(stranger, strangerPage);
    await expect(strangerPage).toHaveURL(`${appOrigin}/`);
    const strangerId = (await currentSession(strangerPage))?.user?.id;
    expect(typeof strangerId).toBe("string");
    expect(strangerId).not.toBe(ownerId);
    const unavailableResponse = await strangerPage.request.get(
      handoff.statusPath,
    );
    expect(unavailableResponse.status()).toBe(404);
    const unavailableBody = await unavailableResponse.json();
    expect(Object.keys(unavailableBody)).toEqual(["error"]);
    expect(unavailableBody.error).toBe("handoff_unavailable");
    expect(unavailableResponse.headers()["cache-control"]).toContain(
      "no-store",
    );
    await strangerPage.goto(handoff.url);
    await expect(
      strangerPage.getByRole("heading", { name: "Handoff unavailable" }),
    ).toBeVisible();
    await expect(
      strangerPage.getByText("Owner Private Console", { exact: true }),
    ).toHaveCount(0);
    await expect(
      strangerPage.getByText("This prepared brief belongs only to its owner.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      strangerPage.getByRole("textbox", { name: "Handoff prompt" }),
    ).toHaveCount(0);
    const ownerResponse = await page.request.get(handoff.statusPath);
    expect(ownerResponse.ok()).toBe(true);
    expect((await ownerResponse.json()).status).toBe("prepared");
  } finally {
    try {
      await authenticator?.dispose();
    } finally {
      await stranger.close();
    }
  }
});

test("visible polling observes an explicit DB binding fixture (UI observation only, not MCP redemption)", async ({
  context,
  page,
}) => {
  await installBrowserBoundaries(context);
  await finishOAuth(page, "GitHub");
  const handoff = await prepareNamedHandoff(
    page,
    "Observed Console",
    "Observe server-confirmed continuation only.",
  );
  await page.bringToFront();
  await expect
    .poll(() => page.evaluate(() => document.visibilityState))
    .toBe("visible");
  const continued = page.getByText("Continued in your app.", { exact: false });
  expect((await browserBoundaryState(page)).opened).toHaveLength(1);
  await expect(continued).toHaveCount(0);
  const before = await page.request.get(handoff.statusPath);
  expect(before.ok()).toBe(true);
  expect((await before.json()).status).toBe("prepared");

  let polled = 0;
  let mcpRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === handoff.statusPath)
      polled += 1;
    if (pathname === "/mcp") mcpRequests += 1;
  });
  const fixtureSessionId = `ui-observation-fixture:${randomUUID()}`;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // This fixture deliberately bypasses MCP. Only the persisted web-status
    // observation is under test; no agent session or provider work is created.
    const rows = await sql`
      UPDATE builder_handoff SET redeemed_at = now(), session_id = ${fixtureSessionId}
      WHERE handoff_id = ${handoff.id} AND redeemed_at IS NULL
        AND session_id IS NULL AND expires_at > now()
      RETURNING handoff_id
    `;
    expect(rows).toHaveLength(1);
    await expect(continued).toBeVisible({ timeout: 15_000 });
    expect(polled).toBeGreaterThan(0);
    const after = await page.request.get(handoff.statusPath);
    expect(after.ok()).toBe(true);
    expect((await after.json()).status).toBe("continued");
    expect(mcpRequests).toBe(0);
    expect((await browserBoundaryState(page)).opened).toHaveLength(1);
  } finally {
    try {
      await sql`
        UPDATE builder_handoff SET redeemed_at = NULL, session_id = NULL
        WHERE handoff_id = ${handoff.id} AND session_id = ${fixtureSessionId}
      `;
    } finally {
      await sql.end();
    }
  }
});

test("Cursor install link remains hidden until its dedicated local client is registered", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  const sql = postgres(databaseUrl, { max: 1 });
  const database = drizzle(sql, { schema });
  try {
    const clientsBefore = await database
      .select()
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, cursorClientId));
    const bindingsBefore = await database
      .select()
      .from(schema.oauthClientResource)
      .where(eq(schema.oauthClientResource.clientId, cursorClientId));
    try {
      // resetApplicationState does not necessarily remove this public client.
      // Target only the dedicated local registration and restore it in finally.
      await database
        .delete(schema.oauthClient)
        .where(eq(schema.oauthClient.clientId, cursorClientId));
      const handoff = await prepareNamedHandoff(
        page,
        "Cursor Setup Console",
        "Wait for the local Cursor connection setup.",
        "Cursor",
      );
      await page.bringToFront();
      await page
        .getByText("Set up Autograph in Cursor", { exact: true })
        .click();
      const install = page.getByRole("link", {
        name: "Add Autograph to Cursor",
      });
      await expect(install).toHaveCount(0);
      await expect(
        page.getByText("Cursor connection setup is not available", {
          exact: false,
        }),
      ).toBeVisible();
      const before = await page.request.get(handoff.statusPath);
      expect(before.ok()).toBe(true);
      expect((await before.json()).cursorInstallReady).toBe(false);
      await setupCursorClient(database, `${appOrigin}/mcp`);
      await expect(install).toBeVisible({ timeout: 15_000 });
      const installUrl = new URL((await install.getAttribute("href"))!);
      const config = JSON.parse(
        Buffer.from(installUrl.searchParams.get("config")!, "base64").toString(
          "utf8",
        ),
      );
      expect(Object.keys(config).sort()).toEqual(["auth", "url"]);
      expect(config.url).toBe(`${appOrigin}/mcp`);
      expect(Object.keys(config.auth)).toEqual(["CLIENT_ID"]);
      expect(config.auth.CLIENT_ID).toBe(cursorClientId);
    } finally {
      await database.transaction(async (tx) => {
        await tx
          .delete(schema.oauthClient)
          .where(eq(schema.oauthClient.clientId, cursorClientId));
        if (clientsBefore.length)
          await tx.insert(schema.oauthClient).values(clientsBefore);
        if (bindingsBefore.length)
          await tx.insert(schema.oauthClientResource).values(bindingsBefore);
      });
    }
  } finally {
    await sql.end();
  }
});

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

  const automaticallyOpened = await browserBoundaryState(page);
  expect(automaticallyOpened.clipboard).toEqual([]);
  expect(automaticallyOpened.opened).toHaveLength(1);
  expect(automaticallyOpened.opened[0]).toMatch(/^codex:\/\/new\?prompt=/u);

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
  expect(state.opened.at(-1)).toMatch(/^codex:\/\/new\?prompt=/u);
  expect(new URL(state.opened.at(-1)!).searchParams.get("prompt")).toBe(
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

  const automaticallyOpened = await browserBoundaryState(page);
  expect(automaticallyOpened).toEqual({
    clipboard: [],
    opened: [expect.stringMatching(/^cursor:\/\//u)],
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
  expect(state.opened.at(-1)).toMatch(
    /^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=/u,
  );
  expect(new URL(state.opened.at(-1)!).searchParams.get("text")).toBe(
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
