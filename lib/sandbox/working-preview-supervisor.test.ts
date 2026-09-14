import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";
import { createWorkingPreviewAccess } from "./working-preview-access";
import { previewOwnershipRoot, previewOwnershipSource } from "./working-preview-ownership";
import { workingPreviewSupervisorSource } from "./working-preview-runtime";

const unusedPort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
};
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Observe this single process without restarting it.
    await delay(25);
  }
  expect(condition()).toBe(true);
};

describe("generated working preview supervisor", () => {
  it.each(["signal", "expiry"])(
    "waits for configuration and closes the process group on %s",
    async (mode) => {
      const directory = await mkdtemp(nodePath.join(tmpdir(), "preview-supervisor-"));
      const gatewayPort = await unusedPort();
      let appPort = await unusedPort();
      if (appPort === gatewayPort) {
        appPort = gatewayPort === 65_535 ? gatewayPort - 1 : gatewayPort + 1;
      }
      const configurationPath = nodePath.join(directory, "access.json");
      const readyPath = nodePath.join(directory, "ready");
      const childStarted = nodePath.join(directory, "child-started");
      const grandchildStarted = nodePath.join(directory, "grandchild-started");
      const childStopped = nodePath.join(directory, "child-stopped");
      const grandchildStopped = nodePath.join(directory, "grandchild-stopped");
      const grandchild = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(grandchildStarted)}, "started"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(grandchildStopped)}, "stopped"); process.exit(); }); setInterval(() => {}, 100);`;
      const child = `const fs = require("node:fs"); const {spawn} = require("node:child_process"); fs.writeFileSync(${JSON.stringify(childStarted)}, "started"); spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], {stdio:"ignore"}); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(childStopped)}, "stopped"); process.exit(); }); setInterval(() => {}, 100);`;
      const expiresAt = Date.now() + (mode === "expiry" ? 2500 : 30_000);
      const access = createWorkingPreviewAccess({
        appPort,
        configurationPath,
        expiresAt,
        gatewayPort,
        origin: "https://preview.example",
      });
      const supervisorPath = nodePath.join(directory, "supervisor.mjs");
      const ownerRoot = nodePath.join(directory, "ownership");
      const ownership = {
        attemptId: "attempt",
        expiresAt,
        providerSessionId: "session",
        status: "starting" as const,
      };
      await mkdir(ownerRoot);
      const initializer = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `${previewOwnershipSource.replace(JSON.stringify(previewOwnershipRoot), JSON.stringify(ownerRoot))} await ownershipOperation({kind:"claim", attempt:${JSON.stringify(ownership)}});`,
        ],
        { stdio: "ignore" },
      );
      const [initializerCode] = await once(initializer, "exit");
      expect(initializerCode).toBe(0);
      await writeFile(
        supervisorPath,
        workingPreviewSupervisorSource({
          command: { args: ["-e", child], executable: process.execPath },
          configurationPath,
          cwd: directory,
          expiresAt,
          failurePath: nodePath.join(directory, "failed.json"),
          gatewaySource: access.source,
          ownership,
          readyPath,
        }).replace(JSON.stringify(previewOwnershipRoot), JSON.stringify(ownerRoot)),
      );
      const supervisor = spawn(process.execPath, [supervisorPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      supervisor.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const exited = once(supervisor, "exit");
      try {
        await waitFor(() => existsSync(readyPath) || supervisor.exitCode !== null);
        expect(stderr).not.toMatch(/SyntaxError|ReferenceError|TypeError|ownership changed/u);
        expect(existsSync(readyPath)).toBe(true);
        await delay(150);
        expect(existsSync(childStarted)).toBe(false);
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
          signal: AbortSignal.timeout(1000),
        });
        expect(response.ok).toBe(false);
        await response.body?.cancel();
        await writeFile(configurationPath, access.configuration);
        await waitFor(() => existsSync(grandchildStarted));
        expect(existsSync(childStarted)).toBe(true);
        if (mode === "signal") {
          supervisor.kill("SIGTERM");
        }
        await exited;
        expect(stderr).not.toMatch(/SyntaxError|ReferenceError|TypeError|ownership changed/u);
        expect(existsSync(childStopped)).toBe(true);
        expect(existsSync(grandchildStopped)).toBe(true);
        await expect(
          fetch(`http://127.0.0.1:${gatewayPort}/`, { signal: AbortSignal.timeout(1000) }),
        ).rejects.toThrow();
      } finally {
        if (supervisor.exitCode === null && supervisor.signalCode === null) {
          supervisor.kill("SIGTERM");
          await exited;
        }
        await rm(directory, { force: true, recursive: true });
      }
    },
    10_000,
  );
});
