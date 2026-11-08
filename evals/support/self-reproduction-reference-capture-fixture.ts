import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";
import { expect } from "playwright/test";
import postgres from "postgres";
import { selfReproductionDraft } from "./self-reproduction-draft-fixture";

const sessionUserId = (session: unknown): string | undefined => {
  if (session === null || typeof session !== "object" || !("user" in session)) {
    return undefined;
  }
  const { user } = session;
  if (user === null || typeof user !== "object" || !("id" in user)) {
    return undefined;
  }
  const { id } = user;
  return typeof id === "string" ? id : undefined;
};

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

interface ReferenceCapturePage {
  viewportSize: Page["viewportSize"];
  getByLabel: (name: string, options?: { exact?: boolean }) => Pick<Locator, "inputValue" | "fill">;
}

interface ReferenceCaptureHarness<TPage> {
  appOrigin: string;
  currentSession: (page: TPage) => Promise<unknown>;
  databaseUrl: string;
  finishOAuth: (page: TPage, provider: "GitHub") => Promise<unknown>;
  waitForBuilderReady: (page: TPage) => Promise<unknown>;
}

interface ReferenceCaptureInput {
  referenceUrl: string;
  fixtureRoot: string;
  recordReceipt: (receipt: ReferenceCaptureFixtureReceipt) => Promise<void>;
}

/** Uses only the isolated reference's ordinary emulated OAuth and durable writes. */
export const createReferenceCaptureFixture =
  <TPage extends ReferenceCapturePage>(
    loadHarness: () => Promise<ReferenceCaptureHarness<TPage>>,
  ) =>
  async (page: TPage, input: ReferenceCaptureInput) => {
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
        await loadHarness();
      if (new URL(input.referenceUrl).origin !== appOrigin) {
        throw new Error("Reference capture origin does not match the isolated emulator fixture.");
      }
      receipt.stage = "authentication";
      await finishOAuth(page, "GitHub");
      receipt.stage = "builder-readiness";
      await waitForBuilderReady(page);
      const session = await currentSession(page);
      const ownerId = sessionUserId(session);
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

const prepareDefaultReferenceCapture = createReferenceCaptureFixture<Page>(
  () => import("../../e2e/support/harness"),
);

export const prepareReferenceCaptureFixture = (
  ...args:
    | [page: Page, input: ReferenceCaptureInput]
    | [
        page: ReferenceCapturePage,
        input: ReferenceCaptureInput,
        loadHarness: () => Promise<ReferenceCaptureHarness<ReferenceCapturePage>>,
      ]
) => {
  if (args.length === 3) {
    return createReferenceCaptureFixture(args[2])(args[0], args[1]);
  }
  return prepareDefaultReferenceCapture(args[0], args[1]);
};
