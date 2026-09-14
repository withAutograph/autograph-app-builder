import { readFile } from "node:fs/promises";
import path from "node:path";
import { encryptOverrides } from "flags";
import { expect } from "playwright/test";
import postgres from "postgres";
import type { Locator } from "playwright";

import {
  appOrigin,
  currentSession,
  signOut,
  registerPasskey,
  applicationCounts,
  databaseUrl,
  finishOAuth,
  installProvider,
  openProviderConnection,
  advanceProviderConnectionToApproval,
  resetApplicationState,
  waitForBuilderReady,
} from "../../e2e/support/harness";
import { workflowMatrix } from "../support/self-reproduction-parity";
import type {
  AssertionResult,
  TrustedBrowserWorkflowAdapter,
  WorkflowId,
} from "../support/self-reproduction-workflow-adapters";

export interface WorkflowAdapterFactoryInput {
  referenceUrl?: string;
  referenceFixtureRoot?: string;
  candidateUrl?: string;
  outputRoot: string;
}

const fixedName = "Self reproduction parity draft";
const fixedBrief = "Create one small independent issue tracker with durable server persistence.";

const assertion = (id: string, passed: boolean, detail: string): AssertionResult => ({
  detail,
  id,
  passed,
});

const requiredAssertions = (workflowId: WorkflowId) =>
  workflowMatrix.find((workflow) => workflow.id === workflowId)?.assertions ?? [];

const unsupported = (workflowId: WorkflowId, detail: string) => ({
  assertions: requiredAssertions(workflowId).map((id) => assertion(id, false, detail)),
  reason: detail,
});

const firstVisible = (locators: Locator[]) => {
  const find = async (index: number): Promise<Locator | undefined> => {
    const locator = locators[index];
    if (locator === undefined) {
      return;
    }
    if (await locator.first().isVisible().catch(() => false)) {
      return locator.first();
    }
    return find(index + 1);
  };
  return find(0);
};

const semanticCandidateAdapter = (candidateUrl: string): TrustedBrowserWorkflowAdapter => {
  const entryUrl = new URL(candidateUrl).href;
  return {
    contextOptions: { baseURL: entryUrl },
    async exercise(page, workflowId) {
      const docs = await firstVisible([
        page.getByRole("link", { name: /docs|documentation/iu }),
        page.getByRole("button", { name: /docs|documentation/iu }),
      ]);
      if (!docs)
        {return unsupported(workflowId, "Candidate exposes no semantic documentation control.");}
      const initialUrl = page.url();
      const initialContent = await page.locator("body").textContent();
      await docs.click();
      const content = page.locator("main, article").first();
      const readable =
        (await content.isVisible().catch(() => false)) &&
        ((await content.textContent()) ?? "").trim().length > 0 &&
        (await page.locator("body").textContent()) !== initialContent;
      const navigated = page.url() !== initialUrl;
      if (navigated) {await page.goBack();}
      return {
        assertions: [
          assertion(
            "docs-readable",
            readable,
            "Documentation activation must reveal distinct readable content.",
          ),
          assertion(
            "return-navigation-works",
            navigated &&
              page.url() === initialUrl &&
              (await page.locator("body").textContent()) === initialContent,
            "Browser back must restore the original application URL and content.",
          ),
        ],
        reason:
          "Evaluator activated documentation, checked changed readable content, and exercised browser return navigation.",
      };
    },
    async prepare(page, workflowId) {
      if (workflowId !== "documentation")
        {return {
          disposition: "not-run",
          ready: false,
          reason: `The checked-in candidate adapter has no authenticated fixture and server readback binding for ${workflowId}.`,
        };}
      const response = await page.goto(entryUrl);
      if (!response?.ok())
        {return {
          disposition: "infrastructure-unavailable",
          ready: false,
          reason: `Candidate runtime did not answer at ${entryUrl}.`,
        };}
      return { ready: true };
    },
    // oxlint-disable-next-line eslint/require-await -- adapter contract is uniformly asynchronous
    async verify() {
      return {
        assertions: [],
        reason: "Documentation assertions use evaluator-observed browser outcomes.",
      };
    },
  };
};

