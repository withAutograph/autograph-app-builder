import { Script } from "node:vm";
import { expect, it } from "vitest";
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
  expect(script).not.toContain("Finish preview");
  expect(script).not.toContain("page.setViewportSize");
});
