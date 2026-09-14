/* oxlint-disable eslint/no-await-in-loop -- Sequential reads bound provider load and retain evidence in order. */
import { createHash } from "node:crypto";
import path from "node:path";
import type { Dirent, Stats } from "node:fs";

export interface SourceReader {
  readdir: (name: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  lstat: (name: string) => Promise<Stats>;
  readlink: (name: string) => Promise<string>;
  readFile: (name: string) => Promise<Buffer>;
}
export interface SourceEntry {
  path: string;
  // oxlint-disable-next-line sonarjs/max-union-size -- Manifest preserves each filesystem outcome explicitly.
  kind: "directory" | "file" | "link" | "excluded" | "unreadable";
  mode?: number;
  bytes?: number;
  sha256?: string;
  target?: string;
  reason?: string;
}
const runtimeDirectories = new Set(["node_modules", ".next", ".git", ".scratch", "coverage"]);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Reads only. Links are recorded, never followed or recreated in the export. */
export const observeSource = async (
  reader: SourceReader,
  root: string,
  retain: (relative: string, bytes: Buffer) => Promise<void>,
) => {
  const scan = async (save: boolean) => {
    const entries: SourceEntry[] = [];
    const visit = async (relative: string): Promise<void> => {
      const absolute = path.posix.join(root, relative);
      try {
        const stat = await reader.lstat(absolute);
        const mode = stat.mode % 4096;
        if (stat.isSymbolicLink()) {
          entries.push({
            kind: "link",
            mode,
            path: relative,
            target: await reader.readlink(absolute),
          });
        } else if (stat.isDirectory()) {
          if (runtimeDirectories.has(path.posix.basename(relative))) {
            entries.push({
              kind: "excluded",
              path: relative,
              reason: "runtime/dependency/VCS directory; contents not observed",
            });
            return;
          }
          entries.push({ kind: "directory", mode, path: relative });
          const children = await reader.readdir(absolute, { withFileTypes: true });
          for (const child of children.toSorted((a, b) => a.name.localeCompare(b.name))) {
            if (
              !child.name ||
              child.name === "." ||
              child.name === ".." ||
              /[\n\r/]/u.test(child.name)
            ) {
              throw new Error("unrepresentable entry");
            }
            await visit(path.posix.join(relative, child.name));
          }
        } else if (stat.isFile()) {
          const bytes = await reader.readFile(absolute);
          entries.push({
            bytes: bytes.length,
            kind: "file",
            mode,
            path: relative,
            sha256: digest(bytes),
          });
          if (save) {
            await retain(relative, bytes);
          }
        } else {
          entries.push({ kind: "unreadable", path: relative, reason: "unsupported special file" });
        }
      } catch {
        entries.push({ kind: "unreadable", path: relative, reason: "read or retention failed" });
      }
    };
    await visit(".");
    return entries.toSorted((a, b) => a.path.localeCompare(b.path));
  };
  const first = await scan(true);
  const second = await scan(false);
  const stable = JSON.stringify(first) === JSON.stringify(second);
  return {
    completeWithinDeclaredScope:
      stable &&
      first.some((entry) => entry.path === "." && entry.kind === "directory") &&
      !first.some((entry) => entry.kind === "unreadable"),
    exclusions: [...runtimeDirectories],
    first,
    scope:
      "All regular source bytes and link metadata under the applied repository root, excluding explicitly inventoried runtime directories. Links are not followed. Two matching observations do not prove an atomic snapshot.",
    second,
    stable,
  };
};
