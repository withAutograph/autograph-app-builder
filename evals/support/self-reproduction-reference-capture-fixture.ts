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
  stage: string;
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
    stage: "fixture-binding",
    state: "authenticated-durable-draft",
    status: "blocked",
    viewport: page.viewportSize(),
  };
  try {
    // Import after the isolated runtime environment is installed by the eval entrypoint.
    const { appOrigin, currentSession, databaseUrl, finishOAuth, waitForBuilderReady } =
      await import("../../e2e/support/harness");
    if (new URL(input.referenceUrl).origin !== appOrigin) {
      throw new Error("Reference capture origin does not match the isolated emulator fixture.");
    }
    receipt.stage = "authentication";
    await finishOAuth(page, "GitHub");
    receipt.stage = "builder-readiness";
    await waitForBuilderReady(page);
    const session = await currentSession(page);
    const ownerId = session?.user?.id;
    if (typeof ownerId !== "string") {
      throw new TypeError("Emulated OAuth did not establish an owner.");
    }
    receipt.stage = "draft-inputs";
    const appName = page.getByLabel("App Name");
    const brief = page.getByLabel("App Brief", { exact: true });
    if ((await appName.inputValue()) !== selfReproductionDraft.appName) {
      await appName.fill(selfReproductionDraft.appName);
    }
    if ((await brief.inputValue()) !== selfReproductionDraft.brief) {
      await brief.fill(selfReproductionDraft.brief);
    }
    // Restored unchanged drafts need no new write acknowledgement. Read both UI and server state.
    receipt.stage = "durable-readback";
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
              (await appName.inputValue()) === selfReproductionDraft.appName &&
              (await brief.inputValue()) === selfReproductionDraft.brief &&
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
        "Normal emulated OAuth established the owner; both visible draft fields matched its PostgreSQL row before capture. Candidate authentication parity remains separately assessed.",
      stage: "complete",
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
