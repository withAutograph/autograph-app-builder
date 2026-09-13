/* oxlint-disable eslint/require-await -- asynchronous browser fixture methods mirror Playwright. */
import { expect, it, vi } from "vitest";
import {
  exerciseCandidateBrowserWorkflows,
  candidateWorkflowReceipts,
  sandboxCandidateWorkflowComparison,
} from "./self-reproduction-candidate-workflows";

function browserFixture(visible = false, reachable = true, missingDocs = false) {
  const locator = {
    first: () => locator,
    isVisible: async () => visible,
    textContent: async () =>
      "Unchanged visible candidate content long enough to look like documentation",
    click: vi.fn(),
    fill: vi.fn(),
    inputValue: async () => "Default draft value",
    count: async () => 0,
    allTextContents: async () => ["Synthetic control"],
  };
  const page = {
    setDefaultTimeout: vi.fn(),
    on: vi.fn(),
    goto: async () => ({ ok: () => reachable }),
    getByRole: (_role: string, options?: { name?: RegExp }) => {
      if (missingDocs && options?.name?.source.includes("docs")) {
        const absent = { ...locator, first: () => absent, isVisible: async () => false };
        return absent;
      }
      return locator;
    },
    locator: () => locator,
    goBack: vi.fn(),
    waitForTimeout: vi.fn(),
    reload: vi.fn(),
    url: () => "https://candidate.example/app/",
  };
  const context = { newPage: async () => page, close: vi.fn() };
  return { newContext: async () => context };
}

it("leaves unfamiliar layouts unassessed and retains each partial outcome", async () => {
  const retain = vi.fn();
  const outcomes = await exerciseCandidateBrowserWorkflows(
    browserFixture() as never,
    "https://candidate.example/app/",
    retain,
  );
  expect(outcomes).toHaveLength(6);
  expect(outcomes.every((row) => row.status === "unassessed")).toBe(true);
  expect(retain).toHaveBeenCalledTimes(6);
});

it("does not award readable documentation to an inert Docs button", async () => {
  const outcomes = await exerciseCandidateBrowserWorkflows(
    browserFixture(true) as never,
    "https://candidate.example/app/",
    vi.fn(),
  );
  expect(outcomes[0]?.status).toBe("failed");
  expect(outcomes[0]?.assertions.find((row) => row.id === "docs-readable")?.passed).toBe(false);
});

it("blocks unavailable runtime separately from absent product controls", async () => {
  const outcomes = await exerciseCandidateBrowserWorkflows(
    browserFixture(false, false) as never,
    "https://candidate.example/app/",
    vi.fn(),
  );
  expect(outcomes.every((row) => row.status === "blocked")).toBe(true);
});

it("provides standalone evaluator code without injecting candidate source", () => {
  const { script } = sandboxCandidateWorkflowComparison();
  expect(script).toContain("chromium.launch");
  expect(script).toContain("candidate-browser-workflows");
  expect(script).not.toContain("'/docs'");
});

it("fails a draft whose edited values are lost on reload", async () => {
  const outcomes = await exerciseCandidateBrowserWorkflows(
    browserFixture(true) as never,
    "https://candidate.example/app/",
    vi.fn(),
  );
  const draft = outcomes.find((row) => row.requirementId === "durable-draft");
  expect(draft?.status).toBe("failed");
  expect(draft?.assertions.find((row) => row.id === "draft-survives-reload")?.passed).toBe(false);
});

it("fails an absent Docs control within the supported candidate layout", async () => {
  const outcomes = await exerciseCandidateBrowserWorkflows(
    browserFixture(true, true, true) as never,
    "https://candidate.example/app/",
    vi.fn(),
  );
  expect(outcomes[0]?.status).toBe("failed");
});

it("preserves unknown assertions when converting retained evaluator outcomes", () => {
  const receipts = candidateWorkflowReceipts(
    [
      {
        requirementId: "durable-draft",
        status: "unassessed",
        reason: "Durability needs readback",
        assertions: [
          { id: "write-acknowledged", passed: true, detail: "Observed acknowledgement" },
          { id: "revision-advanced", passed: null, detail: "No readback fixture" },
        ],
      },
    ],
    "candidate-workflows.json",
  );
  expect(receipts[0]?.observation.disposition).toBe("not-run");
  expect(receipts[0]?.observation.assertions).toHaveLength(1);
});
