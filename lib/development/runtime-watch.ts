import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const exactRuntimeFiles = new Set([
  ".codex-plugin/plugin.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);
const runtimePrefixes = [
  "agent/",
  "skills/",
  "schemas/",
  "app/mcp/",
  "lib/agent/",
  "lib/eve/",
  "lib/mcp/",
  "lib/repository/",
  "lib/sandbox/",
] as const;

export function isDevelopmentRuntimePath(path: string) {
  return (
    exactRuntimeFiles.has(path) ||
    runtimePrefixes.some((prefix) => path.startsWith(prefix))
  );
}

async function runtimePaths(repositoryRoot: string) {
  const { stdout } = await execFileAsync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      repositoryRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(isDevelopmentRuntimePath)
    .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export async function fingerprintDevelopmentRuntime(repositoryRoot: string) {
  const hash = createHash("sha256");
  for (const path of await runtimePaths(repositoryRoot)) {
    let content: Buffer;
    try {
      content = await readFile(join(repositoryRoot, path));
    } catch (error) {
      // A file may disappear between Git's listing and the read while a live
      // edit is being saved. The next watcher pass observes the settled tree.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    hash.update(`${Buffer.byteLength(path)}\0${content.byteLength}\0${path}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export function waitForDevelopmentRuntimeChange(input: {
  repositoryRoot: string;
  expectedFingerprint: string;
  signal?: AbortSignal;
  debounceMs?: number;
  auditMs?: number;
}) {
  return new Promise<boolean>((resolveChanged) => {
    let watcher: FSWatcher | undefined;
    let checking = false;
    let pending = false;
    let settled = false;
    let debounce: NodeJS.Timeout | undefined;
    let audit: NodeJS.Timeout | undefined;
    const finish = (changed: boolean) => {
      if (settled) return;
      settled = true;
      if (debounce !== undefined) clearTimeout(debounce);
      if (audit !== undefined) {
        clearInterval(audit);
        audit = undefined;
      }
      watcher?.close();
      input.signal?.removeEventListener("abort", aborted);
      resolveChanged(changed);
    };
    const aborted = () => finish(false);
    const check = async () => {
      if (checking) {
        pending = true;
        return;
      }
      checking = true;
      try {
        if (
          (await fingerprintDevelopmentRuntime(input.repositoryRoot)) !==
          input.expectedFingerprint
        ) {
          finish(true);
          return;
        }
      } catch {
        finish(true);
        return;
      } finally {
        checking = false;
      }
      if (pending) {
        pending = false;
        await check();
      }
    };
    const schedule = () => {
      if (settled) return;
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = setTimeout(() => void check(), input.debounceMs ?? 150);
    };
    if (input.signal?.aborted) return finish(false);
    input.signal?.addEventListener("abort", aborted, { once: true });
    try {
      watcher = watch(input.repositoryRoot, { recursive: true }, schedule);
      watcher.once("error", schedule);
    } catch {
      // The bounded audit remains the fail-closed watcher fallback.
    }
    audit = setInterval(schedule, input.auditMs ?? 30_000);
    schedule();
  });
}
