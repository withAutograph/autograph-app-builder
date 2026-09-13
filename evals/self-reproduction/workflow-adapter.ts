import postgres from "postgres";
import type { Locator } from "playwright";

import {
  appOrigin,
  applicationCounts,
  databaseUrl,
  finishOAuth,
  installProvider,
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

function referenceAdapter(referenceUrl: string): TrustedBrowserWorkflowAdapter {
  const supported = new Set<WorkflowId>([
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
