/* oxlint-disable eslint/require-await -- Browser doubles preserve asynchronous Playwright operations. */
import { runtimeReceiptSchema } from "./self-reproduction-parity-evidence";
import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import {
  candidateNavigationReceipt,
  exerciseCandidateNavigation,
  sandboxCandidateNavigation,
} from "./self-reproduction-candidate-navigation";

it.each(["history", "local-state", "inert", "unknown", "unavailable"])(
  "assesses %s navigation without custom back controls",
  async (mode) => {
    let view = "editor";
    const values = new Map<string, string>();
    const control = (name: string) => ({
      evaluate: async () => view === "editor" && mode === "history",
      fill: async (value: string) => {
        values.set(name, value);
      },
      first: () => control(name),
      focus: vi.fn(),
      inputValue: async () => values.get(name),
      isVisible: async () => (name === "back" ? view === "docs" : view === "editor"),
      press: async () => {
        if (mode !== "inert") {view = "docs";}
      },
      waitFor: async () => {
        if (mode === "unknown" || (mode === "inert" && name === "back"))
          {throw new Error("Unavailable control");}
      },
    });
    const page = {
      getByRole: (_role: string, options: { name: string | RegExp }) =>
        control(typeof options.name === "string" ? options.name : "back"),
      goBack: async () => {
        if (mode === "history") {view = "editor";}
      },
      goForward: async () => {
        view = "docs";
      },
      goto: async () => ({ ok: () => mode !== "unavailable" }),
      locator: () => ({ textContent: async () => view }),
      url: () =>
        mode === "history" && view === "docs" ? "https://candidate/docs" : "https://candidate/",
    } as unknown as Page;
    const capture = vi.fn(async () => {});
    // oxlint-disable-next-line eslint/no-new-func -- Verify serialized portable function has no module closure dependencies.
    const portable = new Function(
      `return (${exerciseCandidateNavigation.toString()})`,
    )() as typeof exerciseCandidateNavigation;
    const result = await portable(page, "https://candidate/", capture);
    result.artifacts = ["documentation.png", "back.png", "forward.png"];
    const receipt = runtimeReceiptSchema.parse(candidateNavigationReceipt({ observation: result }));
    expect(receipt.observation.assertions.map(({ passed }) => passed)).toEqual(
      result.assertions.map(({ passed }) => passed),
    );
    for (const assertion of receipt.observation.assertions) {
      expect(assertion.artifacts).toEqual([
        "candidate-navigation.json",
        "candidate-navigation/documentation.png",
        "candidate-navigation/back.png",
        "candidate-navigation/forward.png",
      ]);
    }
    expect(result.disposition).toBe(
      {
        history: "observed",
        inert: "missing-functionality",
        "local-state": "missing-functionality",
        unavailable: "infrastructure-unavailable",
        unknown: "not-run",
      }[mode],
    );
    if (mode === "history") {expect(result.assertions.every(({ passed }) => passed)).toBe(true);}
    if (mode === "local-state")
      {expect(
        result.assertions.find(({ id }) => id === "back-forward-preserves-draft")?.passed,
      ).toBe(false);}
    let expectedCaptureCount = 0;
    if (mode === "inert") {expectedCaptureCount = 1;}
    else if (["history", "local-state"].includes(mode)) {expectedCaptureCount = 3;}
    expect(capture).toHaveBeenCalledTimes(expectedCaptureCount);
  },
);

it("returns only navigation screenshot artifacts and no instant-navigation claims", () => {
  const portable = sandboxCandidateNavigation();
  expect(portable.artifactPaths).toEqual(["documentation.png", "back.png", "forward.png"]);
  expect(portable.script).toContain('requirementId: "navigation-continuity"');
});

it("keeps shared-layout state unassessed and failed probe diagnostics linked", () => {
  const receipt = candidateNavigationReceipt(null);
  expect(receipt.observation.disposition).toBe("infrastructure-unavailable");
  expect(receipt.observation.artifacts).toEqual(["candidate-navigation.json"]);
  expect(receipt.observation.requirementId).toBe("navigation-continuity");
  expect(exerciseCandidateNavigation.toString()).not.toContain(
    'id: "shared-layout-state-preserved"',
  );
});
