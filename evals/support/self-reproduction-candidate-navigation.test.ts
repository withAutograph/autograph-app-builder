/* oxlint-disable eslint/require-await -- Browser doubles preserve asynchronous Playwright operations. */
import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import {
  exerciseCandidateNavigation,
  sandboxCandidateNavigation,
} from "./self-reproduction-candidate-navigation";

it.each(["history", "local-state", "unknown", "unavailable"])(
  "assesses %s navigation without custom back controls",
  async (mode) => {
    let view = "editor";
    const values = new Map<string, string>();
    const control = (name: string) => ({
      waitFor: async () => {
        if (mode === "unknown") throw new Error("Unknown controls");
      },
      fill: async (value: string) => {
        values.set(name, value);
      },
      inputValue: async () => values.get(name),
      focus: vi.fn(),
      press: async () => {
        view = "docs";
      },
      isVisible: async () => (name === "back" ? view === "docs" : view === "editor"),
      evaluate: async () => view === "editor" && mode === "history",
      first: () => control(name),
    });
    const page = {
      goto: async () => ({ ok: () => mode !== "unavailable" }),
      getByRole: (_role: string, options: { name: string | RegExp }) =>
        control(typeof options.name === "string" ? options.name : "back"),
      locator: () => ({
        first: () => ({
          elementHandle: async () => ({ evaluate: async () => mode === "history" }),
        }),
      }),
      url: () =>
        mode === "history" && view === "docs" ? "https://candidate/docs" : "https://candidate/",
      goBack: async () => {
        if (mode === "history") view = "editor";
      },
      goForward: async () => {
        view = "docs";
      },
    } as unknown as Page;
    const capture = vi.fn(async () => {});
    // oxlint-disable-next-line eslint/no-new-func -- Verify serialized portable function has no module closure dependencies.
    const portable = new Function(
      `return (${exerciseCandidateNavigation.toString()})`,
    )() as typeof exerciseCandidateNavigation;
    const result = await portable(page, "https://candidate/", capture);
    expect(result.disposition).toBe(
      {
        history: "observed",
        "local-state": "missing-functionality",
        unknown: "not-run",
        unavailable: "infrastructure-unavailable",
      }[mode],
    );
    if (mode === "history") expect(result.assertions.every(({ passed }) => passed)).toBe(true);
    if (mode === "local-state")
      expect(
        result.assertions.find(({ id }) => id === "back-forward-preserves-draft")?.passed,
      ).toBe(false);
    expect(capture).toHaveBeenCalledTimes(["history", "local-state"].includes(mode) ? 3 : 0);
  },
);

it("returns only navigation screenshot artifacts and no instant-navigation claims", () => {
  const portable = sandboxCandidateNavigation();
  expect(portable.artifactPaths).toEqual(["documentation.png", "back.png", "forward.png"]);
  expect(portable.script).toContain('requirementId: "navigation-continuity"');
});
