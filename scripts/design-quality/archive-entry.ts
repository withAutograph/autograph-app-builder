import { readFile } from "node:fs/promises";
import path from "node:path";

/** Dated folders may also contain supplemental screenshots, not scored runs. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readArchivedReport(directory: string) {
  let bytes: string;
  try {
    bytes = await readFile(path.join(directory, "report.json"), "utf-8");
  } catch (error) {
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing assertion at this boundary.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  // oxlint-disable-next-line typescript/no-unsafe-return -- Preserve arbitrary valid archived JSON for existing callers.
  return JSON.parse(bytes);
}
