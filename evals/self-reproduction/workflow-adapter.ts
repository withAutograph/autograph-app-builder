import { join } from "node:path";
import { readFile } from "node:fs/promises";
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

function assertion(id: string, passed: boolean, detail: string): AssertionResult {
  return { id, passed, detail };
}

function requiredAssertions(workflowId: WorkflowId) {
  return workflowMatrix.find((workflow) => workflow.id === workflowId)?.assertions ?? [];
}

function unsupported(workflowId: WorkflowId, detail: string) {
  return {
    reason: detail,
    assertions: requiredAssertions(workflowId).map((id) => assertion(id, false, detail)),
  };
}

async function firstVisible(locators: Locator[]) {
  for (const locator of locators)
    if (
      await locator
        .first()
        .isVisible()
        .catch(() => false)
    )
      return locator.first();
  return undefined;
}

function semanticCandidateAdapter(candidateUrl: string): TrustedBrowserWorkflowAdapter {
  const entryUrl = new URL(candidateUrl).href;
  return {
    contextOptions: { baseURL: entryUrl },
    async prepare(page, workflowId) {
      if (workflowId !== "documentation")
        return {
          ready: false,
          disposition: "not-run",
          reason: `The checked-in candidate adapter has no authenticated fixture and server readback binding for ${workflowId}.`,
        };
      const response = await page.goto(entryUrl);
      if (!response?.ok())
        return {
          ready: false,
          disposition: "infrastructure-unavailable",
          reason: `Candidate runtime did not answer at ${entryUrl}.`,
        };
      return { ready: true };
    },
    async exercise(page, workflowId) {
      const docs = await firstVisible([
        page.getByRole("link", { name: /docs|documentation/iu }),
        page.getByRole("button", { name: /docs|documentation/iu }),
      ]);
      if (!docs)
        return unsupported(workflowId, "Candidate exposes no semantic documentation control.");
      const initialUrl = page.url();
      const initialContent = await page.locator("body").textContent();
      await docs.click();
      const content = page.locator("main, article").first();
      const readable =
        (await content.isVisible().catch(() => false)) &&
        ((await content.textContent()) ?? "").trim().length > 0 &&
        (await page.locator("body").textContent()) !== initialContent;
      const navigated = page.url() !== initialUrl;
      if (navigated) await page.goBack();
      return {
        reason:
          "Evaluator activated documentation, checked changed readable content, and exercised browser return navigation.",
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
      };
    },
    // oxlint-disable-next-line eslint/require-await -- adapter contract is uniformly asynchronous
    async verify() {
      return {
        reason: "Documentation assertions use evaluator-observed browser outcomes.",
        assertions: [],
      };
    },
  };
}

