import type { Locator, Page } from "playwright";

import type { CaptureAdapter, CaptureState } from "../support/self-reproduction-captures";

async function firstVisible(locators: Locator[]): Promise<Locator | undefined> {
  const counts = await Promise.all(locators.map((locator) => locator.count()));
  const candidates = locators.flatMap((locator, locatorIndex) =>
    Array.from({ length: counts[locatorIndex] ?? 0 }, (_, index) => locator.nth(index)),
  );
  const visibility = await Promise.all(candidates.map((candidate) => candidate.isVisible()));
  return candidates.find((_, index) => visibility[index]);
}

async function signature(page: Page) {
  return `${page.url()}\n${(await page.locator("body").textContent())?.slice(0, 4000) ?? ""}`;
}

function stateTarget(page: Page, state: CaptureState) {
  if (state === "panel-resize")
    return firstVisible([page.getByRole("separator"), page.locator("[data-panel-resize-handle]")]);
  if (state === "loading")
    return firstVisible([
      page.getByRole("progressbar"),
      page.locator('[aria-busy="true"]'),
      page.getByText(/building|creating|generating|loading|preparing/iu),
    ]);
  if (state === "empty")
    return firstVisible([
      page.getByText(/no apps|no drafts|create your first|get started|what should this app do/iu),
    ]);
  if (state === "error")
    return firstVisible([
      page.getByRole("alert"),
      page.getByText(/failed|error|could not|try again/iu),
    ]);
  return firstVisible([
    page.getByRole("button", { name: /build|create|continue|connect|documentation|docs/iu }),
    page.getByRole("link", { name: /build|create|continue|connect|documentation|docs/iu }),
  ]);
}

function unavailableState(state: CaptureState, side: "reference" | "candidate") {
  if (["loading", "empty", "error"].includes(state))
    return {
      ready: false as const,
      disposition: "not-run" as const,
      reason: `The default semantic adapter has no evaluator-owned ${state} fixture binding for the ${side} application.`,
    };
  return {
    ready: false as const,
    disposition: "missing-functionality" as const,
    reason: `The ${side} application exposes no visible semantic control for ${state}.`,
  };
}

export function createSemanticCaptureAdapter(
  baseURL: string,
  side: "reference" | "candidate",
): CaptureAdapter {
  return {
    async prepare(page, state) {
      try {
        await page.goto(baseURL, { waitUntil: "domcontentloaded" });
        return (await stateTarget(page, state)) ? { ready: true } : unavailableState(state, side);
      } catch {
        return {
          ready: false,
          disposition: "infrastructure-unavailable",
          reason: "The application URL could not be opened by the evaluator browser.",
        };
      }
    },
    async exercise(page, state, capture) {
      const target = await stateTarget(page, state);
      if (!target)
        return [
          {
            id: "fixture-execution",
            passed: false,
            detail: `The ${state} target disappeared before exercise.`,
          },
        ];
      if (state === "panel-resize") {
        const before = await target.boundingBox();
        if (before) {
          await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
          await page.mouse.down();
          await page.mouse.move(before.x + before.width / 2 + 80, before.y + before.height / 2, {
            steps: 4,
          });
          await page.mouse.up();
        }
        const after = await target.boundingBox();
        await capture();
        return [
          {
            id: "panel-dimension-changed",
            passed: Boolean(before && after && Math.abs(after.x - before.x) >= 8),
            detail: `Separator x-position changed from ${before?.x ?? "unavailable"} to ${after?.x ?? "unavailable"}.`,
          },
          {
            id: "content-remains-reachable",
            passed: await page.locator("main, body").first().isVisible(),
            detail: "Primary page content remained visible after the resize gesture.",
          },
        ];
      }
      if (state === "keyboard") {
        await target.focus();
        const focused = await target.evaluate((element) => element === document.activeElement);
        const before = await signature(page);
        await capture();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(100);
        return [
          { id: "focus-visible", passed: focused, detail: "Semantic control received focus." },
          {
            id: "keyboard-activation-changes-state",
            passed: (await signature(page)) !== before,
            detail: "Enter activation was compared against URL and visible page content.",
          },
        ];
      }
      if (state === "loading") {
        await capture();
        const text = (await target.textContent().catch(() => "")) ?? "";
        return [
          {
            id: "pending-held",
            passed: await target.isVisible(),
            detail: "Pending UI stayed visible.",
          },
          {
            id: "useful-loading-visible",
            passed: text.trim().length > 0 || (await target.getAttribute("aria-label")) !== null,
            detail: "Pending UI exposed visible text or an accessible label.",
          },
        ];
      }
      const recovery = await firstVisible([
        page.getByRole("button", { name: /build|create|continue|get started|retry|try again/iu }),
        page.getByRole("link", { name: /build|create|continue|get started|retry|try again/iu }),
      ]);
      const before = await signature(page);
      await capture();
      await recovery?.click();
      await page.waitForTimeout(100);
      const changed = Boolean(recovery) && (await signature(page)) !== before;
      return state === "empty"
        ? [
            {
              id: "empty-state-visible",
              passed: true,
              detail: "Empty-state guidance was visible.",
            },
            {
              id: "next-action-works",
              passed: changed,
              detail: "The empty-state action changed UI state.",
            },
          ]
        : [
            { id: "error-visible", passed: true, detail: "Error feedback was visible." },
            {
              id: "recovery-action-works",
              passed: changed,
              detail: "The recovery action changed UI state.",
            },
          ];
    },
  };
}

export function createCaptureAdapters(input: { referenceURL: string; candidateURL: string }) {
  return Promise.resolve({
    reference: createSemanticCaptureAdapter(new URL(input.referenceURL).href, "reference"),
    candidate: createSemanticCaptureAdapter(new URL(input.candidateURL).href, "candidate"),
  });
}
