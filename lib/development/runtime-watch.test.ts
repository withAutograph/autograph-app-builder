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
          repositoryRoot: root,
          expectedFingerprint,
          signal: watcher.signal,
          debounceMs: 5,
          auditMs: 20,
          onChanged: () => {
            notifications += 1;
          },
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
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    "agent/agent.ts",
    "lib/agent/prepare-app-creation.ts",
    "skills/autograph-app-builder/SKILL.md",
    "schemas/app-spec.ts",
    "app/mcp/route.ts",
    "lib/eve/service.ts",
    "lib/mcp/request-handler.ts",
    "lib/sandbox/backend.ts",
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
