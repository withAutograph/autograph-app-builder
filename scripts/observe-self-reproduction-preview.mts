/* oxlint-disable eslint/no-await-in-loop -- Viewport observations are intentionally sequential. */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { desktopViewports } from "../evals/support/self-reproduction-parity";
import {
  loadWorkingPreview,
  sanitizePreviewEvidence,
  summarizePreviewRows,
  unavailablePreviewReport,
  writePreviewObservationReport,
} from "../evals/support/self-reproduction-preview-observation";
import type {
  PreviewObservationReport,
  PreviewViewportObservation,
} from "../evals/support/self-reproduction-preview-observation";

const { values } = parseArgs({
  options: {
    "brief-file": { type: "string" },
    help: { type: "boolean" },
    "output-dir": { type: "string" },
    "state-file": { type: "string" },
    "timeout-ms": { default: "30000", type: "string" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Observe an existing delivered preview. --state-file OWNER_STATE_JSON --output-dir EXTERNAL_PATH [--brief-file PATH] [--timeout-ms 30000]",
  );
  process.exit(0);
}
if (!values["state-file"] || !values["output-dir"]) {
  throw new Error("--state-file and --output-dir are required.");
}
const statePath = path.resolve(values["state-file"]);
const output = path.resolve(values["output-dir"]);
if (output === path.dirname(statePath)) {
  throw new Error("Observation output must not overwrite the original public eval directory.");
}
const repository = path.resolve(import.meta.dirname, "..");
const relative = path.relative(repository, output);
if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
  throw new Error("Observation output must remain outside the reference source tree.");
}
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error("--timeout-ms must be a positive integer.");
}
const syntheticBrief = values["brief-file"]
  ? await readFile(path.resolve(values["brief-file"]), "utf-8")
  : undefined;
const finding = await loadWorkingPreview(statePath);

