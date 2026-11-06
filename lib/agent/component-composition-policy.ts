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
  return z.array(item).refine((values) => {
    const sorted = [...values].toSorted((left, right) => left.localeCompare(right));
    return (
      new Set(values).size === values.length &&
      values.every((value, index) => value === sorted[index])
    );
  }, "Values must be sorted and contain no duplicates.");
}

/** The target-owned policy is copied into every source-bound apply overlay. */
export const ARRUSTED_COMPONENT_COMPOSITION_POLICY_PATH = "docs/component-composition.json";

export const arrustedComponentCompositionPolicySchema = z.strictObject({
  kind: z.literal("arrusted-component-composition-v1"),
  providers: sortedUnique(identifier),
  publicImports: sortedUnique(identifier),
  routeGlue: z.strictObject({
    allowedFiles: sortedUnique(relativePath),
    allowedStyleFiles: sortedUnique(relativePath),
  }),
  tokenEntrypoints: sortedUnique(identifier),
  version: z.literal(1),
});

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
  code: CompositionViolationCode;
  path: string;
  message: string;
}

export enum CompositionViolationCode {
  UnapprovedPublicImport = "unapproved-public-import",
  LocalComponentFile = "local-component-file",
  LocalComponentDefinition = "local-component-definition",
  UnapprovedStyleFile = "unapproved-style-file",
  ReplacementDesignToken = "replacement-design-token",
  InlineVisualStyle = "inline-visual-style",
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
  if (!gitObject.safeParse(input.sourceSha).success) {
    return {
      reasons: ["The selected source SHA is invalid."],
      status: "unavailable",
    };
  }
  if (!gitObject.safeParse(input.sourceTree).success) {
    return {
      reasons: ["The selected source tree is invalid."],
      status: "unavailable",
    };
  }
  if (input.content === null) {
    return {
      reasons: [
        `Missing ${ARRUSTED_COMPONENT_COMPOSITION_POLICY_PATH} in the selected Arrusted source.`,
      ],
      status: "unavailable",
    };
  }
  let parsed: unknown;
  try {
    // SAFETY: JSON.parse produces untrusted data assigned to unknown and schema-validated below.
    parsed = JSON.parse(input.content);
  } catch {
    return {
      reasons: ["The Arrusted component-composition manifest is not valid JSON."],
      status: "unavailable",
    };
  }
  const policy = arrustedComponentCompositionPolicySchema.safeParse(parsed);
  if (!policy.success) {
    return {
      reasons: ["The Arrusted component-composition manifest is invalid."],
      status: "unavailable",
    };
  }
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
    if (specifier !== undefined) {
      imports.add(specifier);
    }
  }
  return [...imports].toSorted((left, right) => left.localeCompare(right));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function appRelativePath(appId: string, path: string): string | undefined {
  const prefix = `apps/${appId}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

const auditStyle = (
  relative: string,
  file: { path: string; content: string },
  isStyle: boolean,
  allowedStyles: ReadonlySet<string>,
  addViolation: (code: CompositionViolationCode, message: string, path: string) => void,
): void => {
  if (isStyle && !allowedStyles.has(relative)) {
    addViolation(
      CompositionViolationCode.UnapprovedStyleFile,
      "Generated apps may not add component-local style files.",
      file.path,
    );
  }
  if (isStyle && /--[A-Za-z][A-Za-z0-9-]*\s*:/u.test(file.content)) {
    addViolation(
      CompositionViolationCode.ReplacementDesignToken,
      "Generated apps may not define replacement design tokens.",
      file.path,
    );
  }
};

const auditCompositionFile = (
  file: { path: string; content: string },
  appId: string,
  allowedImports: ReadonlySet<string>,
  allowedRouteGlue: ReadonlySet<string>,
  allowedStyles: ReadonlySet<string>,
  addViolation: (code: CompositionViolationCode, message: string, path: string) => void,
): void => {
  const relative = appRelativePath(appId, file.path);
  if (relative === undefined) return;

  const isStyle = /\.(?:css|scss|sass|less)$/u.test(relative);
  const isComponentSource = /\.(?:[cm]?[jt]sx?)$/u.test(relative);
  if (/(?:^|\/)components(?:\/|$)/u.test(relative)) {
    addViolation(
      CompositionViolationCode.LocalComponentFile,
      "Generated apps may not add local visual component files.",
      file.path,
    );
  }
  if (
    isComponentSource &&
    !allowedRouteGlue.has(relative) &&
    /(?:export\s+(?:default\s+)?function|function\s+[A-Z]|const\s+[A-Z][A-Za-z0-9]*\s*=\s*\()/u.test(
      file.content,
    )
  ) {
    addViolation(
      CompositionViolationCode.LocalComponentDefinition,
      "Generated apps may only define visual route glue named by the Arrusted policy.",
      file.path,
    );
  }
  auditStyle(relative, file, isStyle, allowedStyles, addViolation);
  if (/style\s*=\s*\{\s*\{/u.test(file.content)) {
    addViolation(
      CompositionViolationCode.InlineVisualStyle,
      "Generated apps may not add inline visual styling.",
      file.path,
    );
  }
  for (const specifier of importsFrom(file.content)) {
    if (specifier.startsWith("@autograph/") && !allowedImports.has(specifier)) {
      addViolation(
        CompositionViolationCode.UnapprovedPublicImport,
        `The import ${specifier} is not declared by the selected Arrusted policy.`,
        file.path,
      );
    }
  }
};

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

  const addViolation = (code: CompositionViolationCode, message: string, path: string) => {
    violations.push({ code, message, path });
  };

  for (const file of input.files) {
    auditCompositionFile(
      file,
      input.appId,
      allowedImports,
      allowedRouteGlue,
      allowedStyles,
      addViolation,
    );
  }

  return violations.length === 0
    ? { binding: input.binding, inspectedFiles, status: "passed" }
    : { binding: input.binding, inspectedFiles, status: "failed", violations };
}
