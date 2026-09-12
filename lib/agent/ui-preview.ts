import { createHash } from "node:crypto";

import { z } from "zod";

const previewPath = z.string().regex(/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:tsx?|css)$/u);
const route = z.string().regex(/^\/[a-z0-9-]*(?:\/[a-z0-9-]+)*$/u);

export const uiPreviewFileSchema = z.strictObject({
  path: previewPath,
  content: z.string().min(1).max(262_144),
});
export const uiPreviewGapSchema = z.strictObject({
  path: z.string().regex(/^src\/components\/[A-Za-z0-9_-]+\.tsx$/u),
  reason: z.string().min(8).max(500),
  composes: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u),
        source: z.enum(["@autograph/components", "@autograph/icons"]),
      }),
    )
    .min(1)
    .max(32),
  tokens: z
    .array(z.string().regex(/^--[a-z][a-z0-9-]*$/u))
    .min(1)
    .max(32),
});

const manifestItem = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  statement: z.string().min(3).max(1000),
  routes: z.array(route).min(1).max(16),
});
const catalogElement = (source: z.ZodType<string>) =>
  z.strictObject({
    name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u),
    source,
  });

export const uiPreviewManifestSchema = z.strictObject({
  version: z.literal(1),
  screens: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
        title: z.string().min(1).max(120),
        route,
        entry: previewPath,
      }),
    )
    .min(1)
    .max(16),
  productionComponents: z.array(catalogElement(z.literal("@autograph/components"))).max(128),
  productionCompositions: z.array(catalogElement(z.literal("@autograph/compositions"))).max(64),
  productionIcons: z.array(catalogElement(z.literal("@autograph/icons"))).max(128),
  fixtureFacts: z.array(manifestItem).max(64),
  decisions: z.array(manifestItem).max(64),
  assumptions: z.array(manifestItem).max(64),
  openQuestions: z.array(manifestItem).max(32),
  implementationNotes: z
    .array(
      z.strictObject({
        visibleElement: z.string().min(3).max(300),
        productionMeaning: z.string().min(3).max(1000),
        routes: z.array(route).min(1).max(16),
      }),
    )
    .max(128),
});
export const uiPreviewInputSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  baseRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  routes: z.array(route).min(1).max(16),
  files: z.array(uiPreviewFileSchema).min(1).max(32),
  manifest: uiPreviewManifestSchema,
  catalogGaps: z.array(uiPreviewGapSchema).max(16).default([]),
});

export type UiPreviewInput = z.infer<typeof uiPreviewInputSchema>;

export const publicPreviewIcons = [
  "ArrowRight",
  "ArrowUp",
  "ArrowsPointingIn",
  "Bolt",
  "Calendar",
  "Check",
  "CheckCircle",
  "CheckCircleSolid",
  "ChevronDown",
  "ChevronLeft",
  "ChevronRight",
  "ChevronUp",
  "ClipboardDocumentList",
  "Close",
  "CurrencyDollar",
  "FingerPrint",
  "Inbox",
  "ListBullet",
  "Minus",
  "NoSymbol",
  "Plus",
  "Refresh",
  "Search",
  "Sparkles",
  "SparklesSolid",
  "Spinner",
  "Stop",
  "TableCells",
  "Tag",
  "Trash",
  "Undo",
  "User",
] as const;

const publicPreviewIconSet = new Set<string>(publicPreviewIcons);

