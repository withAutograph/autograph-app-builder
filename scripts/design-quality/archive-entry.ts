import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Dated folders may also contain supplemental screenshots, not scored runs. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readArchivedReport(directory: string) {
  let bytes: string;
  try {
    bytes = await readFile(join(directory, "report.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(bytes);
}
