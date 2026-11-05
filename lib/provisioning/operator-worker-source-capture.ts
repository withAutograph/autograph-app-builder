import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const relative = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      !value.split("/").includes(".."),
  );
const absolute = z
  .string()
  .startsWith("/")
  .refine((value) => path.posix.normalize(value) === value);
export const operatorWorkerSourcesSchema = z.strictObject({
  builder: z.strictObject({ sha, tree: sha }),
  arrusted: z.strictObject({ sha, tree: sha }),
});
export const operatorWorkerFamilySchema = z.enum([
  "genericInstaller",
  "authProposal",
  "auth",
  "resources",
  "managedRuntime",
]);
export const operatorWorkerSourceCaptureSchema = z.strictObject({
  kind: z.literal("operator-worker-catalog-v1"),
  catalogPath: absolute,
  catalogSha256: digest,
  family: operatorWorkerFamilySchema,
  sources: operatorWorkerSourcesSchema,
});
export type OperatorWorkerSourceCapture = z.infer<typeof operatorWorkerSourceCaptureSchema>;
export const operatorWorkerCatalogReceiptSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("operator-worker-catalog-v1"),
  sources: operatorWorkerSourcesSchema,
  compiler: z.strictObject({
    name: z.literal("bun"),
    version: z.literal("1.3.14"),
    target: z.literal("bun-linux-x64"),
  }),
  workers: z.record(
    operatorWorkerFamilySchema,
    z.strictObject({
      path: relative,
      sha256: digest,
      bytes: z.number().int().positive(),
      mode: z.literal("100755"),
      entries: z
        .array(z.strictObject({ repository: z.enum(["builder", "arrusted"]), path: relative }))
        .min(1),
    }),
  ),
});
export class OperatorWorkerSourceCaptureError extends Error {
  constructor() {
    super("operator_worker_source_capture_mismatch");
    this.name = "OperatorWorkerSourceCaptureError";
  }
}
export const verifyOperatorWorkerSourceCapture = async (input: {
  worker: { sha256: string; executablePath: string; sourceCapture?: OperatorWorkerSourceCapture };
  readFile: (path: string) => Promise<Buffer>;
}) => {
  const capture = input.worker.sourceCapture;
  if (capture === undefined) {
    return;
  }
  try {
    const bytes = await input.readFile(capture.catalogPath);
    if (
      bytes.length > 128 * 1024 ||
      createHash("sha256").update(bytes).digest("hex") !== capture.catalogSha256
    ) {
      throw new OperatorWorkerSourceCaptureError();
    }
    const receipt = operatorWorkerCatalogReceiptSchema.parse(JSON.parse(bytes.toString("utf-8")));
    const worker = receipt.workers[capture.family];
    if (
      !isDeepStrictEqual(receipt.sources, capture.sources) ||
      worker.sha256 !== input.worker.sha256 ||
      path.posix.join(path.posix.dirname(capture.catalogPath), worker.path) !==
        input.worker.executablePath
    ) {
      throw new OperatorWorkerSourceCaptureError();
    }
  } catch {
    throw new OperatorWorkerSourceCaptureError();
  }
};
