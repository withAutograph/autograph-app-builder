import { createHash } from "node:crypto";

import { z } from "zod";
import { EVE_MAX_PAYLOAD_BYTES, serializedPayloadBytes } from "@/lib/eve/payload-envelope";

const previewPath = z.string().regex(/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:tsx?|css)$/u);
const route = z.string().regex(/^\/[a-z0-9-]*(?:\/[a-z0-9-]+)*$/u);

export const uiPreviewFileSchema = z.strictObject({
  content: z.string().min(1),
  path: previewPath,
});
export const uiPreviewGapSchema = z.strictObject({
  composes: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u),
        source: z.enum(["@autograph/components", "@autograph/icons"]),
      }),
    )
    .min(1),
  path: z.string().regex(/^src\/components\/[A-Za-z0-9_-]+\.tsx$/u),
  reason: z.string().min(8).max(500),
  tokens: z.array(z.string().regex(/^--[a-z][a-z0-9-]*$/u)).min(1),
});

const manifestItem = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  routes: z.array(route).min(1),
  statement: z.string().min(3).max(1000),
});
const catalogElement = (source: z.ZodType<string>) =>
  z.strictObject({
    name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u),
    source,
  });

export const uiPreviewManifestSchema = z.strictObject({
  assumptions: z.array(manifestItem),
  decisions: z.array(manifestItem),
  fixtureFacts: z.array(manifestItem),
  implementationNotes: z.array(
    z.strictObject({
      productionMeaning: z.string().min(3).max(1000),
      routes: z.array(route).min(1),
      visibleElement: z.string().min(3).max(300),
    }),
  ),
  openQuestions: z.array(manifestItem),
  productionComponents: z.array(catalogElement(z.literal("@autograph/components"))),
  productionCompositions: z.array(catalogElement(z.literal("@autograph/compositions"))),
  productionIcons: z.array(catalogElement(z.literal("@autograph/icons"))),
  screens: z
    .array(
      z.strictObject({
        entry: previewPath,
        id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
        route,
        title: z.string().min(1).max(120),
      }),
    )
    .min(1),
  version: z.literal(1),
});
export const uiPreviewInputSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  baseRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  catalogGaps: z.array(uiPreviewGapSchema).default([]),
  files: z.array(uiPreviewFileSchema).min(1),
  manifest: uiPreviewManifestSchema,
  routes: z.array(route).min(1),
  sourceChunk: z
    .strictObject({
      chunkIndex: z.number().int().nonnegative(),
      filePath: previewPath,
      offsetBytes: z.number().int().nonnegative(),
      transferId: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
      transferRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
    })
    .optional(),
  sourceFiles: z
    .array(
      z.strictObject({
        digest: z.string().regex(/^[a-f0-9]{64}$/u),
        path: previewPath,
        sizeBytes: z.number().int().positive(),
      }),
    )
    .min(1)
    .optional(),
});

export const uiPreviewInputEnvelopeSchema = uiPreviewInputSchema.superRefine((input, context) => {
  if (input.sourceFiles === undefined && input.sourceChunk === undefined) {
    return;
  }
  if (input.sourceFiles === undefined || input.sourceChunk === undefined) {
    context.addIssue({
      code: "custom",
      message: "Chunked UI previews require sourceFiles and sourceChunk.",
    });
    return;
  }
  if (input.files.length !== 1 || input.files[0]?.path !== input.sourceChunk.filePath) {
    context.addIssue({
      code: "custom",
      message: "Each UI preview source chunk must contain exactly its declared file.",
    });
  }
  const paths = input.sourceFiles.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", message: "UI preview source file paths must be unique." });
  }
});

