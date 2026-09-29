import { randomUUID } from "node:crypto";

import { Sandbox } from "@vercel/sandbox";

import { HostedRuntimeProviderError } from "./hosted-runtime-provider";

// This runs before credentials enter the control Sandbox. Preserve symlinks and
// include their dependency closure, so pnpm's installed workspace remains usable.
export const installerSourceArchive = String.raw`
import { lstatSync, readdirSync, readlinkSync, writeFileSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
const [root, staging] = process.argv.slice(1);
const pending = [resolve(root)];
const visited = new Set();
const files = [];
const generated = new Set([".git", ".next", ".turbo", ".cache"]);
while (pending.length) {
  const file = pending.pop();
  if (visited.has(file)) continue;
  if (file === "/tmp/app-builder-runtime" || file.startsWith("/tmp/app-builder-runtime/")) throw new Error("Private installer files are not source input");
  visited.add(file);
  const stat = lstatSync(file);
  files.push(file);
  if (stat.isSymbolicLink()) {
    pending.push(resolve(dirname(file), readlinkSync(file)));
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(file)) {
      if (!generated.has(name)) pending.push(join(file, name));
    }
  }
}
mkdirSync(staging, { recursive: true, mode: 0o700 });
const manifest = join(staging, "manifest");
const archive = join(staging, "source.tar");
writeFileSync(manifest, files.join("\0") + "\0", { mode: 0o600 });
const result = spawnSync("tar", ["--create", "--file", archive, "-P", "--no-recursion", "--null", "--files-from", manifest], { stdio: "ignore" });
if (result.error || result.status !== 0) process.exit(1);
const handle = openSync(archive, "r");
try {
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  for (let index = 0n; ; index++) {
    const length = readSync(handle, buffer, 0, buffer.length, null);
    if (!length) break;
    writeFileSync(join(staging, String(index) + ".part"), buffer.subarray(0, length), { mode: 0o600 });
  }
} finally { closeSync(handle); }
`;

export const installerSourceRestore = String.raw`
import { createReadStream, createWriteStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
const [staging] = process.argv.slice(1);
const archive = join(staging, "source.tar");
const output = createWriteStream(archive, { mode: 0o600 });
for (const part of readdirSync(staging).filter(name => /^[0-9]+\.part$/.test(name)).sort((left, right) => BigInt(left.slice(0, -5)) < BigInt(right.slice(0, -5)) ? -1 : 1)) {
  await pipeline(createReadStream(join(staging, part)), output, { end: false });
}
output.end();
await new Promise((resolve, reject) => { output.on("finish", resolve); output.on("error", reject); });
const result = spawnSync("tar", ["--extract", "--file", archive, "-P", "--same-permissions"], { stdio: "ignore" });
if (result.error || result.status !== 0) process.exit(1);
`;

export interface InstallerSandboxTransport {
  delete: Sandbox["delete"];
  extendTimeout: Sandbox["extendTimeout"];
  fs: Pick<Sandbox["fs"], "mkdir" | "readFile" | "readdir" | "rm">;
  runCommand: Sandbox["runCommand"];
  writeFiles: Sandbox["writeFiles"];
}

/** Separate provider-owned compute: its handle and installer files never enter Eve. */
export const withHostedInstallerSandbox = async <T>(input: {
  source: Pick<Sandbox, "name" | "runCommand"> & {
    fs: Pick<Sandbox["fs"], "readFile" | "readdir" | "rm">;
  };
  root: string;
  signal?: AbortSignal;
  run: (control: InstallerSandboxTransport, signal: AbortSignal) => Promise<T>;
  create?: (sourceName: string, signal?: AbortSignal) => Promise<InstallerSandboxTransport>;
}): Promise<T> => {
  const staging = `/tmp/app-builder-installer-transfer-${randomUUID()}`;
  const leaseAbort = new AbortController();
  const operationSignal = input.signal
    ? AbortSignal.any([input.signal, leaseAbort.signal])
    : leaseAbort.signal;
  let control: InstallerSandboxTransport | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | null = null;
  const settleRenewal = async () => {
    if (renewal !== null) {
      await renewal;
    }
  };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  try {
    const archived = await input.source.runCommand({
      args: ["--input-type=module", "-e", installerSourceArchive, input.root, staging],
      cmd: "node",
      signal: operationSignal,
    });
    if (archived.exitCode !== 0) {
      throw new HostedRuntimeProviderError("provider_unavailable");
    }
    control = await (
      input.create ??
      (async (sourceName, signal) =>
        await Sandbox.fork({
          env: {},
          networkPolicy: "allow-all",
          ports: [],
          signal,
          sourceSandbox: sourceName,
          timeout: 15 * 60_000,
        }))
    )(input.source.name, operationSignal);
    const ownedControl = control;
    timer = setInterval(() => {
      if (renewal !== null) {
        return;
      }
      renewal = (async () => {
        try {
          await ownedControl.extendTimeout(5 * 60_000, { signal: AbortSignal.timeout(10_000) });
        } catch {
          leaseAbort.abort(new HostedRuntimeProviderError("provider_unavailable"));
        } finally {
          renewal = null;
        }
      })();
    }, 5 * 60_000);
    await control.fs.mkdir(staging, { recursive: true, signal: operationSignal });
    const names = await input.source.fs.readdir(staging, { signal: operationSignal });
    const parts = names
      .filter((name) => /^[0-9]+\.part$/u.test(name))
      .toSorted((left, right) =>
        BigInt(left.slice(0, -5)) < BigInt(right.slice(0, -5)) ? -1 : 1,
      );
    if (parts.length === 0) {
      throw new HostedRuntimeProviderError("provider_unavailable");
    }
    for (const part of parts) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- bounded transport chunks provide backpressure without limiting the valid checkout.
      const content = await input.source.fs.readFile(`${staging}/${part}`, {
        signal: operationSignal,
      });
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- each chunk is transferred before the next is read.
      await control.writeFiles([{ content, mode: 0o600, path: `${staging}/${part}` }], {
        signal: operationSignal,
      });
    }
    const restored = await control.runCommand({
      args: ["--input-type=module", "-e", installerSourceRestore, staging],
      cmd: "node",
      signal: operationSignal,
    });
    if (restored.exitCode !== 0) {
      throw new HostedRuntimeProviderError("provider_unavailable");
    }
    await control.fs.rm(staging, { force: true, recursive: true, signal: operationSignal });
    await input.source.fs.rm(staging, { force: true, recursive: true, signal: operationSignal });
    outcome = { ok: true, value: await input.run(control, operationSignal) };
  } catch (error) {
    outcome = { error, ok: false };
  }
  if (timer) {
    clearInterval(timer);
  }
  await settleRenewal();
  if (operationSignal.aborted) {
    outcome = { error: operationSignal.reason, ok: false };
  }
  const signal = AbortSignal.timeout(20_000);
  const cleanup = await Promise.allSettled([
    input.source.fs.rm(staging, { force: true, recursive: true, signal }),
    control?.delete({ deleteOrphanSnapshots: true, signal }),
  ]);
  if (cleanup.some((result) => result.status === "rejected") || outcome === null) {
    throw new HostedRuntimeProviderError("provider_unavailable");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
};
