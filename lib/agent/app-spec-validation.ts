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

const capabilityId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const publicRoute = z
  .string()
  .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+(?:\*)?$/u);
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

export function validateBuildReadyAppSpec(
  content: string,
): AppSpecValidationResult {
  const issues: AppSpecValidationIssue[] = [];
  for (const heading of REQUIRED_APP_SPEC_HEADINGS) {
    const count =
      content.match(new RegExp(`^## ${heading}$`, "gmu"))?.length ?? 0;
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

  const block =
    /(?:^|\n)## Build handoff\n\n```json\n([\s\S]*?)\n```\s*$/u.exec(content);
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
