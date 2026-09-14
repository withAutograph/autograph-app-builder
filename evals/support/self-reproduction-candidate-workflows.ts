/* oxlint-disable eslint/no-await-in-loop, eslint/no-negated-condition, unicorn/no-negated-condition, unicorn/consistent-function-scoping, promise/prefer-await-to-then, unicorn/prefer-ternary -- isolated browser workflows run sequentially; all helpers remain inside the portable evaluator function. */
import { runtimeReceiptSchema } from "./self-reproduction-parity-evidence";
import { sanitizeEvidence } from "./self-reproduction-evidence";
import type { Browser, Page } from "playwright";

export interface CandidateWorkflowOutcome {
  requirementId: string;
  status: "passed" | "failed" | "blocked" | "unassessed";
  reason: string;
  assertions: { id: string; passed: boolean | null; detail: string }[];
  evidence?: { buttons: string[]; headings: string[]; mutationPaths: string[] };
}

/** Evaluator-owned browser checks. Serialized into Sandbox, never supplied to generation. */
export const exerciseCandidateBrowserWorkflows = async (
  browser: Browser,
  baseURL: string,
  retain: (outcomes: CandidateWorkflowOutcome[]) => Promise<void>,
) => {
  const outcomes: CandidateWorkflowOutcome[] = [];
  const ids = [
    "documentation",
    "durable-draft",
    "provider-return-success",
    "independent-child",
    "cancellation",
    "session-recovery",
  ];
  for (const requirementId of ids) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        writes.push(new URL(request.url()).pathname);
      }
    });
    const assertions: CandidateWorkflowOutcome["assertions"] = [];
    const check = (id: string, passed: boolean | null, detail: string) =>
      assertions.push({ detail, id, passed });
    const button = (name: RegExp) => page.getByRole("button", { name }).first();
    const exists = (locator: ReturnType<Page["locator"]>) => locator.isVisible().catch(() => false);
    const text = () => page.locator("body").textContent();
    let outcome: CandidateWorkflowOutcome = {
      assertions: [],
      reason: "Candidate workflow did not produce an outcome.",
      requirementId,
      status: "blocked",
    };
    let knownShape = false;
    let runtimeReady = false;
    const runDocumentation = async () => {
      let docs = button(/^docs$|documentation/iu);
      if (!(await exists(docs))) {
        docs = page.getByRole("link", { name: /^docs$|documentation/iu }).first();
      }
      if (!(await exists(docs))) {
        return check(
          "docs-readable",
          knownShape ? false : null,
          "No documentation fixture is bound for this layout.",
        );
      }
      const before = await text();
      const initialURL = page.url();
      const originalEditor = page.getByRole("textbox", { name: /app name/iu }).first();
      const originalValue = knownShape ? await originalEditor.inputValue() : undefined;
      await docs.click();
      const navigated = page.url() !== initialURL;
      const content = page.locator("main, article").first();
      check(
        "docs-readable",
        (await exists(content)) &&
          ((await content.textContent()) ?? "").trim().length > 40 &&
          (await text()) !== before,
        "Activated the actual Docs control and checked distinct readable content.",
      );
      const back = button(/return to builder|back to builder|back/iu);
      if (await exists(back)) {
        await back.click();
      } else {
        await page.goBack();
      }
      let returnNavigationPassed: boolean | null;
      if (knownShape) {
        returnNavigationPassed =
          (await exists(originalEditor)) && (await originalEditor.inputValue()) === originalValue;
      } else if (navigated) {
        returnNavigationPassed = page.url() === initialURL && (await exists(docs));
      } else {
        returnNavigationPassed = null;
      }
      check(
        "return-navigation-works",
        returnNavigationPassed,
        "Return must restore the original editor value or original navigated URL and control; dynamic whole-page text is not compared.",
      );
    };
    const runDurableDraft = async () => {
      const name = page.getByRole("textbox", { name: /app name/iu }).first();
      const brief = page.getByRole("textbox", { name: /what.*build|brief|describe/iu }).first();
      if (!(await exists(name)) || !(await exists(brief))) {
        return check(
          "draft-editable",
          false,
          "Required draft editors are absent from the candidate entry state.",
        );
      }
      await name.fill("Evaluator persistence sentinel");
      await brief.fill("Create one independent issue tracker with durable server persistence.");
      await brief.blur();
      const saved = page.getByText(/draft saved|changes saved/iu).first();
      const acknowledged = await saved
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      await page.waitForLoadState("networkidle");
      await page.reload({ waitUntil: "networkidle" });
      const nameValue = await name.inputValue();
      const briefValue = await brief.inputValue();
      let draftDurability: boolean | null;
      if (
        nameValue === "Evaluator persistence sentinel" &&
        briefValue.includes("independent issue tracker")
      ) {
        draftDurability = true;
      } else if (writes.length > 0 || !acknowledged) {
        draftDurability = null;
      } else {
        draftDurability = false;
      }
      check(
        "draft-survives-reload",
        draftDurability,
        "Reload follows blur and visible save acknowledgement. If a backend write is still unresolved, durability remains unknown rather than imposing a timing SLA.",
      );
      check(
        "server-write-observed",
        writes.length > 0 || !acknowledged ? null : false,
        writes.length
          ? "Writes were observed but durable authorization/readback still requires a fixture."
          : "No server mutation occurred while editing and waiting for persistence.",
      );
    };
    const runProviderReturn = async () => {
      const connect = button(/connect github/iu);
      if (!(await exists(connect))) {
        return check("connection-control", false, "No GitHub connection control exists.");
      }
      const beforeURL = page.url();
      await connect.click();
      await page.waitForTimeout(500);
      const connected = await exists(button(/^disconnect$/iu));
      check(
        "callback-consumed",
        page.url() === beforeURL && writes.length === 0 && connected ? false : null,
        "A local Connected toggle without any server request or navigation is not a provider callback.",
      );
      await page.reload({ waitUntil: "networkidle" });
      check(
        "connection-persisted",
        connected ? await exists(button(/^disconnect$/iu)) : null,
        "Any newly reported connection must survive reload; external approval is not fabricated.",
      );
    };
    const runCancellation = async () => {
      const cancel = button(/cancel creation|cancel|stop/iu);
      if (!(await exists(cancel))) {
        return check(
          "cancel-acknowledged",
          false,
          "No cancellation control is available while creating.",
        );
      }
      await cancel.click();
      const acknowledged = /cancelled|canceled/iu.test((await text()) ?? "");
      check(
        "cancel-acknowledged",
        acknowledged,
        "Cancellation must produce visible acknowledgement.",
      );
      await page.reload({ waitUntil: "networkidle" });
      check(
        "terminal-state-persists",
        acknowledged && /cancelled|canceled/iu.test((await text()) ?? ""),
        "The cancelled job must remain cancelled after reload.",
      );
      check(
        "server-cancellation",
        writes.length > 0 ? null : false,
        "A UI stage toggle without a server mutation cannot cancel durable work.",
      );
    };
    const runSessionRecovery = async () => {
      const fresh = await browser.newContext();
      try {
        const recovered = await fresh.newPage();
        await recovered.goto(baseURL, { waitUntil: "networkidle" });
        check(
          "server-job-created",
          writes.length > 0 ? null : false,
          "Recovery requires a persisted job; UI-only state changes create none.",
        );
        check(
          "authenticated-session-restoration",
          null,
          "A separate authenticated identity fixture is required for cross-context restoration; anonymous access is not expected.",
        );
      } finally {
        await fresh.close();
      }
    };
    const runChildArtifact = async () => {
      const finish = button(/finish preview/iu);
      if (await exists(finish)) {
        await finish.click();
      }
      await page.waitForTimeout(500);
      const links = page.getByRole("link", {
        name: /preview|open app|view app|download/iu,
      });
      const count = await links.count();
      let linkedStatus: boolean | null;
      if (count > 0) {
        linkedStatus = true;
      } else if (writes.length > 0) {
        linkedStatus = null;
      } else {
        linkedStatus = false;
      }
      let linkedReason: string;
      if (count > 0) {
        linkedReason =
          "Creation exposed a navigable artifact link; its contents still require verification.";
      } else if (writes.length > 0) {
        linkedReason =
          "A server request was observed but no child artifact is available yet; completion needs a durable job fixture.";
      } else {
        linkedReason =
          "No server operation or navigable child artifact exists after the visible creation flow.";
      }
      check("child-artifact-linked", linkedStatus, linkedReason);
      if (count > 0) {
        const href = await links.first().getAttribute("href");
        if (
          !href ||
          href.startsWith("#") ||
          !/^https?:/u.test(new URL(href, page.url()).protocol)
        ) {
          check("child-artifact-readable", false, "The reported child artifact link is inert.");
        } else {
          const target = new URL(href, page.url());
          const artifact = await page.request.get(target.href);
          const artifactText = await artifact.text();
          check(
            "child-artifact-readable",
            artifact.ok() && artifactText.length > 40 && target.href !== new URL(baseURL).href,
            "The distinct linked artifact must answer successfully with content.",
          );
        }
      }
      check(
        "independent-orchestration",
        writes.length > 0 ? null : false,
        "Server requests require independent backend verification; absence of requests proves no server orchestration was invoked.",
      );
    };
    const runCreation = async () => {
      const review = button(/continue to review/iu);
      if (await exists(review)) {
        await review.click();
      }
      const create = button(/approve and create|create app|build app/iu);
      if (!(await exists(create))) {
        return check("creation-control", false, "No executable creation control is available.");
      }
      await create.click();
      await page.waitForTimeout(500);
      if (requirementId === "cancellation") {
        await runCancellation();
      } else if (requirementId === "session-recovery") {
        await runSessionRecovery();
      } else {
        await runChildArtifact();
      }
    };
    const runWorkflow =
      (
        {
          documentation: runDocumentation,
          "durable-draft": runDurableDraft,
          "provider-return-success": runProviderReturn,
        } as Record<string, () => Promise<void>>
      )[requirementId] ?? runCreation;
    try {
      const response = await page.goto(baseURL, { waitUntil: "networkidle" });
      runtimeReady = Boolean(response?.ok());
      knownShape =
        runtimeReady &&
        (await exists(button(/continue to review/iu))) &&
        (await exists(page.getByRole("textbox", { name: /app name/iu }).first()));
      if (runtimeReady && !knownShape && requirementId !== "documentation") {
        outcome = {
          assertions: [],
          reason: "This candidate layout has no supported evaluator fixture binding.",
          requirementId,
          status: "unassessed",
        };
      } else if (!response?.ok()) {
        outcome = {
          assertions: [],
          reason: "Candidate runtime did not answer successfully.",
          requirementId,
          status: "blocked",
        };
      } else {
        await runWorkflow();
        let status: CandidateWorkflowOutcome["status"];
        if (assertions.some((item) => item.passed === false)) {
          status = "failed";
        } else if (assertions.length === 0 || assertions.some((item) => item.passed === null)) {
          status = "unassessed";
        } else {
          status = "passed";
        }
        outcome = {
          assertions,
          reason:
            "Evaluator exercised visible controls; server orchestration requires durable evidence beyond UI stage changes.",
          requirementId,
          status,
        };
      }
    } catch (error) {
      outcome = {
        assertions,
        reason: `Browser fixture could not complete: ${error instanceof Error ? error.message : String(error)}`,
        requirementId,
        status:
          assertions.some((item) => item.passed === false) || (runtimeReady && knownShape)
            ? "failed"
            : "blocked",
      };
    } finally {
      if (knownShape) {
        outcome.evidence = {
          buttons: await page
            .getByRole("button")
            .allTextContents()
            .catch(() => []),
          headings: await page
            .getByRole("heading")
            .allTextContents()
            .catch(() => []),
          mutationPaths: writes,
        };
      }
      await context.close();
    }
    outcomes.push(outcome);
    await retain(outcomes);
  }
  return outcomes;
};

