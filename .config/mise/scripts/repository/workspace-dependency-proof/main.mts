import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { SandboxSession } from "eve/sandbox";
import { ensureCheckoutDependencies } from "../../../../../lib/agent/checkout-dependencies";

const [bun] = process.argv.slice(2);
if (!bun || !path.isAbsolute(bun)) {
  throw new Error("An absolute declared Bun executable is required.");
}
const binary = await stat(bun);
if ((await realpath(bun)) !== bun || !binary.isFile()) {
  throw new Error("An absolute declared Bun executable is required.");
}
const root = await mkdtemp(path.join(tmpdir(), "builder-workspace-dependency-proof-"));
const channel = (readable: Readable) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      readable.on("data", (chunk: Buffer) => {
        controller.enqueue(chunk);
      });
      readable.once("end", () => {
        controller.close();
      });
      readable.once("error", (error: Error) => {
        controller.error(error);
      });
    },
  });
const run = (args: string[], workingDirectory: string) => {
  const child = spawnChild(bun, args, {
    cwd: workingDirectory,
    env: {
      PATH: process.env.PATH,
      TMPDIR: root,
      BUN_INSTALL_CACHE_DIR: path.join(root, ".bun-cache"),
    },
  });
  // oxlint-disable-next-line promise/avoid-new -- Bridge the actual child process completion events.
  const completion = new Promise<{ exitCode: number }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ exitCode: code ?? 1 });
    });
  });
  return {
    stdout: channel(child.stdout),
    stderr: channel(child.stderr),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    wait: () => completion,
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    kill: () => {
      child.kill();
      return Promise.resolve();
    },
  };
};
const collect = async (command: ReturnType<typeof run>) => {
  const [stdout, stderr, result] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.wait(),
  ]);
  assert.equal(result.exitCode, 0, stderr);
  return stdout.trim();
};
try {
  await mkdir(path.join(root, "packages/next-config"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/*", "apps/*"] }),
  );
  await writeFile(
    path.join(root, "packages/next-config/package.json"),
    JSON.stringify({ name: "@autograph/next-config", version: "1.0.0", main: "index.js" }),
  );
  await writeFile(
    path.join(root, "packages/next-config/index.js"),
    'module.exports = "workspace-config";',
  );
  await collect(run(["install"], root));
  const before = await readFile(path.join(root, "bun.lock"), "utf-8");
  await mkdir(path.join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(path.join(root, "node_modules/.bin/next"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await mkdir(path.join(root, "apps/finance"), { recursive: true });
  await writeFile(
    path.join(root, "apps/finance/package.json"),
    JSON.stringify({ name: "finance", dependencies: { "@autograph/next-config": "workspace:*" } }),
  );
  assert.ok(!before.includes('"apps/finance"'));
  let installations = 0;
  const sandbox: Pick<SandboxSession, "spawn"> = {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    spawn(options) {
      assert.equal(options.command, "bun install");
      assert.equal(options.workingDirectory, root);
      installations += 1;
      return Promise.resolve(run(["install"], root));
    },
  };
  const result = await ensureCheckoutDependencies({
    sandbox,
    root,
    checkoutIdentity: "authored-workspace",
    sessionId: "owned-disposable-proof",
    reconcileWorkspace: true,
    requiredExecutable: "next",
  });
  assert.equal(result.status, "installed");
  assert.equal(installations, 1);
  const after = await readFile(path.join(root, "bun.lock"), "utf-8");
  assert.ok(after.includes('"apps/finance"'));
  assert.equal(
    await collect(
      run(
        ["-e", 'console.log(require("@autograph/next-config"))'],
        path.join(root, "apps/finance"),
      ),
    ),
    "workspace-config",
  );
  console.log(
    "PASS: authored workspace lockfile and actual dependency resolution reconciled with declared Bun; no provider effects.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