function referenceAdapter(
  referenceUrl: string,
  fixtureRoot = process.cwd(),
): TrustedBrowserWorkflowAdapter {
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
    async prepare(_page, workflowId) {
      if (!supported.has(workflowId))
        return {
          ready: false,
          disposition: "not-run",
          reason: `The checked-in reference adapter has no bounded real fixture for ${workflowId}.`,
        };
      if (new URL(referenceUrl).origin !== appOrigin)
        return {
          ready: false,
          disposition: "infrastructure-unavailable",
          reason: `Reference E2E helpers are bound to ${appOrigin}; received ${referenceUrl}.`,
        };
      if (workflowId === "authentication") {
        try {
          const secret = (
            await readFile(join(fixtureRoot, ".emulate/flags-secret"), "utf-8")
          ).trim();
          passkeyOverride = await encryptOverrides({ passkeys: true }, secret, "1h");
        } catch {
          return {
            ready: false,
            disposition: "infrastructure-unavailable",
            reason: "Reference authentication requires the emulated passkey flag fixture secret.",
          };
        }
      }
      await resetApplicationState();
      initialDraftRevision = 0;
      return { ready: true };
    },
    async exercise(page, workflowId, freshPage) {
      if (workflowId === "documentation") {
        await page.goto("/docs");
        const readable = await page.locator("main, article").first().isVisible();
        await page.goto("/");
        return {
          reason: "Evaluator opened the public documentation route and returned to the builder.",
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
        };
      }
      await finishOAuth(page, "GitHub");
      await page.goto("/");
      await waitForBuilderReady(page);
      await page.getByLabel("App Name").fill(fixedName);
      await page.getByLabel("App Brief", { exact: true }).fill(fixedBrief);
      await page.getByRole("status").filter({ hasText: "Draft saved" }).waitFor();
      if (workflowId === "authentication") {
        const ownerId = (await currentSession(page))?.user?.id;
        if (typeof ownerId !== "string")
          throw new Error("Reference OAuth did not establish an owner identity.");
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
        const restoredDraft =
          persisted &&
          (await currentSession(restored))?.user?.id === ownerId &&
          (await restored.getByLabel("App Name").inputValue()) === fixedName &&
          (await restored.getByLabel("App Brief", { exact: true }).inputValue()) === fixedBrief;
        await restored.getByRole("radio", { name: "ChatGPT / Codex", exact: true }).check();
        await restored.getByRole("button", { name: "Create App", exact: true }).click();
        await expect(restored).toHaveURL(/\/handoff\/[0-9a-f-]{36}$/u);
        const handoffId = new URL(restored.url()).pathname.split("/").at(-1);
        const statusPath = `/api/builder/handoffs/${handoffId}`;
        const ownerResponse = await restored.request.get(statusPath);
        const ownerCanRead =
          ownerResponse.ok() && (await ownerResponse.json()).status === "prepared";
        const signedOutResponse = await page.request.get(statusPath);
        const stranger = await freshPage();
        await stranger.context().addCookies([
          {
            name: "vercel-flag-overrides",
            value: passkeyOverride,
            url: referenceUrl,
            httpOnly: true,
            secure: new URL(referenceUrl).protocol === "https:",
            sameSite: "Lax",
          },
        ]);
        const authenticator = await registerPasskey(stranger.context(), stranger);
        let otherUserDenied = false;
        try {
          const strangerId = (await currentSession(stranger))?.user?.id;
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
          reason:
            "Saved an owner-scoped PostgreSQL draft, restored it through fresh OAuth, and checked the owner's prepared handoff with signed-out and distinct authenticated identities.",
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
        };
      }
      if (workflowId === "provider-return-error") {
        await openProviderConnection(page, "GitHub");
        await advanceProviderConnectionToApproval(page, "GitHub");
        await page.getByRole("button", { name: "Connect emulated GitHub", exact: true }).click();
        await expect(page).toHaveURL(/\/local-connections\/github\?.*phase=authorize/u);
        const state = new URL(page.url()).searchParams.get("state");
        if (!state) throw new Error("Emulated GitHub authorization did not retain callback state.");
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
        const rejected =
          new URL(page.url()).searchParams.get("github") === "failed" &&
          (await applicationCounts()).githubInstallations === 0;
        return {
          reason:
            "Returned a denial using actual pending emulated OAuth state, then replayed the consumed callback through the application.",
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
        };
      }
      if (workflowId === "provider-return-success") {
        await installProvider(page, "GitHub");
        return {
          reason: "Evaluator completed the real emulated GitHub callback through the application.",
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
        };
      }
      await page.reload();
      await waitForBuilderReady(page);
      const fresh = await freshPage();
      await finishOAuth(fresh, "GitHub");
      await fresh.goto("/");
      await waitForBuilderReady(fresh);
      return {
        reason:
          "Evaluator waited for the Server Action acknowledgement, reloaded, and read the draft in a fresh authenticated context.",
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
      };
    },
    async verify(workflowId) {
      if (workflowId === "provider-return-success") {
        const counts = await applicationCounts();
        return {
          reason: "Evaluator read the reference database after callback completion.",
          assertions: [
            assertion(
              "connection-persisted",
              counts.githubInstallations === 1,
              `Database reported ${counts.githubInstallations} GitHub binding(s).`,
            ),
          ],
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
            reason: "Evaluator read the durable draft row directly from PostgreSQL.",
            assertions: [
              assertion(
                "revision-advanced",
                Boolean(row && row.revision > initialDraftRevision && row.appName === fixedName),
                row
                  ? `PostgreSQL revision ${row.revision} contains the fixed app name.`
                  : "No active durable draft row was found.",
              ),
            ],
          };
        } finally {
          await sql.end();
        }
      }
      return { reason: "The exercised assertions fully cover this workflow.", assertions: [] };
    },
  };
}

export function createWorkflowAdapters(
  input: WorkflowAdapterFactoryInput,
): Partial<Record<"reference" | "candidate", TrustedBrowserWorkflowAdapter>> {
  return {
    ...(input.referenceUrl
      ? { reference: referenceAdapter(input.referenceUrl, input.referenceFixtureRoot) }
      : {}),
    ...(input.candidateUrl ? { candidate: semanticCandidateAdapter(input.candidateUrl) } : {}),
  };
}
