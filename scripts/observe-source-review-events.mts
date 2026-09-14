import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { decodeOwnerGraph, observeSourceReviews } from "./source-review-observation";

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
  !store ||
  !output ||
  !runIds.length ||
  runIds.some((id) => !/^wrun_[A-Za-z0-9]+$/u.test(id ?? ""))
) {
  throw new Error("Supply owner store, output directory and explicit owner run IDs.");
}
const destination = resolve(output);
const repository = resolve(import.meta.dirname, "..");
const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !r.startsWith("/"));
};
if (inside(repository, destination) || inside(resolve(store), destination)) {
  throw new Error("Output must be outside source and owner store.");
}
await mkdir(destination, { mode: 0o700 });
const records: { time: string; values: unknown[] }[] = [];
let unreadable = 0;
let original: string | undefined;
try {
  if (request) {
    original = await readFile(request, "utf8");
  }
} catch {
  unreadable += 1;
}
try {
  for (const file of (await readdir(resolve(store, "steps"))).sort()) {
    if (!runIds.some((id) => file.startsWith(`${id}-`)) || !file.endsWith(".json")) {
      continue;
    }
    try {
      const step = JSON.parse(await readFile(resolve(store, "steps", file), "utf-8"));
      const values: unknown[] = [];
      for (const field of ["input", "output"]) {
        if (!step[field]) {
          continue;
        }
        const encoded = step[field];
        if (encoded.__type !== "Uint8Array" || typeof encoded.data !== "string") {
          unreadable += 1;
          continue;
        }
        let bytes = Buffer.from(encoded.data, "base64");
        if (bytes.subarray(0, 4).toString() === "zstd") {
          bytes = zstdDecompressSync(bytes.subarray(4), { maxOutputLength: 64 * 1024 * 1024 });
        }
        if (bytes.subarray(0, 4).toString() !== "devl") {
          unreadable += 1;
          continue;
        }
        values.push(decodeOwnerGraph(JSON.parse(bytes.subarray(4).toString())));
      }
      records.push({ time: typeof step.createdAt === "string" ? step.createdAt : "", values });
    } catch {
      unreadable += 1;
    }
  }
} catch {
  unreadable += 1;
}
records.sort((a, b) => a.time.localeCompare(b.time));
const report = {
  ...observeSourceReviews(
    original,
    records.flatMap((r) => r.values),
  ),
  coverage: {
    inputAvailable: original !== undefined,
    readableRecords: records.length,
    selectedRuns: runIds.length,
    unreadable,
  },
};
await writeFile(resolve(destination, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
await writeFile(
  resolve(destination, "report.md"),
  `# Owner source review observation\n\nStatus: ${report.status}.\n\nReadable records: ${records.length}; unreadable: ${unreadable}; selected runs: ${runIds.length}.\n\n${report.limits.map((v) => `- ${v}`).join("\n")}\n\nSee report.json for sanitized tool observations.\n`,
  { mode: 0o600 },
);