const referenceAdapter = (
  referenceUrl: string,
  fixtureRoot = process.cwd(),
): TrustedBrowserWorkflowAdapter => {
  const supported = new Set<WorkflowId>([
    "authentication",
    "durable-draft",
    "provider-return-success",
    "provider-return-error",
    "documentation",
  ]);
  let initialDraftRevision = 0;
  let passkeyOverride = "";
  return {
    contextOptions: { baseURL: referenceUrl, ignoreHTTPSErrors: true },
    async exercise(page, workflowId, freshPage) {
      if (workflowId === "documentation") {
        await page.goto("/docs");
        const readable = await page.locator("main, article").first().isVisible();
        await page.goto("/");
        return {
          assertions: [
            assertion(
              "docs-readable",
              readable,
              "The public docs rendered a main or article region.",
            ),
            assertion(
              "return-navigation-works",
              await page.getByLabel("What should this app do?").isVisible(),
              "The public builder rendered after returning.",
            ),
          ],
          reason: "Evaluator opened the public documentation route and returned to the builder.",
        };
      }
      await finishOAuth(page, "GitHub");
      await page.goto("/");
      await waitForBuilderReady(page);
      await page.getByLabel("App Name").fill(fixedName);
      await page.getByLabel("App Brief", { exact: true }).fill(fixedBrief);
      await page.getByRole("status").filter({ hasText: "Draft saved" }).waitFor();
      if (workflowId === "authentication") {
        const ownerSession = await currentSession(page);
        const ownerId = ownerSession?.user?.id;
        if (typeof ownerId !== "string")
          {throw new TypeError("Reference OAuth did not establish an owner identity.");}
        const sql = postgres(databaseUrl, { max: 1 });
        let persisted = false;
        try {
          const [row] = await sql<{ appName: string; brief: string }[]>`
            SELECT record->'draft'->'form'->>'appName' AS "appName",
                   record->'draft'->'form'->>'brief' AS brief
            FROM builder_draft WHERE owner_user_id = ${ownerId} AND status = 'active'
            ORDER BY updated_at DESC LIMIT 1
          `;
          persisted = row?.appName === fixedName && row?.brief === fixedBrief;
        } finally {
          await sql.end();
        }
        await signOut(page);
        const revoked = (await currentSession(page)) === null;
        const restored = await freshPage();
        await finishOAuth(restored, "GitHub");
        await waitForBuilderReady(restored);
        const restoredSession = await currentSession(restored);
        const restoredName = await restored.getByLabel("App Name").inputValue();
        const restoredBrief = await restored.getByLabel("App Brief", { exact: true }).inputValue();
        const restoredDraft =
          persisted &&
          restoredSession?.user?.id === ownerId &&
          restoredName === fixedName &&
          restoredBrief === fixedBrief;
        await restored.getByRole("radio", { exact: true, name: "ChatGPT / Codex" }).check();
        await restored.getByRole("button", { exact: true, name: "Create App" }).click();
        await expect(restored).toHaveURL(/\/handoff\/[0-9a-f-]{36}$/u);
        const handoffId = new URL(restored.url()).pathname.split("/").at(-1);
        const statusPath = `/api/builder/handoffs/${handoffId}`;
        const ownerResponse = await restored.request.get(statusPath);
        const ownerBody = await ownerResponse.json();
        const ownerCanRead = ownerResponse.ok() && ownerBody.status === "prepared";
        const signedOutResponse = await page.request.get(statusPath);
        const stranger = await freshPage();
        await stranger.context().addCookies([
          {
            httpOnly: true,
            name: "vercel-flag-overrides",
            sameSite: "Lax",
            secure: new URL(referenceUrl).protocol === "https:",
            url: referenceUrl,
            value: passkeyOverride,
          },
        ]);
        const authenticator = await registerPasskey(stranger.context(), stranger);
        let otherUserDenied = false;
        try {
          const strangerSession = await currentSession(stranger);
          const strangerId = strangerSession?.user?.id;
          const response = await stranger.request.get(statusPath);
          const body = await response.json();
          otherUserDenied =
            ownerCanRead &&
            typeof strangerId === "string" &&
            strangerId !== ownerId &&
            response.status() === 404 &&
            body.error === "handoff_unavailable" &&
            Object.keys(body).length === 1;
        } finally {
          await authenticator.dispose();
        }
        return {
          assertions: [
            assertion(
              "sign-in-restores-draft",
              restoredDraft,
              "Both saved draft fields were restored for the same owner in a fresh authenticated context.",
            ),
            assertion(
              "sign-out-revokes-access",
              revoked && signedOutResponse.status() === 401,
              "Signed-out session was absent and protected handoff access returned 401.",
            ),
            assertion(
              "other-user-denied",
              otherUserDenied,
              "A distinct authenticated passkey user received only handoff_unavailable while the owner could read the prepared handoff.",
            ),
          ],
          reason:
            "Saved an owner-scoped PostgreSQL draft, restored it through fresh OAuth, and checked the owner's prepared handoff with signed-out and distinct authenticated identities.",
        };
      }
      if (workflowId === "provider-return-error") {
        await openProviderConnection(page, "GitHub");
        await advanceProviderConnectionToApproval(page, "GitHub");
        await page.getByRole("button", { exact: true, name: "Connect emulated GitHub" }).click();
        await expect(page).toHaveURL(/\/local-connections\/github\?.*phase=authorize/u);
        const state = new URL(page.url()).searchParams.get("state");
        if (!state) {throw new Error("Emulated GitHub authorization did not retain callback state.");}
        const callback = new URL("/github/installations/callback", referenceUrl);
        callback.searchParams.set("state", state);
        callback.searchParams.set("error", "access_denied");
        await page.goto(callback.href);
        await expect(page).toHaveURL(/github=failed/u);
        await waitForBuilderReady(page);
        const errorVisible = await page
          .getByText(
            /GitHub.*could not|could not.*GitHub|GitHub.*failed|GitHub.*invalid|GitHub.*expired/iu,
          )
          .first()
          .isVisible();
        const preserved =
          (await page.getByLabel("App Name").inputValue()) === fixedName &&
          (await page.getByLabel("App Brief", { exact: true }).inputValue()) === fixedBrief;
        await page.goto(callback.href);
        await expect(page).toHaveURL(/github=failed/u);
        const counts = await applicationCounts();
        const rejected =
          new URL(page.url()).searchParams.get("github") === "failed" &&
          counts.githubInstallations === 0;
        return {
          assertions: [
            assertion(
              "error-visible",
              errorVisible,
              "The application rendered provider failure feedback after denial.",
            ),
            assertion(
              "draft-preserved",
              preserved,
              "The acknowledged draft fields survived the denied callback.",
            ),
            assertion(
              "replayed-state-rejected",
              rejected,
              "Replayed callback returned failure and created no GitHub binding.",
            ),
          ],
          reason:
            "Returned a denial using actual pending emulated OAuth state, then replayed the consumed callback through the application.",
        };
      }
      if (workflowId === "provider-return-success") {
        await installProvider(page, "GitHub");
        return {
          assertions: [
            assertion(
              "callback-consumed",
              /connected successfully/u.test((await page.locator("body").textContent()) ?? ""),
              "The app rendered its successful callback outcome.",
            ),
            assertion(
              "draft-preserved",
              (await page.getByLabel("App Name").inputValue()) === fixedName,
              "The draft survived provider return.",
            ),
          ],
          reason: "Evaluator completed the real emulated GitHub callback through the application.",
        };
      }
      await page.reload();
      await waitForBuilderReady(page);
      const fresh = await freshPage();
      await finishOAuth(fresh, "GitHub");
      await fresh.goto("/");
      await waitForBuilderReady(fresh);
      return {
        assertions: [
          assertion(
            "write-acknowledged",
            (await page.getByLabel("App Name").inputValue()) === fixedName,
            "The acknowledged value survived reload.",
          ),
          assertion(
            "fresh-context-read-matches",
            (await fresh.getByLabel("App Name").inputValue()) === fixedName,
            "A fresh authenticated context read the same server-owned draft.",
          ),
        ],
        reason:
          "Evaluator waited for the Server Action acknowledgement, reloaded, and read the draft in a fresh authenticated context.",
      };
    },
    async prepare(_page, workflowId) {
      if (!supported.has(workflowId))
        {return {
          disposition: "not-run",
          ready: false,
          reason: `The checked-in reference adapter has no bounded real fixture for ${workflowId}.`,
        };}
      if (new URL(referenceUrl).origin !== appOrigin)
        {return {
          disposition: "infrastructure-unavailable",
          ready: false,
          reason: `Reference E2E helpers are bound to ${appOrigin}; received ${referenceUrl}.`,
        };}
      if (workflowId === "authentication") {
        try {
          const secretContents = await readFile(
            path.join(fixtureRoot, ".emulate/flags-secret"),
            "utf-8",
          );
          const secret = secretContents.trim();
          passkeyOverride = await encryptOverrides({ passkeys: true }, secret, "1h");
        } catch {
          return {
            disposition: "infrastructure-unavailable",
            ready: false,
            reason: "Reference authentication requires the emulated passkey flag fixture secret.",
          };
        }
      }
      await resetApplicationState();
      initialDraftRevision = 0;
      return { ready: true };
    },
    async verify(workflowId) {
      if (workflowId === "provider-return-success") {
        const counts = await applicationCounts();
        return {
          assertions: [
            assertion(
              "connection-persisted",
              counts.githubInstallations === 1,
              `Database reported ${counts.githubInstallations} GitHub binding(s).`,
            ),
          ],
          reason: "Evaluator read the reference database after callback completion.",
        };
      }
      if (workflowId === "durable-draft") {
        const sql = postgres(databaseUrl, { max: 1 });
        try {
          const [row] = await sql<{ revision: number; appName: string }[]>`
            SELECT revision, record->'draft'->'form'->>'appName' AS "appName"
            FROM builder_draft WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1
          `;
          return {
            assertions: [
              assertion(
                "revision-advanced",
                Boolean(row && row.revision > initialDraftRevision && row.appName === fixedName),
                row
                  ? `PostgreSQL revision ${row.revision} contains the fixed app name.`
                  : "No active durable draft row was found.",
              ),
            ],
            reason: "Evaluator read the durable draft row directly from PostgreSQL.",
          };
        } finally {
          await sql.end();
        }
      }
      return { assertions: [], reason: "The exercised assertions fully cover this workflow." };
    },
  };
};

export const createWorkflowAdapters = (
  input: WorkflowAdapterFactoryInput,
): Partial<Record<"reference" | "candidate", TrustedBrowserWorkflowAdapter>> => ({
  ...(input.referenceUrl
    ? { reference: referenceAdapter(input.referenceUrl, input.referenceFixtureRoot) }
    : {}),
  ...(input.candidateUrl ? { candidate: semanticCandidateAdapter(input.candidateUrl) } : {}),
});