export type UiPreviewInput = z.infer<typeof uiPreviewInputSchema>;
export type UiPreviewSourceFile = NonNullable<UiPreviewInput["sourceFiles"]>[number];
export interface UiPreviewTransfer {
  appId: string;
  baseRevision?: string;
  catalogGaps: UiPreviewInput["catalogGaps"];
  completedFiles: UiPreviewInput["files"];
  currentChunks: readonly string[];
  manifest: UiPreviewInput["manifest"];
  nextChunkIndex: number;
  nextFileIndex: number;
  nextFileOffsetBytes: number;
  revision: string;
  routes: UiPreviewInput["routes"];
  sourceDigest: string;
  sourceFiles: readonly UiPreviewSourceFile[];
  transferId: string;
  lastChunk?: {
    callId: string;
    chunkDigest: string;
    chunkIndex: number;
    filePath: string;
    offsetBytes: number;
  };
}

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
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
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
    if (match[1]) {
      continue;
    }
    for (const item of (match[2] ?? "").split(",")) {
      if (/^type\s/u.test(item.trim())) {
        continue;
      }
      const name = item
        .trim()
        .split(/\s+as\s+/u)[0]
        ?.trim();
      if (name) {
        names.add(name);
      }
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
  if (parsed.sourceFiles !== undefined || parsed.sourceChunk !== undefined) {
    throw new Error("Complete UI preview source files before validating or rendering the preview.");
  }
  const paths = new Set(parsed.files.map(({ path }) => path));
  if (paths.size !== parsed.files.length) {
    throw new Error("UI preview paths must be unique.");
  }
  if (new Set(parsed.routes).size !== parsed.routes.length) {
    throw new Error("UI preview routes must be unique.");
  }
  if (parsed.catalogGaps.length > 0) {
    throw new Error(
      "Adapt the design using existing Arrusted components instead of defining a catalog-gap component.",
    );
  }
  const screenRoutes = new Set(
    parsed.manifest.screens.map(({ route: screenRoute }) => screenRoute),
  );
  if (
    parsed.routes.some((value) => !screenRoutes.has(value)) ||
    parsed.manifest.screens.some(
      ({ route: value, entry }) => !parsed.routes.includes(value) || !paths.has(entry),
    )
  ) {
    throw new Error("UI preview screens, routes, and entries must agree.");
  }
  const componentNames = manifestNames(
    parsed.manifest.productionComponents,
    "@autograph/components",
  );
  const compositionNames = manifestNames(
    parsed.manifest.productionCompositions,
    "@autograph/compositions",
  );
  const iconNames = manifestNames(parsed.manifest.productionIcons, "@autograph/icons");
  for (const name of iconNames) {
    if (!publicPreviewIconSet.has(name)) {
      throw new Error(
        `UI preview icon is not a public @autograph/icons export: ${name}. Available icons: ${publicPreviewIcons.join(", ")}`,
      );
    }
  }

  for (const file of parsed.files) {
    if (/\/(?:api|schema|server)\//u.test(file.path) || /(?:^|\/)route\.ts$/u.test(file.path)) {
      throw new Error("UI previews cannot contain backend, schema, or API files.");
    }
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/u.test(file.content)) {
      throw new Error("UI previews cannot contact a network service.");
    }
    if (/\b(?:use server|server action|next\/server)\b/u.test(file.content)) {
      throw new Error("UI previews cannot define server behavior.");
    }
    if (/--[A-Za-z][A-Za-z0-9-]*\s*:/u.test(file.content)) {
      throw new Error("UI previews cannot define replacement design tokens.");
    }
    if (/\b(?:linear|radial|conic)-gradient\s*\(/u.test(file.content)) {
      throw new Error("UI previews cannot invent decorative gradients.");
    }
    if (file.path.startsWith("src/components/")) {
      throw new Error(
        "Compose screens from existing Arrusted components; do not define replacement components.",
      );
    }
    if (/<(?:button|input|select|textarea|dialog|table)\b/u.test(file.content)) {
      throw new Error("Local workflow components must compose public Arrusted primitives.");
    }
    for (const specifier of imports(file.content)) {
      if (specifier.startsWith("@autograph/") && !publicImports.has(specifier)) {
        throw new Error(`UI preview import is not public: ${specifier}`);
      }
      if (specifier.startsWith("../") || specifier.startsWith("../../")) {
        throw new Error("UI preview imports must remain inside its source bundle.");
      }
    }
    for (const [source, inventory] of [
      ["@autograph/components", componentNames],
      ["@autograph/compositions", compositionNames],
      ["@autograph/icons", iconNames],
    ] as const) {
      for (const name of namedImports(file.content, source)) {
        if (!inventory.has(name)) {
          throw new Error(
            `UI preview catalog import is missing from its manifest: ${source}#${name}`,
          );
        }
      }
    }
  }
  for (const gap of parsed.catalogGaps) {
    if (!paths.has(gap.path)) {
      throw new Error("A UI catalog gap refers to a missing local component.");
    }
  }
  for (const collection of [
    parsed.manifest.fixtureFacts,
    parsed.manifest.decisions,
    parsed.manifest.assumptions,
    parsed.manifest.openQuestions,
    parsed.manifest.implementationNotes,
  ]) {
    for (const item of collection) {
      if (item.routes.some((value) => !screenRoutes.has(value))) {
        throw new Error("UI preview manifest metadata refers to an unknown route.");
      }
    }
  }
  for (const gap of parsed.catalogGaps) {
    for (const item of gap.composes) {
      const inventory = item.source === "@autograph/components" ? componentNames : iconNames;
      if (!inventory.has(item.name)) {
        throw new Error("Each catalog gap must compose inventoried public primitives.");
      }
    }
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function uiPreviewSourceDigest(input: UiPreviewInput) {
  return digest({
    appId: input.appId,
    catalogGaps: [...input.catalogGaps].toSorted((left, right) =>
      left.path.localeCompare(right.path),
    ),
    files: [...input.files].toSorted((left, right) => left.path.localeCompare(right.path)),
    manifest: input.manifest,
    routes: [...input.routes].toSorted(),
  });
}

const uiPreviewTransferMetadata = (input: UiPreviewInput) => ({
  appId: input.appId,
  baseRevision: input.baseRevision,
  catalogGaps: [...input.catalogGaps].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  ),
  manifest: input.manifest,
  routes: [...input.routes].toSorted(),
  sourceFiles: [...(input.sourceFiles ?? [])].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  ),
});

