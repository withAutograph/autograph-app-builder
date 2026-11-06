import { readFile } from "node:fs/promises";
import path from "node:path";

/** Dated folders may also contain supplemental screenshots, not scored runs. */
export async function readArchivedReport(directory: string) {
  let bytes: string;
  try {
    bytes = await readFile(path.join(directory, "report.json"), "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return JSON.parse(bytes);
}
