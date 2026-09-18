import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { decodeOwnerStreamChunk, observeSourceReviews } from "./source-review-observation";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const store = z.string().min(1).parse(option("--owner-store"));
const destination = path.resolve(z.string().min(1).parse(option("--output-dir")));
const runIds = z
  .array(z.string().regex(/^wrun_[A-Za-z0-9]+$/u))
  .min(1)
  .parse(args.flatMap((v, i) => (v === "--run-id" ? [args[i + 1]] : [])));
const canonical = (value: string) => {
  let parent = path.resolve(value);
  while (!existsSync(parent)) {
    parent = path.dirname(parent);
  }
  return path.resolve(realpathSync(parent), path.relative(parent, path.resolve(value)));
};
const canonicalDestination = canonical(destination);
const inside = (root: string) => {
  const relative = path.relative(canonical(root), canonicalDestination);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};
if (inside(path.resolve(import.meta.dirname, "..")) || inside(store)) {
  throw new Error("Output must be external");
}
await mkdir(destination, { mode: 0o700 });
let unreadable = 0;
let original: string | undefined;
const request = args.includes("--original-request-file")
  ? option("--original-request-file")
  : undefined;
try {
  if (request !== undefined) {
    original = await readFile(request, "utf-8");
  }
} catch {
  unreadable += 1;
}
const readRun = async (runId: string) => {
  try {
    const mapping = z
      .object({ streams: z.array(z.string().regex(/^strm_[A-Za-z0-9_-]+$/u)) })
      .parse(
        JSON.parse(await readFile(path.resolve(store, "streams/runs", `${runId}.json`), "utf-8")),
      );
    const readStream = async (stream: string) => {
      const directory = path.resolve(store, "streams/chunks", stream);
      const names = await readdir(directory);
      const chunks = names.filter((name) => /^chnk_[A-Za-z0-9]+\.bin$/u.test(name)).toSorted();
      return await Promise.all(
        chunks.map(async (name) => {
          try {
            return [decodeOwnerStreamChunk(await readFile(path.resolve(directory, name)))];
          } catch {
            unreadable += 1;
            return [];
          }
        }),
      );
    };
    const streams = await Promise.allSettled(mapping.streams.map(readStream));
    const groups = streams.flatMap((stream) => {
      if (stream.status === "fulfilled") {
        return [stream.value];
      }
      unreadable += 1;
      return [];
    });
    // Flatten stream groups, then each chunk’s zero-or-one decoded event.
    return groups.flat().flat();
  } catch {
    unreadable += 1;
    return [];
  }
};
const groups = await Promise.all(runIds.map(readRun));
const events = groups.flat();
let observerRevision: string | null = null;
let observerDirty: boolean | null = null;
try {
  const cwd = path.resolve(import.meta.dirname, "..");
  observerRevision = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf-8",
  }).trim();
  observerDirty =
    execFileSync("/usr/bin/git", ["status", "--porcelain"], { cwd, encoding: "utf-8" }).trim() !==
    "";
} catch {
  // Missing source metadata does not turn unavailable evidence into a result.
}
const report = {
  observerDirty,
  observerRevision,
  ...observeSourceReviews(original, events),
  coverage: {
    inputAvailable: original !== undefined,
    readableEvents: events.length,
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
  `# Owner source review observation\n\nStatus: ${report.status}. Readable runtime events: ${events.length}; unreadable: ${unreadable}.\n\n${limits}\n`,
  { mode: 0o600 },
);
