import { z } from "zod";

export const REQUIRED_APP_SPEC_HEADINGS = [
  "Status and prototype",
  "User and outcome",
  "Interfaces and navigation",
  "Controls and behavior",
  "Data model",
  "Integrations and reconciliation",
  "Temporal semantics",
  "Writes, review, and authority",
  "Access and tenancy",
  "Agent behavior",
  "Operational states",
  "Defaults, non-goals, and risks",
  "Acceptance walkthrough",
  "Build handoff",
] as const;

export const BUILD_READY_HANDOFF_EXAMPLE = {
  status: "build-ready",
} as const;

export const buildReadyHandoffSchema = z
  .object({
    status: z.literal("build-ready"),
  })
  .strict();

export interface AppSpecValidationIssue {
  code:
    | "missing_heading"
    | "duplicate_heading"
    | "build_handoff_format"
    | "build_handoff_json"
    | "build_handoff_shape";
  message: string;
  path?: string;
}

export type AppSpecValidationResult =
  | { valid: true }
  | { valid: false; issues: AppSpecValidationIssue[] };

/**
 * Canonicalizes a new draft's readiness marker before acceptance computes its
 * digest. Accepted snapshots retain their recorded bytes and are never migrated
 * through this function during a resume.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function normalizeBuildReadyAppSpec(content: string): string {
  const normalizedContent = content.replaceAll(/\r\n?/gu, "\n");
  const heading = /^## Build handoff[ \t]*$/mu.exec(normalizedContent);
  if (heading === null) {
    return normalizedContent;
  }
  const section = normalizedContent.slice(heading.index + heading[0].length);
  const block = /```json[ \t]*\n(?<content>[\s\S]*?)\n[ \t]*```/iu.exec(section);
  if (block?.[1] === undefined) {
    return normalizedContent;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1]);
  } catch {
    return normalizedContent;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return normalizedContent;
  }
  const canonical = BUILD_READY_HANDOFF_EXAMPLE;
  const prefix = normalizedContent.slice(0, heading.index).trimEnd();
  return `${prefix}\n\n## Build handoff\n\n\`\`\`json\n${JSON.stringify(canonical, null, 2)}\n\`\`\``;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function validateBuildReadyAppSpec(content: string): AppSpecValidationResult {
  const normalizedContent = content.replaceAll(/\r\n?/gu, "\n");
  const issues: AppSpecValidationIssue[] = [];
  for (const heading of REQUIRED_APP_SPEC_HEADINGS) {
    const count = normalizedContent.match(new RegExp(`^## ${heading}$`, "gmu"))?.length ?? 0;
    if (count === 0) {
      issues.push({
        code: "missing_heading",
        message: `Add exactly one "## ${heading}" section.`,
        path: heading,
      });
    } else if (count > 1) {
      issues.push({
        code: "duplicate_heading",
        message: `Keep exactly one "## ${heading}" section.`,
        path: heading,
      });
    }
  }

  const handoffHeading = /(?:^|\n)## Build handoff[ \t]*(?:\r?\n)/u.exec(normalizedContent);
  const handoffSection =
    handoffHeading === null
      ? undefined
      : normalizedContent.slice(handoffHeading.index + handoffHeading[0].length).trim();
  const block =
    handoffSection === undefined
      ? null
      : /^[ \t]*```json[ \t]*\r?\n(?<content>[\s\S]*?)\r?\n[ \t]*```[ \t]*$/iu.exec(handoffSection);
  if (block?.[1] === undefined) {
    issues.push({
      code: "build_handoff_format",
      message:
        "End the document with the exact Build handoff heading, one blank line, and one json fenced block.",
      path: "Build handoff",
    });
    return { issues, valid: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1]);
  } catch {
    issues.push({
      code: "build_handoff_json",
      message: "Make the Build handoff fenced block valid JSON.",
      path: "Build handoff",
    });
    return { issues, valid: false };
  }
  const handoff = buildReadyHandoffSchema.safeParse(parsed);
  if (!handoff.success) {
    for (const issue of handoff.error.issues) {
      issues.push({
        code: "build_handoff_shape",
        message: issue.message,
        path: ["Build handoff", ...issue.path].join("."),
      });
    }
  }

  return issues.length === 0 ? { valid: true } : { issues, valid: false };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function appSpecRepairDiagnostic(
  result: Extract<AppSpecValidationResult, { valid: false }>,
): string {
  return JSON.stringify({
    buildHandoffExample: BUILD_READY_HANDOFF_EXAMPLE,
    code: "app_spec_invalid",
    instruction:
      "Repair and replace the complete Markdown artifact, then retry accept_app_spec without asking the user.",
    issues: result.issues,
    requiredHeadings: REQUIRED_APP_SPEC_HEADINGS.map((heading) => `## ${heading}`),
  });
}
