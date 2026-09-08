import { describe, expect, it } from "vitest";

import {
  appSpecRepairDiagnostic,
  BUILD_READY_HANDOFF_EXAMPLE,
  normalizeBuildReadyAppSpec,
  REQUIRED_APP_SPEC_HEADINGS,
  validateBuildReadyAppSpec,
} from "./app-spec-validation";

function completeAppSpec(
  handoff: unknown = BUILD_READY_HANDOFF_EXAMPLE,
): string {
  return `${REQUIRED_APP_SPEC_HEADINGS.filter(
    (heading) => heading !== "Build handoff",
  )
    .map((heading) => `## ${heading}\n\nProduct decision.`)
    .join("\n\n")}\n\n## Build handoff\n\n\`\`\`json\n${JSON.stringify(
    handoff,
    null,
    2,
  )}\n\`\`\``;
}

describe("build-ready AppSpec validation", () => {
  it("accepts the complete closed handoff contract", () => {
    expect(validateBuildReadyAppSpec(completeAppSpec())).toEqual({
      valid: true,
    });
  });

  it.each([
    ["without a blank line", "## Build handoff\n```json"],
    ["with extra blank lines", "## Build handoff\n\n\n```json"],
    ["with an uppercase fence language", "## Build handoff\n\n```JSON"],
  ])("accepts harmless handoff Markdown %s", (_label, headingAndFence) => {
    expect(
      validateBuildReadyAppSpec(
        completeAppSpec().replace(
          "## Build handoff\n\n```json",
          headingAndFence,
        ),
      ),
    ).toEqual({ valid: true });
  });

  it("accepts CRLF and trailing whitespace", () => {
    expect(
      validateBuildReadyAppSpec(
        `${completeAppSpec().replaceAll("\n", "\r\n")}\r\n  `,
      ),
    ).toEqual({ valid: true });
  });

  it("normalizes mechanical handoff drift before validation", () => {
    const normalized = normalizeBuildReadyAppSpec(
      completeAppSpec({
        status: "ready",
        owner: " operations ",
        schema: { kind: "operational", entities: ["exception"] },
        additionalPublicRoutes: ["/z", "/bad/[id]", "/a", "/a"],
        optionalCapabilities: {
          integrations: ["inventory-sync", "inventory-sync", "Bad"],
          hostedResources: ["relational-database"],
        },
        ignored: true,
      }),
    );

    expect(validateBuildReadyAppSpec(normalized)).toEqual({ valid: true });
    expect(normalized).toContain('"kind": "kernel"');
    expect(normalized).not.toContain("entities");
    expect(normalized).not.toContain("/bad/[id]");
    expect(normalized.indexOf('"/a"')).toBeLessThan(normalized.indexOf('"/z"'));
  });

  it.each([
    ["trailing prose", `${completeAppSpec()}\nnot part of the handoff`],
    ["wrong fence language", completeAppSpec().replace("```json", "```yaml")],
  ])("rejects %s after the terminal handoff", (_label, content) => {
    expect(validateBuildReadyAppSpec(content)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "build_handoff_format" }),
      ]),
    });
  });

  it("returns exact repair instructions for missing sections and handoff", () => {
    const result = validateBuildReadyAppSpec(
      "## Status and prototype\n\nA first prototype.",
    );
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid AppSpec");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_heading",
          path: "User and outcome",
          message: 'Add exactly one "## User and outcome" section.',
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
      code: "app_spec_invalid",
      instruction: expect.stringContaining("without asking the user"),
      buildHandoffExample: BUILD_READY_HANDOFF_EXAMPLE,
    });
    expect(diagnostic.requiredHeadings).toHaveLength(14);
  });

  it("identifies malformed JSON and closed-shape errors without raw content", () => {
    const malformed = completeAppSpec().replace(
      JSON.stringify(BUILD_READY_HANDOFF_EXAMPLE, null, 2),
      "{ invalid",
    );
    expect(validateBuildReadyAppSpec(malformed)).toMatchObject({
      valid: false,
      issues: [{ code: "build_handoff_json", path: "Build handoff" }],
    });

    const extra = completeAppSpec({
      ...BUILD_READY_HANDOFF_EXAMPLE,
      additionalPublicRoutes: ["/z", "/a", "/a"],
      unexpected: "private-value",
    });
    const result = validateBuildReadyAppSpec(extra);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid AppSpec");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "build_handoff_shape",
          path: "Build handoff.additionalPublicRoutes",
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