const uiPreviewTransferRevision = (transfer: Omit<UiPreviewTransfer, "revision">): string =>
  digest(transfer);

export interface UiPreviewChunkReceipt {
  complete: boolean;
  transferId: string;
  transferRevision: string;
  nextChunkIndex: number;
  nextFilePath?: string;
  nextFileOffsetBytes?: number;
  sourceDigest?: string;
}

export interface UiPreviewChunkStageResult {
  transfer?: UiPreviewTransfer;
  receipt: UiPreviewChunkReceipt;
  completeInput?: UiPreviewInput;
}

const uiPreviewChunkReceipt = (
  transfer: UiPreviewTransfer,
  sourceDigest?: string,
): UiPreviewChunkReceipt => {
  const nextFile = transfer.sourceFiles[transfer.nextFileIndex];
  const receipt: UiPreviewChunkReceipt = {
    complete: nextFile === undefined,
    nextChunkIndex: transfer.nextChunkIndex,
    transferId: transfer.transferId,
    transferRevision: transfer.revision,
  };
  if (nextFile !== undefined) {
    receipt.nextFileOffsetBytes = transfer.nextFileOffsetBytes;
    receipt.nextFilePath = nextFile.path;
  }
  if (sourceDigest !== undefined) {
    receipt.sourceDigest = sourceDigest;
  }
  return receipt;
};

