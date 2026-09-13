import type { Page } from "playwright";
import type { Observation } from "./self-reproduction-parity";

/** Browser history behavior only: this does not award instant-navigation credit. */
export const exerciseCandidateNavigation = async (
  page: Page,
  baseURL: string,
  capture: (state: string) => Promise<void>,
): Promise<Observation> => {
  const observation: Observation = {
    artifacts: [],
    assertions: [],
    disposition: "not-run",
    method: "browser",
    reason: "No supported navigation fixture was established.",
    requirementId: "navigation-continuity",
  };
  try {
    const response = await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    if (!response?.ok()) throw new Error("Candidate entry unavailable");
  } catch {
    return {
      ...observation,
      disposition: "infrastructure-unavailable",
      reason: "Candidate runtime could not be opened.",
    };
  }
  const name = page.getByRole("textbox", { name: "App name", exact: true });
  const brief = page.getByRole("textbox", { name: "What would you like to build?", exact: true });
  const docs = page.getByRole("button", { name: "Docs", exact: true });
  try {
    await Promise.all(
      [
        name,
        brief,
        docs,
        page.getByRole("button", { name: "Continue to review", exact: true }),
      ].map((control) => control.waitFor({ state: "visible", timeout: 10_000 })),
    );
  } catch {
    return observation;
  }
  try {
    const initialURL = page.url();
    await name.fill("Navigation continuity sentinel");
    await brief.fill("Keep this draft through browser Back and Forward.");
    const header = await page.locator("header").first().elementHandle();
    await docs.focus();
    await docs.press("Enter");
    const back = page.getByRole("button", { name: /back to builder|return to builder/iu }).first();
    await back.waitFor({ state: "visible", timeout: 10_000 });
    const docsURL = page.url();
    const sharedDuringDocs = header ? await header.evaluate((node) => node.isConnected) : undefined;
    await capture("documentation");
    await page.goBack({ waitUntil: "domcontentloaded" });
    await name.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      // A missing editor after browser Back is an observed continuity failure.
    });
    const restored = page.url() === initialURL && (await name.isVisible().catch(() => false));
    const valuesRestored =
      restored &&
      (await name.inputValue()) === "Navigation continuity sentinel" &&
      (await brief.inputValue()) === "Keep this draft through browser Back and Forward.";
    const focusRestored =
      restored && (await docs.evaluate((node) => node === document.activeElement));
    const sharedAfterBack = header
      ? await header.evaluate((node) => node.isConnected).catch(() => false)
      : undefined;
    await capture("back");
    await page.goForward({ waitUntil: "domcontentloaded" });
    await back.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      // Missing documentation after Forward is an observed continuity failure.
    });
    const forwarded = page.url() === docsURL && (await back.isVisible().catch(() => false));
    await capture("forward");
    observation.assertions = [
      {
        id: "back-forward-preserves-draft",
        passed: Boolean(valuesRestored && forwarded),
        detail: `Browser Back restored draft=${valuesRestored}; Forward restored Docs=${forwarded}. No custom Back control was used.`,
        artifacts: [],
      },
      {
        id: "focus-restored",
        passed: Boolean(focusRestored),
        detail: "Browser Back must restore focus to the activated Docs control.",
        artifacts: [],
      },
      ...(header
        ? [
            {
              id: "shared-layout-state-preserved",
              passed: Boolean(sharedDuringDocs && sharedAfterBack),
              detail:
                "The original shared header DOM instance must remain connected during Docs navigation and browser return.",
              artifacts: [],
            },
          ]
        : []),
    ];
    observation.disposition = observation.assertions.some((assertion) => !assertion.passed)
      ? "missing-functionality"
      : "observed";
    observation.reason =
      "Executed real browser Back/Forward with edited draft inputs and focus readback; no instant-navigation or authentication credit is implied.";
    return observation;
  } catch {
    return {
      ...observation,
      disposition: "not-run",
      reason:
        "The known entry controls were found, but the browser history fixture could not complete; retained screenshots are diagnostic.",
    };
  }
};

export const sandboxCandidateNavigation = () => ({
  artifactPaths: ["documentation.png", "back.png", "forward.png"],
  script: `import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
globalThis.__name = (value) => value;
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const outputPath = process.argv[3];
const artifactRoot = dirname(outputPath);
await mkdir(artifactRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const artifacts = [];
  const observation = await (${exerciseCandidateNavigation.toString()})(page, input.baseURL, async (state) => {
    await page.screenshot({ path: join(artifactRoot, state + '.png'), fullPage: true });
    artifacts.push(state + '.png');
  });
  observation.artifacts = artifacts;
  await writeFile(outputPath, JSON.stringify({ observation }));
} finally { await browser.close(); }
`,
});