const publicImports = new Set([
  "@autograph/components",
  "@autograph/compositions",
  "@autograph/icons",
  "react",
  "react/jsx-runtime",
]);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function imports(content: string) {
  return [
    ...content.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](?<specifier>[^"']+)["']/gu),
  ]
    .map((match) => match[1]!)
    .toSorted();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function namedImports(content: string, source: string): string[] {
  const names = new Set<string>();
  const pattern = new RegExp(
    `import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+["']${source.replace("/", "\\/")}["']`,
    "gu",
  );
  for (const match of content.matchAll(pattern)) {
    if (match[1]) continue;
    for (const item of (match[2] ?? "").split(",")) {
      if (/^type\s/u.test(item.trim())) continue;
      const name = item
        .trim()
        .split(/\s+as\s+/u)[0]
        ?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].toSorted();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function manifestNames(values: readonly { name: string; source: string }[], source: string) {
  return new Set(values.filter((value) => value.source === source).map(({ name }) => name));
}

/**
 * Preview code intentionally has a much smaller authority surface than an
 * application.  It can compose visuals and local fixture state only.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function validateUiPreview(input: UiPreviewInput): void {
  const parsed = uiPreviewInputSchema.parse(input);
  const paths = new Set(parsed.files.map(({ path }) => path));
  if (paths.size !== parsed.files.length) throw new Error("UI preview paths must be unique.");
  if (new Set(parsed.routes).size !== parsed.routes.length)
    throw new Error("UI preview routes must be unique.");
  if (parsed.catalogGaps.length > 0)
    throw new Error(
      "Adapt the design using existing Arrusted components instead of defining a catalog-gap component.",
    );
  const screenRoutes = new Set(
    parsed.manifest.screens.map(({ route: screenRoute }) => screenRoute),
  );
  if (
    parsed.routes.some((value) => !screenRoutes.has(value)) ||
    parsed.manifest.screens.some(
      ({ route: value, entry }) => !parsed.routes.includes(value) || !paths.has(entry),
    )
  )
    throw new Error("UI preview screens, routes, and entries must agree.");
  const componentNames = manifestNames(
    parsed.manifest.productionComponents,
    "@autograph/components",
  );
  const compositionNames = manifestNames(
    parsed.manifest.productionCompositions,
    "@autograph/compositions",
  );
  const iconNames = manifestNames(parsed.manifest.productionIcons, "@autograph/icons");
  for (const name of iconNames)
    if (!publicPreviewIconSet.has(name))
      throw new Error(
        `UI preview icon is not a public @autograph/icons export: ${name}. Available icons: ${publicPreviewIcons.join(", ")}`,
      );

  for (const file of parsed.files) {
    if (file.content.split(/\r?\n/u).some((line) => line.length > 2000))
      throw new Error(
        "UI preview source must remain readable and repairable; format JSX instead of submitting lines longer than 2,000 characters.",
      );
    if (/\/(?:api|schema|server)\//u.test(file.path) || /(?:^|\/)route\.ts$/u.test(file.path))
      throw new Error("UI previews cannot contain backend, schema, or API files.");
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/u.test(file.content))
      throw new Error("UI previews cannot contact a network service.");
    if (/\b(?:use server|server action|next\/server)\b/u.test(file.content))
      throw new Error("UI previews cannot define server behavior.");
    if (/--[A-Za-z][A-Za-z0-9-]*\s*:/u.test(file.content))
      throw new Error("UI previews cannot define replacement design tokens.");
    if (/\b(?:linear|radial|conic)-gradient\s*\(/u.test(file.content))
      throw new Error("UI previews cannot invent decorative gradients.");
    if (file.path.startsWith("src/components/"))
      throw new Error(
        "Compose screens from existing Arrusted components; do not define replacement components.",
      );
    if (/<(?:button|input|select|textarea|dialog|table)\b/u.test(file.content))
      throw new Error("Local workflow components must compose public Arrusted primitives.");
    for (const specifier of imports(file.content)) {
      if (specifier.startsWith("@autograph/") && !publicImports.has(specifier))
        throw new Error(`UI preview import is not public: ${specifier}`);
      if (specifier.startsWith("../") || specifier.startsWith("../../"))
        throw new Error("UI preview imports must remain inside its source bundle.");
    }
    for (const [source, inventory] of [
      ["@autograph/components", componentNames],
      ["@autograph/compositions", compositionNames],
      ["@autograph/icons", iconNames],
    ] as const)
      for (const name of namedImports(file.content, source))
        if (!inventory.has(name))
          throw new Error(
            `UI preview catalog import is missing from its manifest: ${source}#${name}`,
          );
  }
  for (const gap of parsed.catalogGaps)
    if (!paths.has(gap.path))
      throw new Error("A UI catalog gap refers to a missing local component.");
  for (const collection of [
    parsed.manifest.fixtureFacts,
    parsed.manifest.decisions,
    parsed.manifest.assumptions,
    parsed.manifest.openQuestions,
    parsed.manifest.implementationNotes,
  ])
    for (const item of collection)
      if (item.routes.some((value) => !screenRoutes.has(value)))
        throw new Error("UI preview manifest metadata refers to an unknown route.");
  for (const gap of parsed.catalogGaps)
    for (const item of gap.composes) {
      const inventory = item.source === "@autograph/components" ? componentNames : iconNames;
      if (!inventory.has(item.name))
        throw new Error("Each catalog gap must compose inventoried public primitives.");
    }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function uiPreviewSourceDigest(input: UiPreviewInput) {
  return digest({
    appId: input.appId,
    routes: [...input.routes].toSorted(),
    files: [...input.files].toSorted((left, right) => left.path.localeCompare(right.path)),
    manifest: input.manifest,
    catalogGaps: [...input.catalogGaps].toSorted((left, right) =>
      left.path.localeCompare(right.path),
    ),
  });
}
