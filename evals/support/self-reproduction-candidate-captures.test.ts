import { Script } from "node:vm";
import { expect, it, vi } from "vitest";
import { captureStates, desktopViewports } from "./self-reproduction-parity";
import { sandboxCandidateInteractionCaptures } from "./self-reproduction-candidate-captures";

it("covers existing desktop state combinations without phone or tablet captures", () => {
  const { artifactPaths } = sandboxCandidateInteractionCaptures();
  expect(artifactPaths).toEqual(
    desktopViewports.flatMap(({ name }) => captureStates.map((state) => `${name}/${state}.png`)),
  );
  expect(new Set(artifactPaths).size).toBe(15);
});

it("emits syntactically executable portable code with conservative transient evidence", () => {
  const { script } = sandboxCandidateInteractionCaptures();
  const body = script.replaceAll(/^import .*;$/gmu, "");
  expect(() => new Script(`(async function() {${body}})`)).not.toThrow();
  expect(script).toContain("'not-run'");
  expect(script).toContain("'missing-functionality' : 'not-run'");
  expect(script).not.toContain("manualCompletion.click");
  expect(script).not.toContain("page.setViewportSize");
});

it("waits for hydrated product controls before classifying an unknown candidate", () => {
  const { script } = sandboxCandidateInteractionCaptures();
  expect(script.indexOf("docs.waitFor")).toBeLessThan(script.indexOf("const known ="));
  expect(script).toContain("state: 'visible', timeout: 5000");
  expect(script).not.toContain("waitForTimeout");
});

async function exerciseState(
  state: "empty" | "loading" | "error",
  mutation: boolean,
  known = true,
  boundMutation = true,
) {
  const { script } = sandboxCandidateInteractionCaptures();
  let brief = "Create a useful synthetic task tracking application.";
  let stage = "draft";
  let interceptor: ((route: unknown) => Promise<void>) | undefined;
  const abort = vi.fn(() => Promise.resolve());
  const unroute = vi.fn(() => Promise.resolve());
  const shots: { brief: string; stage: string }[] = [];
  const outputs: string[] = [];
  const locator = (name: string) => ({
    count: () => Promise.resolve(known ? 1 : 0),
    waitFor: () => Promise.resolve(),
    inputValue: () => Promise.resolve(brief),
    fill: (value: string) => {
      brief = value;
      return Promise.resolve();
    },
    getAttribute: () => Promise.resolve("Describe the people, workflow, and outcome"),
    isDisabled: () => Promise.resolve(brief.length === 0),
    isEnabled: () => Promise.resolve(brief.length > 0),
    isVisible: () =>
      Promise.resolve(
        name === "Approve and create"
          ? stage === "review"
          : name === "Creating private preview" || name === "Finish preview"
            ? stage === "creating"
            : true,
      ),
    click: async () => {
      if (name === "Continue to review") stage = "review";
      if (name === "Approve and create") {
        stage = "creating";
        if (mutation)
          await interceptor?.({
            request: () => ({
              url: () => "http://localhost/create",
              resourceType: () => "fetch",
              method: () => "POST",
            }),
            abort,
            continue: () => Promise.resolve(),
          });
      }
    },
    first: () => locator(name),
  });
  const page = {
    goto: () => Promise.resolve({ status: () => 200 }),
    getByRole: (_role: string, options: { name: string }) => locator(options.name),
    getByText: (name: string) => locator(name),
    route: (_pattern: string, handler: typeof interceptor) => {
      interceptor = handler;
      return Promise.resolve();
    },
    unroute,
    screenshot: () => {
      shots.push({ brief, stage });
      return Promise.resolve();
    },
  };
  const body = script
    .replaceAll(/^import .*;$/gmu, "")
    .replace(
      `for (const state of ${JSON.stringify(captureStates)})`,
      `for (const state of ["${state}"])`,
    );
  await new Script(`(async function() {${body}})()`).runInNewContext({
    URL,
    readFile: () =>
      Promise.resolve(
        JSON.stringify({
          baseURL: "http://localhost",
          creationMutation: boundMutation ? { pathname: "/create", method: "POST" } : undefined,
        }),
      ),
    writeFile: (_path: string, value: string) => {
      outputs.push(value);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    dirname: () => "/artifacts",
    join: (...parts: string[]) => parts.join("/"),
    process: { argv: ["node", "runner", "input", "output"] },
    chromium: {
      launch: () =>
        Promise.resolve({
          newContext: () =>
            Promise.resolve({
              newPage: () => Promise.resolve(page),
              close: () => Promise.resolve(),
            }),
          close: () => Promise.resolve(),
        }),
    },
  });
  return { observations: JSON.parse(outputs.at(-1)!).observations, shots, abort, unroute };
}

it("captures the actual empty brief before refilling and advancing review", async () => {
  const result = await exerciseState("empty", false);
  expect(result.shots.every((shot) => shot.brief === "")).toBe(true);
  expect(result.observations).toHaveLength(desktopViewports.length);
  expect(
    result.observations.every(
      (row: { disposition: string; assertions: { passed: boolean }[] }) =>
        row.disposition === "observed" && row.assertions.every((assertion) => assertion.passed),
    ),
  ).toBe(true);
});

it("does not grant loading credit to a static creating label without an actual held mutation", async () => {
  const result = await exerciseState("loading", false);
  expect(
    result.observations.every(
      (row: { disposition: string; assertions: unknown[] }) =>
        row.disposition === "not-run" && row.assertions.length === 0,
    ),
  ).toBe(true);
  expect(result.unroute).toHaveBeenCalledTimes(desktopViewports.length);
});

it("records an actual held mutation and aborts each request during cleanup", async () => {
  const result = await exerciseState("loading", true);
  expect(
    result.observations.every(
      (row: { disposition: string; assertions: { passed: boolean }[] }) =>
        row.disposition === "observed" && row.assertions.every((assertion) => assertion.passed),
    ),
  ).toBe(true);
  expect(result.abort).toHaveBeenCalledTimes(desktopViewports.length);
  expect(result.unroute).toHaveBeenCalledTimes(desktopViewports.length);
});

it("keeps unknown shapes and unbound error fixtures unassessed", async () => {
  const unknown = await exerciseState("empty", false, false);
  const error = await exerciseState("error", false);
  expect(
    [...unknown.observations, ...error.observations].every((row) => row.disposition === "not-run"),
  ).toBe(true);
});

it("does not mistake an unbound POST for the creation operation", async () => {
  const result = await exerciseState("loading", true, true, false);
  expect(
    result.observations.every((row: { disposition: string }) => row.disposition === "not-run"),
  ).toBe(true);
  expect(result.abort).not.toHaveBeenCalled();
});