if (finding.status === "ready") {
  const viewports: PreviewViewportObservation[] = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of desktopViewports) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const controls: { name: string; role: string }[] = [];
      let brief: PreviewViewportObservation["brief"];
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(sanitizePreviewEvidence(message.text()).slice(0, 1000));
        }
      });
      page.on("pageerror", (error) =>
        pageErrors.push(sanitizePreviewEvidence(error.message).slice(0, 1000)),
      );
      page.on("requestfailed", (request) => {
        if (request.resourceType() === "script") {
          pageErrors.push(
            sanitizePreviewEvidence(
              `Script request failed: ${request.url()} ${request.failure()?.errorText ?? "unknown error"}`,
            ).slice(0, 1000),
          );
        }
      });
      page.on("response", (response) => {
        if (response.request().resourceType() === "script" && !response.ok()) {
          pageErrors.push(
            sanitizePreviewEvidence(
              `Script response failed: ${response.status()} ${response.url()}`,
            ).slice(0, 1000),
          );
        }
      });
      const screenshot = `screenshots/${viewport.name}.png`;
      try {
        const response = await page.goto(finding.receipt.url, {
          timeout: timeoutMs,
          waitUntil: "domcontentloaded",
        });
        await page
          .waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) })
          .catch(() => {
            // A quiet network is advisory; the rendered page remains observable.
          });
        controls.push(
          ...(await page
            .locator("button,a,input,textarea,select,[role=button],[role=link]")
            .evaluateAll((elements) =>
              elements
                .filter((element) => {
                  const box = element.getBoundingClientRect();
                  return box.width > 0 && box.height > 0;
                })
                .slice(0, 100)
                .map((element) => ({
                  name:
                    element.getAttribute("aria-label") ??
                    element.getAttribute("placeholder") ??
                    element.textContent?.trim().slice(0, 200) ??
                    "",
                  role:
                    element.getAttribute("role") ??
                    {
                      A: "link",
                      BUTTON: "button",
                      INPUT: "input",
                      SELECT: "select",
                      TEXTAREA: "textbox",
                    }[element.tagName] ??
                    element.tagName.toLowerCase(),
                })),
            )),
        );
        if (syntheticBrief !== undefined) {
          const field = page
            .getByLabel(/your app brief|description/iu)
            .or(page.getByPlaceholder(/your app brief|description/iu))
            .first();
          if (await field.isVisible().catch(() => false)) {
            await field.fill(syntheticBrief);
            const actualValue = await field.inputValue();
            const continuation = page.getByRole("button", { name: /continue/iu }).first();
            const enabled = await continuation.isEnabled().catch(() => false);
            const valueMatched = actualValue === syntheticBrief;
            brief = {
              actualValue,
              reason:
                enabled && valueMatched
                  ? "The supported brief field retained the exact synthetic value and Continue was enabled."
                  : "The supported brief field did not retain the exact value or Continue remained disabled.",
              status: enabled && valueMatched ? "passed" : "failed",
            };
            controls.push({
              name: `Synthetic brief value: ${actualValue.slice(0, 500)}; Continue enabled: ${enabled}`,
              role: "diagnostic",
            });
          } else {
            brief = {
              reason: "No supported semantic brief field was found in this unfamiliar UI.",
              status: "unassessed",
            };
            controls.push({ name: "Synthetic brief field was not found", role: "diagnostic" });
          }
        }
        await mkdir(path.join(output, "screenshots"), { mode: 0o700, recursive: true });
        await page.screenshot({ fullPage: true, path: path.join(output, screenshot) });
        const failed =
          response === null ||
          !response.ok() ||
          consoleErrors.length > 0 ||
          pageErrors.length > 0 ||
          brief?.status === "failed";
        viewports.push({
          brief,
          consoleErrors,
          controls,
          pageErrors,
          screenshot,
          status: failed ? "failed" : "passed",
          viewport,
        });
      } catch (error) {
        viewports.push({
          brief,
          consoleErrors,
          controls,
          pageErrors: [...pageErrors, sanitizePreviewEvidence(String(error)).slice(0, 1000)],
          status: "blocked",
          viewport,
        });
      } finally {
        await context.close().catch(() => {
          // Observation receipts survive cleanup failures.
        });
      }
    }
    const rows = summarizePreviewRows(viewports, syntheticBrief !== undefined);
    const report: PreviewObservationReport = {
      generatedAt: new Date().toISOString(),
      kind: "self-reproduction-working-preview-observation/v1",
      note: "Observation only. Existing delivered preview; no hosting, installation, repair, publication, provider action, aggregate score, or parity credit.",
      rows,
      sourceState: path.basename(statePath),
      viewports,
    };
    await writePreviewObservationReport(output, report);
    console.log(`Preview observation complete; report: ${path.join(output, "index.html")}`);
    if (rows.some((row) => row.status === "failed" || row.status === "blocked")) {
      process.exitCode = 1;
    }
  } catch (error) {
    const report: PreviewObservationReport = {
      generatedAt: new Date().toISOString(),
      kind: "self-reproduction-working-preview-observation/v1",
      note: "Observation stopped after an evaluator error. Partial viewport evidence is retained; no hosting, repair, or parity credit.",
      rows: summarizePreviewRows(viewports, syntheticBrief !== undefined),
      sourceState: path.basename(statePath),
      viewports,
    };
    const browserRow = report.rows.find((row) => row.id === "browser-observation");
    if (browserRow) {
      browserRow.status = "blocked";
      browserRow.reason = `Observation stopped after an evaluator error: ${sanitizePreviewEvidence(String(error)).slice(0, 1000)}`;
    }
    await writePreviewObservationReport(output, report);
    console.error(`Preview observation blocked; report: ${path.join(output, "index.html")}`);
    process.exitCode = 75;
  } finally {
    await browser?.close().catch(() => {
      // Report writing is already complete.
    });
  }
} else {
  await writePreviewObservationReport(output, unavailablePreviewReport(statePath, finding));
  console.log(`Preview observation ${finding.status}; report: ${path.join(output, "index.html")}`);
  process.exitCode = finding.status === "expired" ? 75 : 1;
}
