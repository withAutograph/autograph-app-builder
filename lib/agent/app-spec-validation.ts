import { z } from "zod";

/** Suggested authoring outline; section names and order are not acceptance requirements. */
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

export const BUILD_READY_HANDOFF_EXAMPLE = { status: "build-ready" } as const;

// Extra prose metadata is not execution authority and is not consumed.
export const buildReadyHandoffSchema = z.object({ status: z.literal("build-ready") });

export interface AppSpecValidationIssue {
  code: "build_ready_intent";
  message: string;
}
export type AppSpecValidationResult =
  | { valid: true }
  | { valid: false; issues: AppSpecValidationIssue[] };

const declaredReadiness = (lines: readonly string[]): boolean | undefined => {
  try {
    const parsed: unknown = JSON.parse(lines.join("\n"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.hasOwn(parsed, "status")
    ) {
      return buildReadyHandoffSchema.safeParse(parsed).success;
    }
  } catch {
    // Unparseable prose is not an explicit typed readiness declaration.
  }
  return undefined;
};

/** Share explicit intent recognition between inline and streamed artifacts. */
export const createBuildReadyAppSpecScanner = () => {
  let fence: { marker: string; json: boolean } | undefined;
  let body: string[] = [];
  let ready = false;
  return {
    consumeLine(rawLine: string) {
      const line = rawLine.replace(/\r$/u, "");
      const marker = /^[ \t]*(?<marker>`{3,}|~{3,})(?<info>.*)$/u.exec(line)?.groups;
      if (fence === undefined) {
        if (marker?.marker !== undefined) {
          fence = { marker: marker.marker, json: marker.info?.trim().toLowerCase() === "json" };
        }
        return;
      }
      if (
        marker?.marker !== undefined &&
        marker.info?.trim() === "" &&
        marker.marker.startsWith(fence.marker.charAt(0)) &&
        marker.marker.length >= fence.marker.length
      ) {
        if (fence.json) {
          // A later draft/other explicit status supersedes an earlier ready example.
          ready = declaredReadiness(body) ?? ready;
        }
        body = [];
        fence = undefined;
        return;
      }
      if (fence.json) body.push(line);
    },
    result(): AppSpecValidationResult {
      return ready
        ? { valid: true }
        : {
            valid: false,
            issues: [
              {
                code: "build_ready_intent",
                message:
                  "Declare explicit build-ready intent in a JSON fenced block with status build-ready. A later draft status keeps the artifact in planning.",
              },
            ],
          };
    },
  };
};

/** Keep authored bytes and product requirements intact; accepted snapshots are never rewritten. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function normalizeBuildReadyAppSpec(content: string): string {
  return content;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function validateBuildReadyAppSpec(content: string): AppSpecValidationResult {
  const scanner = createBuildReadyAppSpecScanner();
  for (const line of content.split(/\r\n?|\n/u)) scanner.consumeLine(line);
  return scanner.result();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function appSpecRepairDiagnostic(
  result: Extract<AppSpecValidationResult, { valid: false }>,
): string {
  return JSON.stringify({
    buildHandoffExample: BUILD_READY_HANDOFF_EXAMPLE,
    code: "app_spec_invalid",
    instruction:
      "Record the intended readiness in the complete Markdown artifact, then retry accept_app_spec without asking the user. Section names and formatting are advisory.",
    issues: result.issues,
  });
}
