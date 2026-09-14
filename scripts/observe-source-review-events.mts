import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { z } from "zod";
import { decodeOwnerGraph, observeSourceReviews } from "./source-review-observation";

const encodedSchema = z.object({ __type: z.literal("Uint8Array"), data: z.string() });
const stepSchema = z.object({
  createdAt: z.string(),
  input: encodedSchema.optional(),
  output: encodedSchema.optional(),
});
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const store = option("--owner-store");
const request = option("--original-request-file");
const output = option("--output-dir");
const runIds = args.flatMap((v, i) => (v === "--run-id" ? [args[i + 1]] : []));
if (
  store === undefined ||
  output === undefined ||
  runIds.length === 0 ||
  runIds.some((id) => !/^wrun_[A-Za-z0-9]+$/u.test(id ?? ""))
) {
  throw new Error("Supply owner store, output directory and explicit owner run IDs.");
}
const destination = path.resolve(output);
const repository = path.resolve(import.meta.dirname, "..");
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
if (inside(repository, destination) || inside(path.resolve(store), destination)) {
  throw new Error("Output must be outside source and owner store.");
}
await mkdir(destination, { mode: 0o700 });
let unreadable = 0;
let original: string | undefined;
try {
  if (request !== undefined) {
    original = await readFile(request, "utf-8");
  }
} catch {
  unreadable += 1;
}
const readStep = async (file: string) => {
  try {
    const step = stepSchema.parse(
      JSON.parse(await readFile(path.resolve(store, "steps", file), "utf-8")),
    );
    const values = [step.input, step.output].flatMap((encoded) => {
      try {
        if (encoded === undefined) {
          return [];
        }
        let bytes = Buffer.from(encoded.data, "base64");
        if (bytes.subarray(0, 4).toString() === "zstd") {
          bytes = zstdDecompressSync(bytes.subarray(4), { maxOutputLength: 64 * 1024 * 1024 });
        }
        if (bytes.subarray(0, 4).toString() !== "devl") {
          throw new Error("unsupported owner encoding");
        }
        return [decodeOwnerGraph(bytes.subarray(4).toString())];
      } catch {
        unreadable += 1;
        return [];
      }
    });
    return [{ time: step.createdAt, values }];
  } catch {
    unreadable += 1;
    return [];
  }
};
let files: string[] = [];
try {
  files = await readdir(path.resolve(store, "steps"));
} catch {
  unreadable += 1;
}
const selected = files.filter(
  (file) => runIds.some((id) => file.startsWith(`${id}-`)) && file.endsWith(".json"),
);
const batches = await Promise.all(selected.map(readStep));
const records = batches.flat().toSorted((a, b) => a.time.localeCompare(b.time));
const report = {
  ...observeSourceReviews(
    original,
    records.flatMap((record) => record.values),
  ),
  coverage: {
    inputAvailable: original !== undefined,
    readableRecords: records.length,
    selectedRuns: runIds.length,
    unreadable,
  },
};
await writeFile(path.resolve(destination, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
const limits = report.limits.map((value) => `- ${value}`).join("\n");
await writeFile(
  path.resolve(destination, "report.md"),
  `# Owner source review observation\n\nStatus: ${report.status}.\n\nReadable records: ${records.length}; unreadable: ${unreadable}; selected runs: ${runIds.length}.\n\n${limits}\n\nSee report.json for sanitized tool observations.\n`,
  { mode: 0o600 },
);
