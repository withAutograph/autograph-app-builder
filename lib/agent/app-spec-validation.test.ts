import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { HOSTED_MANAGED_SKILL_CONTENTS } from "../sandbox/hosted-managed-seeds.generated";

import {
  appSpecRepairDiagnostic,
  BUILD_READY_HANDOFF_EXAMPLE,
  normalizeBuildReadyAppSpec,
  REQUIRED_APP_SPEC_HEADINGS,
  validateBuildReadyAppSpec,
} from "./app-spec-validation";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function completeAppSpec(handoff: unknown = BUILD_READY_HANDOFF_EXAMPLE): string {
  return `${REQUIRED_APP_SPEC_HEADINGS.filter((heading) => heading !== "Build handoff")
    .map((heading) => `## ${heading}\n\nProduct decision.`)
    .join("\n\n")}\n\n## Build handoff\n\n\`\`\`json\n${JSON.stringify(handoff, null, 2)}\n\`\`\``;
}

describe("build-ready AppSpec validation", () => {
  it("accepts the complete closed handoff contract", () => {
    expect(validateBuildReadyAppSpec(completeAppSpec())).toEqual({
      valid: true,
    });
  });

  it("ships one complete canonical authoring skeleton that passes on its first attempt", () => {
    const reference = readFileSync(
      new URL("../../agent/skills/design-app/references/app-spec.md", import.meta.url),
      "utf-8",
    );
    const bundled = HOSTED_MANAGED_SKILL_CONTENTS.find(
      (file) => file.path === "design-app/references/app-spec.md",
    );
    expect(bundled?.content).toBe(reference);
    const templates = [...reference.matchAll(/````markdown\n(?<template>[\s\S]*?)\n````/gu)];
    expect(templates).toHaveLength(1);
    const authored = templates[0]?.groups?.template;
    if (authored === undefined) {
      throw new Error("Expected the canonical authoring template.");
    }
    // Test the bytes shown to the model, before acceptance normalization.
    expect(validateBuildReadyAppSpec(authored)).toEqual({ valid: true });
    expect(authored.match(/^## .+$/gmu)).toEqual(
      REQUIRED_APP_SPEC_HEADINGS.map((heading) => `## ${heading}`),
    );
    expect(authored).toMatch(/\n## Build handoff\n\n```json\n[\s\S]*\n```$/u);
  });

  it.each(REQUIRED_APP_SPEC_HEADINGS)("still rejects an omitted %s section", (heading) => {
    const content = completeAppSpec().replace(`## ${heading}\n`, "");
    expect(validateBuildReadyAppSpec(content)).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "missing_heading", path: heading }),
      ]),
      valid: false,
    });
  });

  it.each(["owner", "schema", "additionalPublicRoutes", "optionalCapabilities"])(
    "rejects unused %s metadata in a new handoff",
    (field) => {
      expect(
        validateBuildReadyAppSpec(
          completeAppSpec({
            ...BUILD_READY_HANDOFF_EXAMPLE,
            [field]: "unused",
          }),
        ),
      ).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "build_handoff_shape", path: "Build handoff" }),
        ]),
        valid: false,
      });
    },
  );

  it("preserves provider choices, data needs, and approval decisions in product prose", () => {
    const authored = completeAppSpec()
      .replace(
        "## Integrations and reconciliation\n\nProduct decision.",
        "## Integrations and reconciliation\n\nGitHub owns repository history; Vercel owns preview deployment status. Publication requires separate approval.",
      )
      .replace(
        "## Data model\n\nProduct decision.",
        "## Data model\n\nThe operations team owns release decisions and their immutable evidence timestamps.",
      );
    expect(validateBuildReadyAppSpec(authored)).toEqual({ valid: true });
    expect(normalizeBuildReadyAppSpec(authored)).toBe(authored);
  });

  it.each([
    ["without a blank line", "## Build handoff\n```json"],
    ["with extra blank lines", "## Build handoff\n\n\n```json"],
    ["with an uppercase fence language", "## Build handoff\n\n```JSON"],
  ])("accepts harmless handoff Markdown %s", (_label, headingAndFence) => {
    expect(
      validateBuildReadyAppSpec(
        completeAppSpec().replace("## Build handoff\n\n```json", headingAndFence),
      ),
    ).toEqual({ valid: true });
  });

  it("accepts CRLF and trailing whitespace", () => {
    expect(
      validateBuildReadyAppSpec(`${completeAppSpec().replaceAll("\n", "\r\n")}\r\n  `),
    ).toEqual({ valid: true });
  });

  it("normalizes an unaccepted draft to status-only without changing its product prose", () => {
    const draft = completeAppSpec({
      additionalPublicRoutes: ["/review"],
      optionalCapabilities: { hostedResources: [], integrations: ["source-control"] },
      owner: "operations",
      schema: { kind: "kernel" },
      status: "ready",
    });
    const normalized = normalizeBuildReadyAppSpec(draft);

    expect(validateBuildReadyAppSpec(normalized)).toEqual({ valid: true });
    expect(normalized).toBe(completeAppSpec());
    expect(normalizeBuildReadyAppSpec(normalized)).toBe(normalized);
    expect(draft).toContain('"owner": "operations"');
  });

  it.each([{ value: null }, { value: [] }, { value: "ready" }, { value: true }])(
    "does not turn non-object $value into a ready handoff",
    ({ value }) => {
      const draft = completeAppSpec(value);
      expect(normalizeBuildReadyAppSpec(draft)).toBe(draft);
      expect(validateBuildReadyAppSpec(draft).valid).toBe(false);
    },
  );

  it.each([
    ["trailing prose", `${completeAppSpec()}\nnot part of the handoff`],
    ["wrong fence language", completeAppSpec().replace("```json", "```yaml")],
  ])("rejects %s after the terminal handoff", (_label, content) => {
    expect(validateBuildReadyAppSpec(content)).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: "build_handoff_format" })]),
      valid: false,
    });
  });

  it("returns exact repair instructions for missing sections and handoff", () => {
    const result = validateBuildReadyAppSpec("## Status and prototype\n\nA first prototype.");
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("expected invalid AppSpec");
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_heading",
          message: 'Add exactly one "## User and outcome" section.',
          path: "User and outcome",
        }),
        expect.objectContaining({
          code: "build_handoff_format",
          path: "Build handoff",
        }),
      ]),
    );
    const diagnostic = JSON.parse(appSpecRepairDiagnostic(result)) as {
      code: string;
      instruction: string;
      requiredHeadings: string[];
      buildHandoffExample: unknown;
    };
    expect(diagnostic).toMatchObject({
      buildHandoffExample: BUILD_READY_HANDOFF_EXAMPLE,
      code: "app_spec_invalid",
      instruction: expect.stringContaining("without asking the user"),
    });
    expect(diagnostic.requiredHeadings).toHaveLength(14);
  });

  it("identifies malformed JSON and closed-shape errors without raw content", () => {
    const malformed = completeAppSpec().replace(
      JSON.stringify(BUILD_READY_HANDOFF_EXAMPLE, null, 2),
      "{ invalid",
    );
    expect(validateBuildReadyAppSpec(malformed)).toMatchObject({
      issues: [{ code: "build_handoff_json", path: "Build handoff" }],
      valid: false,
    });

    const extra = completeAppSpec({
      ...BUILD_READY_HANDOFF_EXAMPLE,
      status: "ready",
      unexpected: "private-value",
    });
    const result = validateBuildReadyAppSpec(extra);
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("expected invalid AppSpec");
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "build_handoff_shape",
          path: "Build handoff.status",
        }),
        expect.objectContaining({
          code: "build_handoff_shape",
          path: "Build handoff",
        }),
      ]),
    );
    expect(appSpecRepairDiagnostic(result)).not.toContain("private-value");
  });
});
