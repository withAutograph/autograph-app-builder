import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { generateText, tool } from "ai";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  REQUIRED_APP_SPEC_HEADINGS,
  validateBuildReadyAppSpec,
} from "../lib/agent/app-spec-validation";

const optIn = process.env.APP_BUILDER_G2_MODEL_EVAL === "1";
const modelId = process.env.APP_BUILDER_G2_MODEL_ID;
const repositoryRoot = nodePath.resolve(import.meta.dirname, "..");

// Explicit live invocation (never part of the default unit-test task):
// APP_BUILDER_G2_MODEL_EVAL=1 APP_BUILDER_G2_MODEL_ID=provider/model mise exec -- node node_modules/vitest/vitest.mjs run evals/g2-provider-brief-first-attempt.model.test.ts --config evals/g2-model.vitest.config.mts
const productBrief = `Build an internal release-readiness workspace for product and engineering leads. It reads pull-request and check status from GitHub and deployment status from Vercel, then shows one release queue with the current commit, blocking checks, preview status, production status, and a human-owned readiness decision. Version one is read-only: it must not merge, deploy, promote, retry, or change provider configuration. Use a tenant-scoped authenticated workspace. The reviewed prototype is prototype/release-readiness/index.html and includes a queue, a selected-release detail panel, loading and empty states, stale-data warnings, provider-error states, and evidence timestamps.`;

const recordPrototypeArtifactInput = z
  .object({
    content: z.string().min(1),
    mediaType: z.literal("text/markdown"),
    path: z.literal("prototype/release-readiness/app-spec.md"),
  })
  .strict();

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function productionAppSpecInstructions(): Promise<string> {
  const paths = [
    "agent/instructions.md",
    "agent/skills/design-app/SKILL.md",
    "agent/skills/design-app/references/app-spec.md",
  ];
  const contents = await Promise.all(
    paths.map((path) => readFile(nodePath.resolve(repositoryRoot, path), "utf-8")),
  );
  return contents.join("\n\n");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function terminalBuildHandoff(raw: string): {
  integrations: string[];
  hostedResources: string[];
} {
  const match = /\n## Build handoff\n\n```json\n(?<handoff>[\s\S]+)\n```\s*$/u.exec(raw);
  expect(match, "raw output ends with the exact Build handoff block").not.toBeNull();
  const parsed = JSON.parse(match?.groups?.handoff ?? "null") as {
    optionalCapabilities?: {
      integrations?: unknown;
      hostedResources?: unknown;
    };
  };
  expect(parsed.optionalCapabilities?.integrations).toEqual(expect.any(Array));
  expect(parsed.optionalCapabilities?.hostedResources).toEqual(expect.any(Array));
  return {
    hostedResources: parsed.optionalCapabilities?.hostedResources as string[],
    integrations: parsed.optionalCapabilities?.integrations as string[],
  };
}

describe.skipIf(!optIn)("G2 provider-named product brief", () => {
  test("authors a valid provider-neutral AppSpec on the first model attempt", async () => {
    if (modelId === undefined || modelId.length === 0) {
      throw new Error("Set APP_BUILDER_G2_MODEL_ID when APP_BUILDER_G2_MODEL_EVAL=1.");
    }

    const { steps, toolCalls } = await generateText({
      instructions: await productionAppSpecInstructions(),
      maxOutputTokens: 8000,
      maxRetries: 0,
      model: modelId,
      prompt: `Author and record the complete build-ready AppSpec for this product brief in one attempt.

Use the production authoring guidance supplied above. Record one AppSpec artifact for the reviewed prototype.

Product brief:
${productBrief}`,
      toolChoice: {
        toolName: "record-prototype-artifact",
        type: "tool",
      },
      tools: {
        "record-prototype-artifact": tool({
          description:
            "Record one complete internal planning artifact without changing a repository or provider.",
          inputSchema: recordPrototypeArtifactInput,
          strict: true,
        }),
      },
    });

    expect(steps).toHaveLength(1);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("record-prototype-artifact");
    const artifact = recordPrototypeArtifactInput.parse(toolCalls[0]?.input);
    expect(artifact).toMatchObject({
      mediaType: "text/markdown",
      path: "prototype/release-readiness/app-spec.md",
    });
    const rawFirstOutput = artifact.content;
    expect(validateBuildReadyAppSpec(rawFirstOutput)).toEqual({ valid: true });

    const headings = [...rawFirstOutput.matchAll(/^## (?<heading>.+)$/gmu)].map((match) => {
      const heading = match.groups?.heading;
      if (heading === undefined) {
        throw new Error("Expected every matched heading to have a name.");
      }
      return heading;
    });
    expect(headings).toEqual(REQUIRED_APP_SPEC_HEADINGS);

    const capabilities = terminalBuildHandoff(rawFirstOutput);
    expect(capabilities.integrations.length).toBeGreaterThanOrEqual(2);
    expect([...capabilities.integrations, ...capabilities.hostedResources]).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/github|vercel/iu)]),
    );
    const productProse = rawFirstOutput.slice(0, rawFirstOutput.lastIndexOf("## Build handoff"));
    expect(productProse).toMatch(/\bGitHub\b/u);
    expect(productProse).toMatch(/\bVercel\b/u);
    expect(rawFirstOutput).not.toMatch(
      /(?:connected|authenticated|verified|fetched) (?:from|against|with) (?:GitHub|Vercel)/iu,
    );
  }, 120_000);
});
