/* oxlint-disable eslint/require-await -- asynchronous browser fixture methods mirror Playwright. */
import { expect, it, vi } from "vitest";
import {
  exerciseCandidateBrowserWorkflows,
  candidateWorkflowReceipts,
  sandboxCandidateWorkflowComparison,
} from "./self-reproduction-candidate-workflows";

const browserFixture = (
  visible = false,
  reachable = true,
  missingDocs = false,
  serverRequest = false,
) => {
  const locator = {
    allTextContents: async () => ["Synthetic control"],
    blur: vi.fn(),
    click: vi.fn(),
    count: async () => 0,
    fill: vi.fn(),
    first: () => locator,
    inputValue: async () => "Default draft value",
    isVisible: async () => visible,
    textContent: async () =>
      "Unchanged visible candidate content long enough to look like documentation",
    waitFor: async () => {},
  };
  const page = {
    getByRole: (_role: string, options?: { name?: RegExp }) => {
      if (missingDocs && options?.name?.source.includes("docs")) {
        const absent = { ...locator, first: () => absent, isVisible: async () => false };
        return absent;
      }
      return locator;
    },
    getByText: () => locator,
    goBack: vi.fn(),
    goto: async () => ({ ok: () => reachable }),
    locator: () => locator,
    on: (
      _event: string,
      listener: (request: { method: () => string; url: () => string }) => void,
    ) => {
      if (serverRequest)
        {listener({ method: () => "POST", url: () => "https://candidate.example/api/create" });}
    },
    reload: vi.fn(),
    setDefaultTimeout: vi.fn(),
    url: () => "https://candidate.example/app/",
    waitForLoadState: vi.fn(),
    waitForTimeout: vi.fn(),
  };
  const context = { close: vi.fn(), newPage: async () => page };
  return { newContext: async () => context };
};

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
        assertions: [
          { detail: "Observed acknowledgement", id: "write-acknowledged", passed: true },
          { detail: "No readback fixture", id: "revision-advanced", passed: null },
        ],
        reason: "Durability needs readback",
        requirementId: "durable-draft",
        status: "unassessed",
      },
    ],
    "candidate-workflows.json",
  );
  expect(receipts[0]?.observation.disposition).toBe("not-run");
  expect(receipts[0]?.observation.assertions).toHaveLength(1);
});

it("does not fail an unfinished backend creation merely because no link appeared immediately", async () => {
  const outcomes = await exerciseCandidateBrowserWorkflows(
    browserFixture(true, true, false, true) as never,
    "https://candidate.example/app/",
    vi.fn(),
  );
  const creation = outcomes.find((row) => row.requirementId === "independent-child");
  expect(creation?.status).toBe("unassessed");
  expect(creation?.assertions.find((row) => row.id === "child-artifact-linked")?.passed).toBeNull();
});

it("retains a proven failure if later infrastructure prevents completion", () => {
  const receipts = candidateWorkflowReceipts(
    [
      {
        assertions: [{ detail: "Inert Docs control", id: "docs-readable", passed: false }],
        reason: "Browser later disconnected",
        requirementId: "documentation",
        status: "blocked",
      },
    ],
    "candidate-workflows.json",
  );
  expect(receipts[0]?.observation.disposition).toBe("observed");
  expect(receipts[0]?.observation.assertions[0]?.passed).toBe(false);
});
