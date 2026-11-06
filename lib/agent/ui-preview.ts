import { createHash } from "node:crypto";
import nodePath from "node:path";

import { z } from "zod";
import { EVE_MAX_PAYLOAD_BYTES, serializedPayloadBytes } from "@/lib/eve/payload-envelope";

const COMPONENT_PACKAGE = "@autograph/components";
const COMPOSITIONS_PACKAGE = "@autograph/compositions";
const ICON_PACKAGE = "@autograph/icons";
const previewPath = z.string().regex(/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:tsx?|css)$/u);
const route = z.string().regex(/^\/[a-z0-9-]*(?:\/[a-z0-9-]+)*$/u);

export const uiPreviewFileSchema = z.strictObject({
  content: z.string().min(1),
  path: previewPath,
});
export const uiPreviewGapSchema = z.strictObject({
  composes: z.array(
    z.strictObject({
      name: z.string().min(1),
      source: z.enum([COMPONENT_PACKAGE, ICON_PACKAGE]),
    }),
  ),
  path: previewPath,
  reason: z.string().min(1).max(500),
  tokens: z.array(z.string().regex(/^--[a-z][a-z0-9-]*$/u)),
});

const manifestItem = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  routes: z.array(route).min(1),
  statement: z.string().min(3).max(1000),
});
const catalogElement = (source: z.ZodType<string>) =>
  z.strictObject({
    name: z.string().min(1),
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
  productionComponents: z.array(catalogElement(z.literal(COMPONENT_PACKAGE))),
  productionCompositions: z.array(catalogElement(z.literal(COMPOSITIONS_PACKAGE))),
  productionIcons: z.array(catalogElement(z.literal(ICON_PACKAGE))),
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
export type UiPreviewEnvelopeInput = z.infer<typeof uiPreviewInputEnvelopeSchema>;
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

const publicImports = new Set([
  COMPONENT_PACKAGE,
  "@autograph/compositions",
  ICON_PACKAGE,
  "react",
  "react/jsx-runtime",
]);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
type UiPreviewDigestInput =
  | UiPreviewInput
  | UiPreviewTransfer
  | Omit<UiPreviewTransfer, "revision">
  | ReturnType<typeof uiPreviewTransferMetadata>
  | UiPreviewChunkDigestInput;

interface UiPreviewChunkDigestInput {
  content: string;
  filePath: string;
  offsetBytes: number;
}

const digest = (payload: UiPreviewDigestInput) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function imports(content: string) {
  const specifiers: string[] = [];
  for (const match of content.matchAll(
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](?<specifier>[^"']+)["']/gu,
  )) {
    const [, specifier] = match;
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers.toSorted();
}

const validatePreviewImport = (filePath: string, specifier: string) => {
  if (specifier.startsWith("@autograph/") && !publicImports.has(specifier)) {
    throw new Error(`UI preview import is not public: ${specifier}`);
  }
  if (specifier.includes("\\") || /^(?:\/|file:|[a-z]:\/)/iu.test(specifier)) {
    throw new Error("UI preview imports must remain inside its source bundle.");
  }
  if (/^\.{1,2}(?:\/|$)/u.test(specifier)) {
    const target = nodePath.posix.resolve("/", nodePath.posix.dirname(filePath), specifier);
    if (target !== "/src" && !target.startsWith("/src/")) {
      throw new Error("UI preview imports must remain inside its source bundle.");
    }
  }
};

const validatePreviewFile = (file: UiPreviewInput["files"][number]) => {
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/u.test(file.content)) {
    throw new Error("UI previews cannot contact a network service.");
  }
  if (/\b(?:use server|server action|next\/server)\b/u.test(file.content)) {
    throw new Error("UI previews cannot define server behavior.");
  }
  for (const specifier of imports(file.content)) {
    validatePreviewImport(file.path, specifier);
  }
};

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
  const screenRoutes = new Set(
    parsed.manifest.screens.map(({ route: screenRoute }) => screenRoute),
  );
  const allowedRoutes = new Set(parsed.routes);
  if (
    parsed.routes.some((value) => !screenRoutes.has(value)) ||
    parsed.manifest.screens.some(
      ({ route: value, entry }) => !allowedRoutes.has(value) || !paths.has(entry),
    )
  ) {
    throw new Error("UI preview screens, routes, and entries must agree.");
  }
  for (const file of parsed.files) {
    validatePreviewFile(file);
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

const completeUiPreviewInput = (
  transfer: UiPreviewTransfer,
  files: UiPreviewInput["files"],
): UiPreviewInput => {
  const completeInput: UiPreviewInput = {
    appId: transfer.appId,
    catalogGaps: transfer.catalogGaps,
    files,
    manifest: transfer.manifest,
    routes: transfer.routes,
  };
  if (transfer.baseRevision !== undefined) {
    completeInput.baseRevision = transfer.baseRevision;
  }
  return completeInput;
};

const finishUiPreviewTransfer = (
  nextUnsigned: Omit<UiPreviewTransfer, "revision">,
  completeInput: UiPreviewInput,
): UiPreviewChunkStageResult => {
  const sourceDigest = uiPreviewSourceDigest(completeInput);
  const finalUnsigned = { ...nextUnsigned, sourceDigest };
  const completedTransfer = {
    ...finalUnsigned,
    revision: uiPreviewTransferRevision(finalUnsigned),
  };
  return {
    completeInput,
    receipt: uiPreviewChunkReceipt(completedTransfer, sourceDigest),
    transfer: completedTransfer,
  };
};

const createInitialUiPreviewTransfer = (
  input: UiPreviewInput,
  sourceFiles: readonly UiPreviewSourceFile[],
  transferId: string,
): UiPreviewTransfer => {
  const initialTransfer: Omit<UiPreviewTransfer, "revision"> = {
    appId: input.appId,
    catalogGaps: input.catalogGaps,
    completedFiles: [],
    currentChunks: [],
    manifest: input.manifest,
    nextChunkIndex: 0,
    nextFileIndex: 0,
    nextFileOffsetBytes: 0,
    routes: input.routes,
    sourceDigest: "",
    sourceFiles,
    transferId,
  };
  if (input.baseRevision !== undefined) {
    initialTransfer.baseRevision = input.baseRevision;
  }
  return { ...initialTransfer, revision: uiPreviewTransferRevision(initialTransfer) };
};

const getRetryResult = (
  transfer: UiPreviewTransfer,
  sourceChunk: NonNullable<UiPreviewInput["sourceChunk"]>,
  callId: string,
  chunkDigest: string,
): UiPreviewChunkStageResult | undefined => {
  if (transfer.lastChunk?.callId !== callId) {
    return undefined;
  }
  if (
    transfer.lastChunk.chunkIndex !== sourceChunk.chunkIndex ||
    transfer.lastChunk.chunkDigest !== chunkDigest
  ) {
    throw new Error("A retried UI preview chunk changed after it was accepted.");
  }
  if (transfer.nextFileIndex === transfer.sourceFiles.length) {
    const completeInput = completeUiPreviewInput(transfer, transfer.completedFiles);
    return {
      completeInput,
      receipt: uiPreviewChunkReceipt(transfer, transfer.sourceDigest),
      transfer,
    };
  }
  return { receipt: uiPreviewChunkReceipt(transfer), transfer };
};

const startUiPreviewTransfer = (
  input: UiPreviewInput,
  sourceChunk: NonNullable<UiPreviewInput["sourceChunk"]>,
  transferId: string,
  sourceFiles: readonly UiPreviewSourceFile[],
): UiPreviewTransfer => {
  if (
    sourceChunk.chunkIndex !== 0 ||
    sourceChunk.offsetBytes !== 0 ||
    sourceChunk.transferId !== undefined ||
    sourceChunk.transferRevision !== undefined
  ) {
    throw new Error("A UI preview source transfer must start at chunk 0 and byte offset 0.");
  }
  return createInitialUiPreviewTransfer(input, sourceFiles, transferId);
};

const validateUiPreviewChunkPosition = (
  transfer: UiPreviewTransfer,
  sourceChunk: NonNullable<UiPreviewInput["sourceChunk"]>,
  startingTransfer: boolean,
) => {
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
};

const validateUiPreviewChunkSize = (input: UiPreviewInput, callId: string) => {
  const payloadBytes = serializedPayloadBytes({
    data: {
      actions: [{ callId, input, kind: "tool-call", toolName: "record_ui_preview" }],
    },
    type: "actions.requested",
  });
  if (payloadBytes > EVE_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `UI preview source chunk serializes to ${payloadBytes} bytes, above Eve's ${EVE_MAX_PAYLOAD_BYTES}-byte event envelope. Split this UTF-8 file at a smaller character boundary and retry the same chunk index.`,
    );
  }
};

/** Stages one UTF-8 source chunk and verifies each file before exposing a complete input. */
export interface StageUiPreviewSourceChunkInput {
  current?: UiPreviewTransfer;
  value: unknown;
  callId: string;
}

export const stageUiPreviewSourceChunk = (
  input: StageUiPreviewSourceChunkInput,
): UiPreviewChunkStageResult => {
  const parsed = uiPreviewInputEnvelopeSchema.parse(input.value);
  const { sourceChunk, sourceFiles } = parsed;
  if (sourceFiles === undefined || sourceChunk === undefined) {
    throw new Error("Chunked UI preview source metadata is missing.");
  }
  validateUiPreviewChunkSize(parsed, input.callId);

  const metadataDigest = digest(uiPreviewTransferMetadata(parsed));
  const orderedSourceFiles = [...sourceFiles].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  const sourceFilePaths = new Set(orderedSourceFiles.map(({ path }) => path));
  const content = parsed.files[0]?.content;
  const file = orderedSourceFiles.find(({ path }) => path === sourceChunk.filePath);
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
    transfer = startUiPreviewTransfer(parsed, sourceChunk, transferId, orderedSourceFiles);
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
  const retryResult = getRetryResult(transfer, sourceChunk, input.callId, chunkDigest);
  if (retryResult !== undefined) {
    return retryResult;
  }
  validateUiPreviewChunkPosition(transfer, sourceChunk, startingTransfer);

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
  const isComplete = nextFileIndex === sourceFilePaths.size;
  if (isComplete) {
    const completeInput = completeUiPreviewInput(transfer, completedFiles);
    return finishUiPreviewTransfer(nextUnsigned, completeInput);
  }
  const { revision, ...unsigned } = nextUnsigned;
  void revision;
  const nextTransfer = { ...unsigned, revision: uiPreviewTransferRevision(unsigned) };
  return { receipt: uiPreviewChunkReceipt(nextTransfer), transfer: nextTransfer };
};
