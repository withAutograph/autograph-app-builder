import postgres from "postgres";
import { expect, test } from "playwright/test";

import { VirtualAuthenticator } from "../auth/virtual-authenticator";
import {
  appOrigin,
  applicationCounts,
  databaseUrl,
  finishOAuth,
  registerPasskey,
  resetApplicationState,
} from "../support/harness";

test.beforeEach(async () => resetApplicationState());

test("stock account menu updates the profile and signs out", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/account/u, { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Account settings" }),
  ).toBeVisible();

  await page.getByLabel("Name").fill("Autograph E2E User");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Profile updated/u)).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await expect(page.getByText("Autograph E2E User")).toBeVisible();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in/u);
});

test("passkeys are added, renamed, and protected through stock settings UI", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  let authenticator: VirtualAuthenticator | undefined = await registerPasskey(
    context,
    page,
  );
  try {
    await page.goto("/settings/account");
    await page.getByRole("button", { name: "Rename passkey" }).click();
    const renameDialog = page.getByRole("dialog");
    await renameDialog.getByLabel("Name").fill("Primary passkey");
    await renameDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Primary passkey")).toBeVisible();

    await authenticator.dispose();
    authenticator = await VirtualAuthenticator.create(context, page);
    await page.getByRole("button", { name: "Add passkey" }).first().click();
    const addDialog = page.getByRole("dialog");
    await addDialog.getByLabel("Name").fill("Backup passkey");
    await addDialog.getByRole("button", { name: "Add passkey" }).click();
    await expect(page.getByText("Backup passkey")).toBeVisible();
    await expect.poll(async () => (await applicationCounts()).passkeys).toBe(2);

    await page
      .getByRole("button", { name: "Delete passkey Primary passkey" })
      .click();
    const deleteDialog = page.getByRole("alertdialog");
    await deleteDialog.getByRole("button", { name: "Delete passkey" }).click();
    await expect(page.getByText("Primary passkey")).toHaveCount(0);
    await expect.poll(async () => (await applicationCounts()).passkeys).toBe(1);

    await page
      .getByRole("button", { name: "Delete passkey Backup passkey" })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete passkey" })
      .click();
    await expect(
      page.getByText("Add another passkey before deleting this one."),
    ).toBeVisible();
    await expect.poll(async () => (await applicationCounts()).passkeys).toBe(1);
  } finally {
    if (!page.isClosed()) await authenticator?.dispose();
  }
});

test("ambiguous and revoked workspace authority show recovery surfaces", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [{ id: userId }] = await sql<
      Array<{ id: string }>
    >`SELECT id FROM "user"`;
    await sql`
      INSERT INTO organization
        (id, name, slug, created_at, issuer, audience, workspace_id)
      VALUES
        ('e2e-second-org', 'Second workspace', 'e2e-second-workspace', now(),
         ${`${appOrigin}/api/auth`}, ${`${appOrigin}/mcp`},
         'e2e-second-workspace')
    `;
    await sql`
      INSERT INTO member (id, organization_id, user_id, role, created_at)
      VALUES ('e2e-second-member', 'e2e-second-org', ${userId}, 'owner', now())
    `;
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Choose your Autograph workspace" }),
    ).toBeVisible();

    await sql`DELETE FROM member WHERE id = 'e2e-second-member'`;
    await sql`DELETE FROM organization WHERE id = 'e2e-second-org'`;
    await sql`UPDATE "user" SET banned = true WHERE id = ${userId}`;
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Your workspace isn’t available" }),
    ).toBeVisible();
  } finally {
    await sql.end();
  }
});
