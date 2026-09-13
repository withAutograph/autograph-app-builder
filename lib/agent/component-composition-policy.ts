import { createHash } from "node:crypto";

import { z } from "zod";

const identifier = z.string().regex(/^@autograph\/[A-Za-z0-9_./-]+$/u);
const relativePath = z
  .string()
  .regex(/^[A-Za-z0-9_./-]+(?:\.[A-Za-z0-9_-]+)?$/u)
  .refine((value) => !value.includes(".."), "Path must remain relative.");
const gitObject = z.string().regex(/^[a-f0-9]{40}$/u);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sortedUnique<T extends z.ZodType<string>>(item: T) {
  return z.array(item).superRefine((values, context) => {
    const sorted = [...values].toSorted();
    if (
      new Set(values).size !== values.length ||
      values.some((value, index) => value !== sorted[index])
    )
      context.addIssue({
        code: "custom",
        message: "Values must be sorted and contain no duplicates.",
      });
  });
}

/** The target-owned policy is copied into every source-bound apply overlay. */
export const ARRUSTED_COMPONENT_COMPOSITION_POLICY_PATH = "docs/component-composition.json";

export const arrustedComponentCompositionPolicySchema = z
  .object({
    kind: z.literal("arrusted-component-composition-v1"),
    providers: sortedUnique(identifier),
    publicImports: sortedUnique(identifier),
    routeGlue: z
      .object({
        allowedFiles: sortedUnique(relativePath),
        allowedStyleFiles: sortedUnique(relativePath),
      })
      .strict(),
    tokenEntrypoints: sortedUnique(identifier),
    version: z.literal(1),
  })
  .strict();

export type ArrustedComponentCompositionPolicy = z.infer<
  typeof arrustedComponentCompositionPolicySchema
>;

export interface BoundArrustedComponentCompositionPolicy {
  policy: ArrustedComponentCompositionPolicy;
  policyDigest: string;
  sourceSha: string;
  sourceTree: string;
}

export type CompositionPolicyResolution =
  | { status: "available"; binding: BoundArrustedComponentCompositionPolicy }
  | { status: "unavailable"; reasons: readonly string[] };

export interface CompositionViolation {
  code:
    | "unapproved-public-import"
    | "local-component-file"
    | "local-component-definition"
    | "unapproved-style-file"
    | "replacement-design-token"
    | "inline-visual-style";
  path: string;
  message: string;
}

export type AppliedAppCompositionResult =
  | {
      status: "passed";
      binding: BoundArrustedComponentCompositionPolicy;
      inspectedFiles: readonly string[];
    }
  | {
      status: "failed";
      binding: BoundArrustedComponentCompositionPolicy;
      inspectedFiles: readonly string[];
      violations: readonly CompositionViolation[];
    };

const digest = (content: string) => createHash("sha256").update(content).digest("hex");

/**
 * The manifest deliberately contains no source revision. A source tree cannot
 * contain its own final tree hash, so the evaluator creates this binding from
 * the exact source receipt selected for the current app build.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function bindArrustedComponentCompositionPolicy(input: {
  content: string | null;
  sourceSha: string;
  sourceTree: string;
}): CompositionPolicyResolution {
  if (!gitObject.safeParse(input.sourceSha).success)
    return {
      reasons: ["The selected source SHA is invalid."],
      status: "unavailable",
    };
  if (!gitObject.safeParse(input.sourceTree).success)
    return {
      reasons: ["The selected source tree is invalid."],
      status: "unavailable",
    };
  if (input.content === null)
    return {
      reasons: [
        `Missing ${ARRUSTED_COMPONENT_COMPOSITION_POLICY_PATH} in the selected Arrusted source.`,
      ],
      status: "unavailable",
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content) as unknown;
  } catch {
    return {
      reasons: ["The Arrusted component-composition manifest is not valid JSON."],
      status: "unavailable",
    };
  }
  const policy = arrustedComponentCompositionPolicySchema.safeParse(parsed);
  if (!policy.success)
    return {
      reasons: ["The Arrusted component-composition manifest is invalid."],
      status: "unavailable",
    };
  return {
    binding: {
      policy: policy.data,
      policyDigest: digest(input.content),
      sourceSha: input.sourceSha,
      sourceTree: input.sourceTree,
    },
    status: "available",
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function importsFrom(content: string): string[] {
  const imports = new Set<string>();
  const pattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](?<specifier>[^"']+)["']/gu;
  for (const match of content.matchAll(pattern)) {
    const [, specifier] = match;
    if (specifier !== undefined) imports.add(specifier);
  }
  return [...imports].toSorted();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function appRelativePath(appId: string, path: string): string | undefined {
  const prefix = `apps/${appId}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function auditAppliedAppComposition(input: {
  appId: string;
  binding: BoundArrustedComponentCompositionPolicy;
  files: readonly { path: string; content: string }[];
}): AppliedAppCompositionResult {
  const violations: CompositionViolation[] = [];
  const inspectedFiles = input.files.map(({ path }) => path).toSorted();
  const allowedImports = new Set([
    ...input.binding.policy.publicImports,
    ...input.binding.policy.tokenEntrypoints,
    ...input.binding.policy.providers,
  ]);
  const allowedRouteGlue = new Set(input.binding.policy.routeGlue.allowedFiles);
  const allowedStyles = new Set(input.binding.policy.routeGlue.allowedStyleFiles);

  for (const file of input.files) {
    const relative = appRelativePath(input.appId, file.path);
    if (relative === undefined) continue;
    const isStyle = /\.(?:css|scss|sass|less)$/u.test(relative);
    const isComponentSource = /\.(?:[cm]?[jt]sx?)$/u.test(relative);

    if (/(?:^|\/)components(?:\/|$)/u.test(relative))
      violations.push({
        code: "local-component-file",
        message: "Generated apps may not add local visual component files.",
        path: file.path,
      });

    if (
      isComponentSource &&
      !allowedRouteGlue.has(relative) &&
      /(?:export\s+(?:default\s+)?function|function\s+[A-Z]|const\s+[A-Z][A-Za-z0-9]*\s*=\s*\()/u.test(
        file.content,
      )
    )
      violations.push({
        code: "local-component-definition",
        message: "Generated apps may only define visual route glue named by the Arrusted policy.",
        path: file.path,
      });

    if (isStyle && !allowedStyles.has(relative))
      violations.push({
        code: "unapproved-style-file",
        message: "Generated apps may not add component-local style files.",
        path: file.path,
      });

    if (isStyle && /--[A-Za-z][A-Za-z0-9-]*\s*:/u.test(file.content))
      violations.push({
        code: "replacement-design-token",
        message: "Generated apps may not define replacement design tokens.",
        path: file.path,
      });

    if (/style\s*=\s*\{\s*\{/u.test(file.content))
      violations.push({
        code: "inline-visual-style",
        message: "Generated apps may not add inline visual styling.",
        path: file.path,
      });

    for (const specifier of importsFrom(file.content)) {
      if (specifier.startsWith("@autograph/") && !allowedImports.has(specifier))
        violations.push({
          code: "unapproved-public-import",
          message: `The import ${specifier} is not declared by the selected Arrusted policy.`,
          path: file.path,
        });
    }
  }

  return violations.length === 0
    ? { binding: input.binding, inspectedFiles, status: "passed" }
    : { binding: input.binding, inspectedFiles, status: "failed", violations };
}
