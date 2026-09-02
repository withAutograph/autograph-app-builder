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
  owner: "product-operations",
  schema: { kind: "none" },
  additionalPublicRoutes: [],
  optionalCapabilities: { integrations: [], hostedResources: [] },
} as const;

const capabilityIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const publicRoutePattern = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+(?:\*)?$/u;
const capabilityId = z.string().regex(capabilityIdPattern);
const publicRoute = z.string().regex(publicRoutePattern);
const sortedUnique = <T extends z.ZodType<string>>(item: T) =>
  z.array(item).superRefine((values, context) => {
    const sorted = [...values].sort();
    if (
      new Set(values).size !== values.length ||
      values.some((value, index) => value !== sorted[index])
    )
      context.addIssue({
        code: "custom",
        message: "Values must be sorted and contain no duplicates.",
      });
  });

export const buildReadyHandoffSchema = z
  .object({
    status: z.literal("build-ready"),
    owner: z.string().trim().min(1),
    schema: z.object({ kind: z.enum(["none", "kernel"]) }).strict(),
    additionalPublicRoutes: sortedUnique(publicRoute),
    optionalCapabilities: z
      .object({
        integrations: sortedUnique(capabilityId),
        hostedResources: sortedUnique(capabilityId),
      })
      .strict(),
  })
  .strict();

export type AppSpecValidationIssue = {
  code:
    | "missing_heading"
    | "duplicate_heading"
    | "build_handoff_format"
    | "build_handoff_json"
    | "build_handoff_shape";
  message: string;
  path?: string;
};

export type AppSpecValidationResult =
  { valid: true } | { valid: false; issues: AppSpecValidationIssue[] };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedStrings(value: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is string =>
          typeof item === "string" && pattern.test(item),
      ),
    ),
  ].sort();
}

/**
 * Canonicalizes the machine-only tail of an otherwise authored product brief.
 * The agent should not spend turns repairing ordering, unknown keys, or a
 * mechanical enum that the builder can resolve deterministically.
 */
export function normalizeBuildReadyAppSpec(content: string): string {
  const normalizedContent = content.replace(/\r\n?/gu, "\n");
  const heading = /^## Build handoff[ \t]*$/mu.exec(normalizedContent);
  if (heading === null) return normalizedContent;
  const section = normalizedContent.slice(heading.index + heading[0].length);
  const block = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/iu.exec(section);
  if (block?.[1] === undefined) return normalizedContent;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1]);
  } catch {
    return normalizedContent;
  }
  const input = record(parsed);
  const schema = record(input.schema);
  const capabilities = record(input.optionalCapabilities);
  const owner =
    typeof input.owner === "string" && input.owner.trim().length > 0
      ? input.owner.trim()
      : BUILD_READY_HANDOFF_EXAMPLE.owner;
  const canonical = {
    status: "build-ready" as const,
    owner,
    schema: {
      kind: schema.kind === "none" ? ("none" as const) : ("kernel" as const),
    },
    additionalPublicRoutes: normalizedStrings(
      input.additionalPublicRoutes,
      publicRoutePattern,
    ),
    optionalCapabilities: {
      integrations: normalizedStrings(
        capabilities.integrations,
        capabilityIdPattern,
      ),
      hostedResources: normalizedStrings(
        capabilities.hostedResources,
        capabilityIdPattern,
      ),
    },
  };
  const prefix = normalizedContent.slice(0, heading.index).trimEnd();
  return `${prefix}\n\n## Build handoff\n\n\`\`\`json\n${JSON.stringify(canonical, null, 2)}\n\`\`\``;
}

export function validateBuildReadyAppSpec(
  content: string,
): AppSpecValidationResult {
  const normalizedContent = content.replace(/\r\n?/gu, "\n");
  const issues: AppSpecValidationIssue[] = [];
  for (const heading of REQUIRED_APP_SPEC_HEADINGS) {
    const count =
      normalizedContent.match(new RegExp(`^## ${heading}$`, "gmu"))?.length ??
      0;
    if (count === 0)
      issues.push({
        code: "missing_heading",
        path: heading,
        message: `Add exactly one "## ${heading}" section.`,
      });
    else if (count > 1)
      issues.push({
        code: "duplicate_heading",
        path: heading,
        message: `Keep exactly one "## ${heading}" section.`,
      });
  }

  const handoffHeading = /(?:^|\n)## Build handoff[ \t]*(?:\r?\n)/u.exec(
    normalizedContent,
  );
  const handoffSection =
    handoffHeading === null
      ? undefined
      : normalizedContent
          .slice(handoffHeading.index + handoffHeading[0].length)
          .trim();
  const block =
    handoffSection === undefined
      ? null
      : /^[ \t]*```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/iu.exec(
          handoffSection,
        );
  if (block?.[1] === undefined) {
    issues.push({
      code: "build_handoff_format",
      path: "Build handoff",
      message:
        "End the document with the exact Build handoff heading, one blank line, and one json fenced block.",
    });
    return { valid: false, issues };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1]);
  } catch {
    issues.push({
      code: "build_handoff_json",
      path: "Build handoff",
      message: "Make the Build handoff fenced block valid JSON.",
    });
    return { valid: false, issues };
  }
  const handoff = buildReadyHandoffSchema.safeParse(parsed);
  if (!handoff.success)
    for (const issue of handoff.error.issues)
      issues.push({
        code: "build_handoff_shape",
        path: ["Build handoff", ...issue.path].join("."),
        message: issue.message,
      });

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

export function appSpecRepairDiagnostic(
  result: Extract<AppSpecValidationResult, { valid: false }>,
): string {
  return JSON.stringify({
    code: "app_spec_invalid",
    instruction:
      "Repair and replace the complete Markdown artifact, then retry accept_app_spec without asking the user.",
    issues: result.issues,
    requiredHeadings: REQUIRED_APP_SPEC_HEADINGS.map(
      (heading) => `## ${heading}`,
    ),
    buildHandoffExample: BUILD_READY_HANDOFF_EXAMPLE,
  });
}
