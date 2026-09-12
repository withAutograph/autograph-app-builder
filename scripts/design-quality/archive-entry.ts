import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Dated folders may also contain supplemental screenshots, not scored runs. */
export async function readArchivedReport(directory: string) {
  let bytes: string;
  try {
    bytes = await readFile(join(directory, "report.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return JSON.parse(bytes);
}
