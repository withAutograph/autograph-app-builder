/** Egress comes from evaluator-owned browser AND server instrumentation, never
 * the generated app's self-report. Absence of coverage cannot prove isolation. */
export function independenceAssertions(input: {
  referenceOrigins: string[];
  browserOrigins: string[];
  serverOrigins?: string[];
  referenceSourceExposed?: boolean;
  children: { artifactReadable: boolean; depth: number }[];
  artifacts: string[];
}) {
  const assertion = (id: string, passed: boolean, detail: string) => ({
    id,
    passed,
    detail,
    artifacts: input.artifacts,
  });
  const reference = new Set(input.referenceOrigins.map((origin) => new URL(origin).origin));
  const requested = [...input.browserOrigins, ...(input.serverOrigins ?? [])].map(
    (origin) => new URL(origin).origin,
  );
  const leaked = requested.some((origin) => reference.has(origin));
  return [
    assertion(
      "child-artifact-readable",
      input.children.length === 1 && input.children[0]!.artifactReadable,
      "Read the exported child artifact independently.",
    ),
    assertion(
      "child-count-one",
      input.children.length === 1,
      `Observed ${input.children.length} child artifacts.`,
    ),
    assertion(
      "recursion-depth-one",
      input.children.length === 1 && input.children.every((child) => child.depth === 1),
      "The evaluator stops after one child; no descendant generation is requested.",
    ),
    ...(leaked || (reference.size > 0 && input.serverOrigins !== undefined)
      ? [
          assertion(
            "no-reference-backend",
            !leaked,
            "Compared complete observed browser/server origins with the reference backend origins.",
          ),
        ]
      : []),
    ...(input.referenceSourceExposed !== undefined
      ? [
          assertion(
            "no-reference-source",
            !input.referenceSourceExposed,
            "Reviewed evaluator generator-input exposure receipt.",
          ),
        ]
      : []),
  ];
}
