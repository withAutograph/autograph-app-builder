import type { Page } from "playwright";
import type { Observation } from "./self-reproduction-parity";

const CANDIDATE_ENTRY_UNAVAILABLE = "Candidate entry unavailable";
const NAVIGATION_CONTINUITY_REQUIREMENT = "navigation-continuity";
const DRAFT_SENTINEL = "Navigation continuity sentinel";
const DRAFT_BRIEF = "Keep this draft through browser Back and Forward.";
const NAVIGATION_RECEIPT = "candidate-navigation.json";
const MISSING_FUNCTIONALITY = "missing-functionality" as const;
const INFRASTRUCTURE_UNAVAILABLE = "infrastructure-unavailable" as const;
const CANDIDATE_RUNTIME_UNAVAILABLE = "Candidate runtime could not be opened.";

const handleMissingBackControl = async (
  page: Page,
  initialURL: string,
  initialContent: string | null,
  observation: Observation,
  capture: (state: string) => Promise<void>,
): Promise<Observation> => {
  const inert =
    page.url() === initialURL && (await page.locator("body").textContent()) === initialContent;
  observation.disposition = inert ? MISSING_FUNCTIONALITY : "not-run";
  observation.reason = inert
    ? "The known Docs control accepted keyboard activation but left URL and visible content unchanged. Browser history continuity cannot proceed."
    : "Docs changed the application, but its destination does not match the supported history fixture.";
  if (inert) {
    observation.assertions = [
      {
        artifacts: [],
        detail: "Docs activation produced no product transition to traverse with browser history.",
        id: "back-forward-preserves-draft",
        passed: false,
      },
    ];
  }
  await capture("documentation");
  return observation;
};

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
    requirementId: NAVIGATION_CONTINUITY_REQUIREMENT,
  };
  try {
    const response = await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    if (response?.ok() !== true) {
      throw new Error(CANDIDATE_ENTRY_UNAVAILABLE);
    }
  } catch {
    return {
      ...observation,
      disposition: INFRASTRUCTURE_UNAVAILABLE,
      reason: CANDIDATE_RUNTIME_UNAVAILABLE,
    };
  }
  const name = page.getByRole("textbox", { exact: true, name: "App name" });
  const brief = page.getByRole("textbox", { exact: true, name: "What would you like to build?" });
  const docs = page.getByRole("button", { exact: true, name: "Docs" });
  try {
    await Promise.all(
      [
        name,
        brief,
        docs,
        page.getByRole("button", { exact: true, name: "Continue to review" }),
      ].map(async (control) => {
        await control.waitFor({ state: "visible", timeout: 10_000 });
      }),
    );
  } catch {
    return observation;
  }
  try {
    const initialURL = page.url();
    await name.fill(DRAFT_SENTINEL);
    await brief.fill(DRAFT_BRIEF);
    const initialContent = await page.locator("body").textContent();
    await docs.focus();
    await docs.press("Enter");
    const back = page.getByRole("button", { name: /back to builder|return to builder/iu }).first();
    try {
      await back.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      return await handleMissingBackControl(page, initialURL, initialContent, observation, capture);
    }
    const docsURL = page.url();
    await capture("documentation");
    await page.goBack({ waitUntil: "domcontentloaded" });
    try {
      await name.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      // A missing editor after browser Back is an observed continuity failure.
    }
    let editorVisible = false;
    try {
      editorVisible = await name.isVisible();
    } catch {
      // A missing editor after browser Back is an observed continuity failure.
    }
    const restored = page.url() === initialURL && editorVisible;
    const valuesRestored =
      restored &&
      (await name.inputValue()) === DRAFT_SENTINEL &&
      (await brief.inputValue()) === DRAFT_BRIEF;
    const focusRestored =
      restored && (await docs.evaluate((node) => node === document.activeElement));
    await capture("back");
    await page.goForward({ waitUntil: "domcontentloaded" });
    try {
      await back.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      // Missing documentation after Forward is an observed continuity failure.
    }
    let backControlVisible = false;
    try {
      backControlVisible = await back.isVisible();
    } catch {
      // Missing documentation after Forward is an observed continuity failure.
    }
    const forwarded = page.url() === docsURL && backControlVisible;
    await capture("forward");
    observation.assertions = [
      {
        artifacts: [],
        detail: `Browser Back restored draft=${valuesRestored}; Forward restored Docs=${forwarded}. No custom Back control was used.`,
        id: "back-forward-preserves-draft",
        passed: valuesRestored && forwarded,
      },
      {
        artifacts: [],
        detail: "Browser Back must restore focus to the activated Docs control.",
        id: "focus-restored",
        passed: focusRestored,
      },
    ];
    observation.disposition = observation.assertions.some((assertion) => !assertion.passed)
      ? MISSING_FUNCTIONALITY
      : "observed";
    observation.reason =
      "Executed real browser Back/Forward with edited draft inputs and focus readback; shared-layout state has no bound contract and remains unassessed. No instant-navigation or authentication credit is implied.";
    return observation;
  } catch {
    return {
      ...observation,
      disposition:
        observation.disposition === MISSING_FUNCTIONALITY
          ? MISSING_FUNCTIONALITY
          : INFRASTRUCTURE_UNAVAILABLE,
      reason:
        observation.disposition === MISSING_FUNCTIONALITY
          ? observation.reason
          : "The browser history probe could not complete after fixture binding; retained diagnostics do not establish a product outcome.",
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

/** Failed execution must remain a linked blocker, independently of runtime readiness. */
export const candidateNavigationReceipt = (output: { observation?: Observation } | null) => {
  const observation = output?.observation;
  return {
    observation: observation
      ? {
          ...observation,
          artifacts: [
            NAVIGATION_RECEIPT,
            ...observation.artifacts.map((path) => `candidate-navigation/${path}`),
          ],
          assertions: observation.assertions.map((assertion) => ({
            ...assertion,
            artifacts: [
              NAVIGATION_RECEIPT,
              ...observation.artifacts.map((path) => `candidate-navigation/${path}`),
              ...assertion.artifacts.map((path) => `candidate-navigation/${path}`),
            ],
          })),
        }
      : {
          artifacts: [NAVIGATION_RECEIPT],
          assertions: [],
          disposition: INFRASTRUCTURE_UNAVAILABLE,
          method: "none" as const,
          reason:
            "Candidate runtime was available, but the separate navigation probe failed to retain an evaluator observation.",
          requirementId: NAVIGATION_CONTINUITY_REQUIREMENT,
        },
    producer: "evaluator" as const,
    schemaVersion: "self-reproduction-runtime-receipt/v1" as const,
    side: "candidate" as const,
  };
};
