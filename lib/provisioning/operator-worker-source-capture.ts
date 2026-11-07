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
  arrusted: z.strictObject({ sha, tree: sha }),
  builder: z.strictObject({ sha, tree: sha }),
});
export const operatorWorkerFamilySchema = z.enum([
  "genericInstaller",
  "authProposal",
  "auth",
  "resources",
  "managedRuntime",
]);
export const operatorWorkerSourceCaptureSchema = z.strictObject({
  catalogPath: absolute,
  catalogSha256: digest,
  family: operatorWorkerFamilySchema,
  kind: z.literal("operator-worker-catalog-v1"),
  sources: operatorWorkerSourcesSchema,
});
export type OperatorWorkerSourceCapture = z.infer<typeof operatorWorkerSourceCaptureSchema>;
export const operatorWorkerCatalogReceiptSchema = z.strictObject({
  compiler: z.strictObject({
    name: z.literal("bun"),
    target: z.literal("bun-linux-x64"),
    version: z.literal("1.3.14"),
  }),
  kind: z.literal("operator-worker-catalog-v1"),
  sources: operatorWorkerSourcesSchema,
  version: z.literal(1),
  workers: z.record(
    operatorWorkerFamilySchema,
    z.strictObject({
      bytes: z.number().int().positive(),
      entries: z
        .array(z.strictObject({ path: relative, repository: z.enum(["builder", "arrusted"]) }))
        .min(1),
      mode: z.literal("100755"),
      path: relative,
      sha256: digest,
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