/** Stages one UTF-8 source chunk and verifies each file before exposing a complete input. */
export const stageUiPreviewSourceChunk = (input: {
  current?: UiPreviewTransfer;
  value: UiPreviewInput;
  callId: string;
}): UiPreviewChunkStageResult => {
  const parsed = uiPreviewInputEnvelopeSchema.parse(input.value);
  const { sourceChunk, sourceFiles } = parsed;
  if (sourceFiles === undefined || sourceChunk === undefined) {
    throw new Error("Chunked UI preview source metadata is missing.");
  }
  const payloadBytes = serializedPayloadBytes({
    data: {
      actions: [
        { callId: input.callId, input: parsed, kind: "tool-call", toolName: "record_ui_preview" },
      ],
    },
    type: "actions.requested",
  });
  if (payloadBytes > EVE_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `UI preview source chunk serializes to ${payloadBytes} bytes, above Eve's ${EVE_MAX_PAYLOAD_BYTES}-byte event envelope. Split this UTF-8 file at a smaller character boundary and retry the same chunk index.`,
    );
  }

  const metadataDigest = digest(uiPreviewTransferMetadata(parsed));
  const orderedSourceFiles = [...sourceFiles].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  const content = parsed.files[0]?.content;
  const file =
    orderedSourceFiles[
      sourceChunk.filePath === undefined
        ? -1
        : orderedSourceFiles.findIndex(({ path }) => path === sourceChunk.filePath)
    ];
  if (file === undefined || content === undefined) {
    throw new Error("The UI preview chunk path is not present in its declared source files.");
  }

  let transfer = input.current ?? null;
  if (
    transfer !== null &&
    transfer.nextFileIndex === transfer.sourceFiles.length &&
    sourceChunk.chunkIndex === 0 &&
    sourceChunk.transferId === undefined
  ) {
    transfer = null;
  }
  const startingTransfer = transfer === null;
  if (transfer === null) {
    if (
      sourceChunk.chunkIndex !== 0 ||
      sourceChunk.offsetBytes !== 0 ||
      sourceChunk.transferId !== undefined ||
      sourceChunk.transferRevision !== undefined
    ) {
      throw new Error("A UI preview source transfer must start at chunk 0 and byte offset 0.");
    }
    const transferId = metadataDigest;
    const initialTransfer: Omit<UiPreviewTransfer, "revision"> = {
      appId: parsed.appId,
      catalogGaps: parsed.catalogGaps,
      completedFiles: [],
      currentChunks: [],
      manifest: parsed.manifest,
      nextChunkIndex: 0,
      nextFileIndex: 0,
      nextFileOffsetBytes: 0,
      routes: parsed.routes,
      sourceDigest: "",
      sourceFiles: orderedSourceFiles,
      transferId,
    };
    if (parsed.baseRevision !== undefined) {
      initialTransfer.baseRevision = parsed.baseRevision;
    }
    transfer = { ...initialTransfer, revision: uiPreviewTransferRevision(initialTransfer) };
  }

  if (
    transfer.transferId !== metadataDigest ||
    transfer.appId !== parsed.appId ||
    transfer.baseRevision !== parsed.baseRevision
  ) {
    throw new Error(
      "The UI preview transfer metadata changed; restart the source transfer from chunk 0.",
    );
  }
  const chunkDigest = digest({
    content,
    filePath: sourceChunk.filePath,
    offsetBytes: sourceChunk.offsetBytes,
  });
  if (transfer.lastChunk?.callId === input.callId) {
    if (
      transfer.lastChunk.chunkIndex !== sourceChunk.chunkIndex ||
      transfer.lastChunk.chunkDigest !== chunkDigest
    ) {
      throw new Error("A retried UI preview chunk changed after it was accepted.");
    }
    if (transfer.nextFileIndex === transfer.sourceFiles.length) {
      const completeInput: UiPreviewInput = {
        appId: transfer.appId,
        catalogGaps: transfer.catalogGaps,
        files: transfer.completedFiles,
        manifest: transfer.manifest,
        routes: transfer.routes,
      };
      if (transfer.baseRevision !== undefined) {
        completeInput.baseRevision = transfer.baseRevision;
      }
      return {
        completeInput,
        receipt: uiPreviewChunkReceipt(transfer, transfer.sourceDigest),
        transfer,
      };
    }
    return { receipt: uiPreviewChunkReceipt(transfer), transfer };
  }
  if (
    !startingTransfer &&
    (sourceChunk.transferId !== transfer.transferId ||
      sourceChunk.transferRevision !== transfer.revision)
  ) {
    throw new Error(
      "The UI preview transfer revision is stale. Continue from the latest returned transferRevision.",
    );
  }
  if (
    sourceChunk.chunkIndex !== transfer.nextChunkIndex ||
    sourceChunk.filePath !== transfer.sourceFiles[transfer.nextFileIndex]?.path ||
    sourceChunk.offsetBytes !== transfer.nextFileOffsetBytes
  ) {
    throw new Error(
      "UI preview chunks must be submitted in order with the returned file path, byte offset, and chunk index.",
    );
  }

  const currentChunks = [...transfer.currentChunks, content];
  const combinedBytes = transfer.nextFileOffsetBytes + Buffer.byteLength(content, "utf-8");
  let { completedFiles } = transfer;
  let { nextFileIndex } = transfer;
  let nextFileOffsetBytes = combinedBytes;
  if (combinedBytes > file.sizeBytes) {
    throw new Error(
      `UI preview source file ${file.path} exceeds its declared ${file.sizeBytes}-byte length.`,
    );
  }
  if (combinedBytes === file.sizeBytes) {
    const completeFileContent = currentChunks.join("");
    if (createHash("sha256").update(completeFileContent, "utf-8").digest("hex") !== file.digest) {
      throw new Error(
        `UI preview source file ${file.path} does not match its declared SHA-256 digest.`,
      );
    }
    completedFiles = [...completedFiles, { content: completeFileContent, path: file.path }];
    nextFileIndex += 1;
    nextFileOffsetBytes = 0;
  }
  const nextUnsigned = {
    ...transfer,
    completedFiles,
    currentChunks: combinedBytes === file.sizeBytes ? [] : currentChunks,
    lastChunk: {
      callId: input.callId,
      chunkDigest,
      chunkIndex: sourceChunk.chunkIndex,
      filePath: sourceChunk.filePath,
      offsetBytes: sourceChunk.offsetBytes,
    },
    nextChunkIndex: transfer.nextChunkIndex + 1,
    nextFileIndex,
    nextFileOffsetBytes,
    sourceDigest: "",
  };
  const isComplete = nextFileIndex === orderedSourceFiles.length;
  if (isComplete) {
    const completeInput: UiPreviewInput = {
      appId: parsed.appId,
      catalogGaps: parsed.catalogGaps,
      files: completedFiles,
      manifest: parsed.manifest,
      routes: parsed.routes,
    };
    if (parsed.baseRevision !== undefined) {
      completeInput.baseRevision = parsed.baseRevision;
    }
    const sourceDigest = uiPreviewSourceDigest(completeInput);
    const finalUnsigned = { ...nextUnsigned, sourceDigest };
    const { revision, ...unsigned } = finalUnsigned;
    void revision;
    const completedTransfer = { ...unsigned, revision: uiPreviewTransferRevision(unsigned) };
    return {
      completeInput,
      receipt: uiPreviewChunkReceipt(completedTransfer, sourceDigest),
      transfer: completedTransfer,
    };
  }
  const { revision, ...unsigned } = nextUnsigned;
  void revision;
  const nextTransfer = { ...unsigned, revision: uiPreviewTransferRevision(unsigned) };
  return { receipt: uiPreviewChunkReceipt(nextTransfer), transfer: nextTransfer };
};
