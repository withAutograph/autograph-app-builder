import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { generateText, tool } from "ai";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  REQUIRED_APP_SPEC_HEADINGS,
  validateBuildReadyAppSpec,
} from "../lib/agent/app-spec-validation";

const optIn = process.env.APP_BUILDER_G2_MODEL_EVAL === "1";
const modelId = process.env.APP_BUILDER_G2_MODEL_ID;
const repositoryRoot = resolve(import.meta.dirname, "..");

// Explicit live invocation (never part of the default unit-test task):
// APP_BUILDER_G2_MODEL_EVAL=1 APP_BUILDER_G2_MODEL_ID=provider/model mise exec -- node node_modules/vitest/vitest.mjs run evals/g2-provider-brief-first-attempt.model.test.ts --config evals/g2-model.vitest.config.mts
const productBrief = `Build an internal release-readiness workspace for product and engineering leads. It reads pull-request and check status from GitHub and deployment status from Vercel, then shows one release queue with the current commit, blocking checks, preview status, production status, and a human-owned readiness decision. Version one is read-only: it must not merge, deploy, promote, retry, or change provider configuration. Use a tenant-scoped authenticated workspace. The reviewed prototype is prototype/release-readiness/index.html and includes a queue, a selected-release detail panel, loading and empty states, stale-data warnings, provider-error states, and evidence timestamps.`;

const recordPrototypeArtifactInput = z
  .object({
    path: z.literal("prototype/release-readiness/app-spec.md"),
    mediaType: z.literal("text/markdown"),
    content: z.string().min(1),
  })
  .strict();

async function productionAppSpecInstructions(): Promise<string> {
  const paths = [
    "agent/instructions.md",
    "agent/skills/design-app/SKILL.md",
    "agent/skills/design-app/references/app-spec.md",
  ];
  const contents = await Promise.all(
    paths.map((path) => readFile(resolve(repositoryRoot, path), "utf-8")),
  );
  return contents.join("\n\n");
}

function terminalBuildHandoff(raw: string): {
  integrations: string[];
  hostedResources: string[];
} {
  const match = /\n## Build handoff\n\n```json\n([\s\S]+)\n```\s*$/u.exec(raw);
  expect(match, "raw output ends with the exact Build handoff block").not.toBeNull();
  const parsed = JSON.parse(match?.[1] ?? "null") as {
    optionalCapabilities?: {
      integrations?: unknown;
      hostedResources?: unknown;
    };
  };
  expect(parsed.optionalCapabilities?.integrations).toEqual(expect.any(Array));
  expect(parsed.optionalCapabilities?.hostedResources).toEqual(expect.any(Array));
  return {
    integrations: parsed.optionalCapabilities?.integrations as string[],
    hostedResources: parsed.optionalCapabilities?.hostedResources as string[],
  };
}

describe.skipIf(!optIn)("G2 provider-named product brief", () => {
  test("authors a valid provider-neutral AppSpec on the first model attempt", async () => {
    if (modelId === undefined || modelId.length === 0) {
      throw new Error("Set APP_BUILDER_G2_MODEL_ID when APP_BUILDER_G2_MODEL_EVAL=1.");
    }

    const { steps, toolCalls } = await generateText({
      model: modelId,
      maxRetries: 0,
      maxOutputTokens: 8000,
      system: await productionAppSpecInstructions(),
      tools: {
        record_prototype_artifact: tool({
          description:
            "Record one complete internal planning artifact without changing a repository or provider.",
          inputSchema: recordPrototypeArtifactInput,
          strict: true,
        }),
      },
      toolChoice: {
        type: "tool",
        toolName: "record_prototype_artifact",
      },
      prompt: `Author and record the complete build-ready AppSpec for this product brief in one attempt.

Use the production authoring guidance supplied above. Record one AppSpec artifact for the reviewed prototype.

Product brief:
${productBrief}`,
    });

    expect(steps).toHaveLength(1);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("record_prototype_artifact");
    const artifact = recordPrototypeArtifactInput.parse(toolCalls[0]?.input);
    expect(artifact).toMatchObject({
      path: "prototype/release-readiness/app-spec.md",
      mediaType: "text/markdown",
    });
    const rawFirstOutput = artifact.content;
    expect(validateBuildReadyAppSpec(rawFirstOutput)).toEqual({ valid: true });

    const headings = [...rawFirstOutput.matchAll(/^## (.+)$/gmu)].map(([, heading]) => heading);
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
