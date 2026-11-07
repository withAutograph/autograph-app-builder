import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import {
  isDevelopmentRuntimePath,
  fingerprintDevelopmentRuntime,
  observeDevelopmentRuntimeChanges,
} from "./runtime-watch";
import { stopDevelopmentChild } from "./process-supervisor";

describe("development runtime change observation", () => {
  it("observes distinct source edits without ending the pinned worker or spinning on the same edit", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "builder-pinned-worker-"));
    const watcher = new AbortController();
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    let observed: Promise<void> | undefined;
    try {
      execFileSync("/usr/bin/git", ["init", "-q", root]);
      await mkdir(nodePath.join(root, "agent"));
      const source = nodePath.join(root, "agent/agent.ts");
      await writeFile(source, "original");
      let notifications = 0;
      let observerEnded = false;
      const expectedFingerprint = await fingerprintDevelopmentRuntime(root);
      observed = (async () => {
        await observeDevelopmentRuntimeChanges({
          auditMs: 20,
          debounceMs: 5,
          expectedFingerprint,
          onChanged: () => {
            notifications += 1;
          },
          repositoryRoot: root,
          signal: watcher.signal,
        });
        observerEnded = true;
      })();
      await writeFile(source, "first edit");
      await vi.waitFor(() => {
        expect(notifications).toBe(1);
      });
      await delay(60);
      expect(notifications).toBe(1);
      expect(observerEnded).toBe(false);
      expect(worker.exitCode).toBeNull();
      await writeFile(source, "second edit");
      await vi.waitFor(() => {
        expect(notifications).toBe(2);
      });
      expect(worker.exitCode).toBeNull();
      watcher.abort();
      await observed;
      expect(observerEnded).toBe(true);
    } finally {
      watcher.abort();
      await observed;
      await stopDevelopmentChild(worker);
      await rm(root, { force: true, recursive: true });
    }
  });
  it("fingerprints tracked provisioning and dependency patch edits", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "builder-runtime-dependencies-"));
    try {
      execFileSync("/usr/bin/git", ["init", "-q", root]);
      await mkdir(nodePath.join(root, "lib/provisioning"), { recursive: true });
      await mkdir(nodePath.join(root, "patches"));
      await mkdir(nodePath.join(root, "docs"));
      const provisioning = nodePath.join(root, "lib/provisioning/runtime.ts");
      const patch = nodePath.join(root, "patches/eve.patch");
      await writeFile(provisioning, "original runtime");
      await writeFile(patch, "original patch");
      execFileSync("/usr/bin/git", ["-C", root, "add", "-f", "lib", "patches"]);
      const original = await fingerprintDevelopmentRuntime(root);
      await writeFile(provisioning, "updated runtime");
      const changedRuntime = await fingerprintDevelopmentRuntime(root);
      expect(changedRuntime).not.toBe(original);
      await writeFile(patch, "updated patch");
      const changedPatch = await fingerprintDevelopmentRuntime(root);
      expect(changedPatch).not.toBe(changedRuntime);
      await writeFile(nodePath.join(root, "pnpm-workspace.yaml"), "patchedDependencies: {}\n");
      const changedWorkspace = await fingerprintDevelopmentRuntime(root);
      expect(changedWorkspace).not.toBe(changedPatch);
      await writeFile(nodePath.join(root, "docs/notes.md"), "documentation only");
      expect(await fingerprintDevelopmentRuntime(root)).toBe(changedWorkspace);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  it.each([
    "pnpm-workspace.yaml",
    "agent/agent.ts",
    "lib/agent/prepare-app-creation.ts",
    "skills/autograph-app-builder/SKILL.md",
    "schemas/app-spec.ts",
    "app/mcp/route.ts",
    "lib/eve/service.ts",
    "lib/mcp/request-handler.ts",
    "lib/sandbox/backend.ts",
    "lib/provisioning/standard-builder-runtime-configuration.ts",
    "lib/auth/session.ts",
    "lib/integrations/vercel-installation.ts",
    "patches/eve@0.68.0.patch",
    ".codex-plugin/plugin.json",
    "package.json",
    "pnpm-lock.yaml",
  ])("observes pinned-runtime edits for %s", (path) => {
    expect(isDevelopmentRuntimePath(path)).toBe(true);
  });

  it.each([
    "app/page.tsx",
    "app/globals.css",
    "components/landing-page.tsx",
    "public/autograph.svg",
    "docs/plans/local-first.md",
    ".artifacts/development/state.json",
  ])("leaves Next HMR alone for %s", (path) => {
    expect(isDevelopmentRuntimePath(path)).toBe(false);
  });
});
