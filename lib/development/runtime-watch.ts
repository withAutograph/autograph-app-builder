import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const exactRuntimeFiles = new Set([
  ".codex-plugin/plugin.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
]);
const runtimePrefixes = [
  "agent/",
  "skills/",
  "schemas/",
  "app/mcp/",
  // Auth, provisioning and provider adapters are transitive authored-runtime imports.
  "lib/",
  "patches/",
] as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function isDevelopmentRuntimePath(path: string) {
  return exactRuntimeFiles.has(path) || runtimePrefixes.some((prefix) => path.startsWith(prefix));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
    .toString("utf-8")
    .split("\0")
    .filter(isDevelopmentRuntimePath)
    .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function fingerprintDevelopmentRuntime(repositoryRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await runtimePaths(repositoryRoot)) {
    let content: Buffer;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      content = await readFile(nodePath.join(repositoryRoot, path));
    } catch (error) {
      // A file may disappear between Git's listing and the read while a live
      // edit is being saved. The next watcher pass observes the settled tree.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    hash.update(`${Buffer.byteLength(path)}\0${content.byteLength}\0${path}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function waitForDevelopmentRuntimeChange(input: {
  repositoryRoot: string;
  expectedFingerprint: string;
  signal?: AbortSignal;
  debounceMs?: number;
  auditMs?: number;
}): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  {
    let watcher: FSWatcher | undefined;
    let checking = false;
    let pending = false;
    let settled = false;
    let debounce: NodeJS.Timeout | undefined;
    let audit: NodeJS.Timeout | undefined;
    const handlers: { aborted?: () => void } = {};
    const finish = (changed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (debounce !== undefined) {
        clearTimeout(debounce);
      }
      if (audit !== undefined) {
        clearInterval(audit);
        audit = undefined;
      }
      watcher?.close();
      if (handlers.aborted !== undefined) {
        input.signal?.removeEventListener("abort", handlers.aborted);
      }
      resolve(changed);
    };
    handlers.aborted = () => {
      finish(false);
    };
    const check = async () => {
      if (checking) {
        pending = true;
        return;
      }
      checking = true;
      try {
        if (
          (await fingerprintDevelopmentRuntime(input.repositoryRoot)) !== input.expectedFingerprint
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
      if (settled) {
        return;
      }
      if (debounce !== undefined) {
        clearTimeout(debounce);
      }
      debounce = setTimeout(() => {
        check();
      }, input.debounceMs ?? 150);
    };
    if (input.signal?.aborted) {
      finish(false);
      return await promise;
    }
    input.signal?.addEventListener("abort", handlers.aborted, { once: true });
    try {
      watcher = watch(input.repositoryRoot, { recursive: true }, schedule);
      watcher.once("error", schedule);
    } catch {
      // The bounded audit remains the fail-closed watcher fallback.
    }
    audit = setInterval(schedule, input.auditMs ?? 30_000);
    schedule();
  }
  return await promise;
}

/** Observe edits without terminating the worker that owns existing local sessions. */
export const observeDevelopmentRuntimeChanges = async (input: {
  repositoryRoot: string;
  expectedFingerprint: string;
  signal: AbortSignal;
  onChanged: () => void;
  debounceMs?: number;
  auditMs?: number;
}): Promise<void> => {
  let observedFingerprint = input.expectedFingerprint;
  while (!input.signal.aborted) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Rearm after each distinct edit; the watcher debounces and audits without spinning.
    const changed = await waitForDevelopmentRuntimeChange({
      ...input,
      expectedFingerprint: observedFingerprint,
    });
    if (!changed || input.signal.aborted) return;
    // Refresh the baseline before rearming, so one edit cannot cause repeated notifications.
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop
    observedFingerprint = await fingerprintDevelopmentRuntime(input.repositoryRoot);
    if (input.signal.aborted) return;
    input.onChanged();
  }
};