export const sandboxCandidateWorkflowComparison = () => {
  const script = `
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const input = JSON.parse(await readFile(process.argv[2],'utf8'));
const __name = (value) => value;
const run = ${exerciseCandidateBrowserWorkflows.toString()};
const sanitize = ${sanitizeEvidence.toString()};
const browser = await chromium.launch({headless:true});
try { await run(browser,input.baseURL,async outcomes => {await writeFile(process.argv[3],JSON.stringify(sanitize({producer:'evaluator',kind:'candidate-browser-workflows',outcomes})));}); }
finally {await browser.close();}
`;
  return { artifactPaths: [] as string[], script };
};

/** Convert only evaluator-produced observations; unknown assertions stay unknown. */
export const candidateWorkflowReceipts = (
  outcomes: CandidateWorkflowOutcome[],
  artifactPath: string,
) =>
  outcomes.map((outcome) =>
    runtimeReceiptSchema.parse({
      observation: {
        artifacts: [artifactPath],
        assertions: outcome.assertions
          .filter((item) => item.passed !== null)
          .map((item) => ({
            ...item,
            artifacts: [artifactPath],
            detail: sanitizeEvidence(item.detail),
          })),
        disposition: (() => {
          if (outcome.assertions.some((item) => item.passed === false)) {
            return "observed";
          }
          if (outcome.status === "blocked") {
            return "infrastructure-unavailable";
          }
          if (outcome.status === "unassessed") {
            return "not-run";
          }
          if (
            outcome.status === "failed" &&
            !outcome.assertions.some((item) => item.passed === false)
          ) {
            return "missing-functionality";
          }
          return "observed";
        })(),
        method: "browser",
        reason: sanitizeEvidence(outcome.reason),
        requirementId: outcome.requirementId,
      },
      producer: "evaluator",
      schemaVersion: "self-reproduction-runtime-receipt/v1",
      side: "candidate",
    }),
  );
