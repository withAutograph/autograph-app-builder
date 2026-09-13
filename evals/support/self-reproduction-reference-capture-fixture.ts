import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { expect } from "playwright/test";
import postgres from "postgres";
import { selfReproductionDraft } from "./self-reproduction-draft-fixture";

export interface ReferenceCaptureFixtureReceipt {
  status: "ready" | "blocked";
  state: "authenticated-durable-draft";
  referenceUrl: string;
  fixtureRoot: string;
  viewport: { width: number; height: number } | null;
  ownerDigest?: string;
  draftRevision?: number;
  draft: typeof selfReproductionDraft;
  reason: string;
}

/** Uses only the isolated reference's ordinary emulated OAuth and durable writes. */
export const prepareReferenceCaptureFixture = async (
  page: Page,
  input: {
    referenceUrl: string;
    fixtureRoot: string;
    recordReceipt: (receipt: ReferenceCaptureFixtureReceipt) => Promise<void>;
  },
) => {
  const receipt: ReferenceCaptureFixtureReceipt = {
    draft: selfReproductionDraft,
    fixtureRoot: input.fixtureRoot,
    reason: "Reference authentication and durable draft have not been established.",
    referenceUrl: input.referenceUrl,
    state: "authenticated-durable-draft",
    status: "blocked",
    viewport: page.viewportSize(),
  };
  try {
    // Import after the isolated runtime environment is installed by the eval entrypoint.
    const { appOrigin, currentSession, databaseUrl, finishOAuth, waitForBuilderReady } =
      await import("../../e2e/support/harness");
    if (new URL(input.referenceUrl).origin !== appOrigin)
      throw new Error("Reference capture origin does not match the isolated emulator fixture.");
    await finishOAuth(page, "GitHub");
    await waitForBuilderReady(page);
    const ownerId = (await currentSession(page))?.user?.id;
    if (typeof ownerId !== "string") throw new Error("Emulated OAuth did not establish an owner.");
    await page.getByLabel("App Name").fill(selfReproductionDraft.appName);
    await page.getByLabel("App Brief", { exact: true }).fill(selfReproductionDraft.brief);
    await page.getByRole("status").filter({ hasText: "Draft saved" }).waitFor();
    const sql = postgres(databaseUrl, { max: 1 });
    let draftRevision: number | undefined;
    try {
      await expect
        .poll(
          async () => {
            const [row] = await sql<{ appName: string; brief: string; revision: number }[]>`
          SELECT record->'draft'->'form'->>'appName' AS "appName",
                 record->'draft'->'form'->>'brief' AS brief, revision
          FROM builder_draft WHERE owner_user_id = ${ownerId} AND status = 'active'
          ORDER BY updated_at DESC LIMIT 1
        `;
            draftRevision = row?.revision;
            return (
              row?.appName === selfReproductionDraft.appName &&
              row?.brief === selfReproductionDraft.brief
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await sql.end();
    }
    await input.recordReceipt({
      ...receipt,
      draftRevision,
      ownerDigest: createHash("sha256").update(ownerId).digest("hex"),
      reason:
        "Normal emulated OAuth established the owner; both UI-written draft fields matched its PostgreSQL row before capture. Candidate authentication parity remains separately assessed.",
      status: "ready",
    });
  } catch {
    await input.recordReceipt({
      ...receipt,
      reason:
        "Reference authenticated draft preparation failed; anonymous capture was not substituted.",
    });
    throw new Error("Reference authenticated draft capture fixture is unavailable.");
  }
};
