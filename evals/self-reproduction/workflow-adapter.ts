import postgres from "postgres";
import type { Locator } from "playwright";

import {
  appOrigin,
  applicationCounts,
  currentSession,
  databaseUrl,
  finishOAuth,
  installProvider,
  resetApplicationState,
  signOut,
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
  const state = new Map<WorkflowId, { value?: string; exercised?: boolean }>();
  return {
    contextOptions: { baseURL: candidateUrl },
    async prepare(page, workflowId) {
      await page.goto("/");
      const response = await page.request.get("/").catch(() => undefined);
      if (!response?.ok())
        return {
          ready: false,
          disposition: "infrastructure-unavailable",
          reason: `Candidate runtime did not answer at ${candidateUrl}.`,
        };
      state.set(workflowId, {});
      return { ready: true };
    },
    async exercise(page, workflowId, freshPage) {
      if (workflowId === "documentation") {
        const docs = await firstVisible([
          page.getByRole("link", { name: /docs|documentation/u }),
          page.getByRole("button", { name: /docs|documentation/u }),
        ]);
        if (!docs)
          return unsupported(workflowId, "Candidate exposes no semantic documentation control.");
        await docs.click();
        const readable = await page
          .locator("main, article")
          .first()
          .isVisible()
          .catch(() => false);
        await page.goBack();
        return {
          reason: "Evaluator navigated the candidate documentation control and returned.",
          assertions: [
            assertion(
              "docs-readable",
              readable,
              "A visible main or article region was required after navigation.",
            ),
            assertion(
              "return-navigation-works",
              await page.locator("body").isVisible(),
              "Browser back returned to rendered content.",
            ),
          ],
        };
      }
      if (workflowId === "durable-draft") {
        const name = await firstVisible([
          page.getByLabel(/app name/u),
          page.getByPlaceholder(/app name/u),
        ]);
        const brief = await firstVisible([
          page.getByLabel(/app brief|what should this app do/u),
          page.getByPlaceholder(/describe|brief/u),
        ]);
        if (!name || !brief)
          return unsupported(
            workflowId,
            "Candidate exposes no semantic app-name and app-brief controls.",
          );
        await name.fill(fixedName);
        await brief.fill(fixedBrief);
        await page.waitForTimeout(750);
        await page.reload();
        const reloadMatches = (await name.inputValue().catch(() => "")) === fixedName;
        const fresh = await freshPage();
        await fresh.goto("/");
        const freshName = await firstVisible([
          fresh.getByLabel(/app name/u),
          fresh.getByPlaceholder(/app name/u),
        ]);
        const freshMatches = (await freshName?.inputValue().catch(() => "")) === fixedName;
        state.set(workflowId, { value: fixedName, exercised: true });
        return {
          reason:
            "Evaluator edited semantic draft fields and checked reload plus an isolated browser context.",
          assertions: [
            assertion("write-acknowledged", reloadMatches, "The edit survived a reload."),
            assertion(
              "fresh-context-read-matches",
              freshMatches,
              "The edit was read in a cookie-free browser context.",
            ),
          ],
        };
      }
      const labels: Partial<Record<WorkflowId, RegExp>> = {
        authentication: /sign in|log in|continue with/u,
        "provider-return-success": /connect.*github|connect.*vercel|provider/u,
        "provider-return-error": /connect.*github|connect.*vercel|provider/u,
        "app-creation": /create app|build app|generate/u,
        "preview-access": /preview|open app/u,
        cancellation: /cancel|stop/u,
        retry: /retry|try again/u,
        "session-recovery": /resume|recover|continue/u,
        "independent-child": /create app|build app|generate/u,
      };
      const label = labels[workflowId];
      const control = label
        ? await firstVisible([
            page.getByRole("button", { name: label }),
            page.getByRole("link", { name: label }),
          ])
        : undefined;
      if (!control)
        return unsupported(workflowId, `Candidate exposes no semantic control for ${workflowId}.`);
      await control.click().catch(() => undefined);
      state.set(workflowId, { exercised: true });
      return unsupported(
        workflowId,
        `A ${workflowId} control responded, but the candidate exposes no evaluator-owned fixture/readback contract for durable verification.`,
      );
    },
    // oxlint-disable-next-line eslint/require-await -- adapter contract is uniformly asynchronous
    async verify(workflowId) {
      if (workflowId === "durable-draft")
        return {
          reason: "No candidate server readback contract was available.",
          assertions: [
            assertion(
              "revision-advanced",
              false,
              "Browser storage is insufficient proof of a durable server revision.",
            ),
          ],
        };
      return {
        reason: "Candidate verification was limited to evaluator-observed semantics.",
        assertions: [],
      };
    },
  };
}

function referenceAdapter(referenceUrl: string): TrustedBrowserWorkflowAdapter {
  const supported = new Set<WorkflowId>([
    "authentication",
    "durable-draft",
    "provider-return-success",
    "documentation",
  ]);
  let initialDraftRevision = 0;
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
      if (workflowId === "authentication") {
        const signedIn = Boolean(await currentSession(page));
        await signOut(page);
        const revoked = (await currentSession(page)) === null;
        const fresh = await freshPage();
        await fresh.goto("/");
        const isolated = (await currentSession(fresh)) === null;
        return {
          reason:
            "Evaluator used the real emulated OAuth flow, sign-out route, and an isolated browser context.",
          assertions: [
            assertion("sign-in-restores-draft", signedIn, "The real auth session was established."),
            assertion(
              "sign-out-revokes-access",
              revoked,
              "The session endpoint returned no session after sign-out.",
            ),
            assertion(
              "other-user-denied",
              isolated,
              "A cookie-free browser context had no authenticated session.",
            ),
          ],
        };
      }
      await page.getByLabel("App Name").fill(fixedName);
      await page.getByLabel("App Brief", { exact: true }).fill(fixedBrief);
      await page.getByRole("status").filter({ hasText: "Draft saved" }).waitFor();
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
    ...(input.referenceUrl ? { reference: referenceAdapter(input.referenceUrl) } : {}),
    ...(input.candidateUrl ? { candidate: semanticCandidateAdapter(input.candidateUrl) } : {}),
  };
}
