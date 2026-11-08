/* oxlint-disable sonarjs/expression-complexity -- Keep the closed preview authority and exact owner/scope/lifetime fences visible together. */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import type { WorkingPreviewRuntime } from "../sandbox/working-preview-runtime";
import { localRuntimeEnvironmentPath } from "../repository/runtime-environment";

export class PrivatePreviewBrowserPrerequisiteError extends Error {
  readonly code = "private-preview-refresh-required";
  constructor() {
    super(
      "Refresh the selected app's current private working preview before browser verification. Its owner, source, lifetime and exact Auth origin must agree; public release and application authorization remain separate.",
    );
    this.name = "PrivatePreviewBrowserPrerequisiteError";
  }
}

const launchSchema = z
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname === "/__autograph_preview_launch" &&
      url.searchParams.size === 1 &&
      url.searchParams.getAll("token").length === 1 &&
      Boolean(url.searchParams.get("token")),
  );
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fileProgram = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const file = process.argv[1];
const operation = process.argv[2];
const parts = path.dirname(file).split("/").filter(Boolean);
let directory = "/";
for (const part of parts) {
  directory = path.join(directory, part);
  if (operation === "prepare" && !fs.existsSync(directory)) fs.mkdirSync(directory,{mode:0o700});
  const stat=fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private browser state unavailable");
}
if (operation === "prepare") { const fd=fs.openSync(file,"wx",0o600); fs.closeSync(fd); }
else {
  const stat=fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid() || stat.nlink!==1) throw new Error("Private browser state unavailable");
  if (operation === "remove") fs.unlinkSync(file);
  else {
    const descriptor=fs.openSync(file,fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      const before=fs.fstatSync(descriptor);
      if (!before.isFile() || before.uid!==process.getuid() || before.nlink!==1) throw new Error("Private browser state unavailable");
      const digest=()=>{
        const observed=fs.fstatSync(descriptor);
        const bytes=Buffer.alloc(observed.size);
        let offset=0;
        while(offset<bytes.length) {
          const count=fs.readSync(descriptor,bytes,offset,bytes.length-offset,offset);
          if(count===0) throw new Error("Private browser state unavailable");
          offset+=count;
        }
        return crypto.createHash("sha256").update(bytes).digest("hex");
      };
      if(digest()!==process.argv[3]) throw new Error("Private browser state unavailable");
      fs.fchmodSync(descriptor,0o600);
      fs.fsyncSync(descriptor);
      const after=fs.fstatSync(descriptor);
      const named=fs.lstatSync(file);
      if((after.mode & 0o7777)!==0o600 || after.nlink!==1 || !named.isFile() || named.dev!==after.dev || named.ino!==after.ino || digest()!==process.argv[3]) throw new Error("Private browser state unavailable");
    } finally {fs.closeSync(descriptor);}
  }
}
`;
const fileOperation = (file: string, operation: "prepare" | "seal" | "remove", digest: string) =>
  `node -e ${quote(fileProgram)} ${quote(file)} ${quote(operation)} ${quote(digest)}`;

/** Upload only to private ephemeral runtime state; no capability appears in a shell command. */
export const withPrivatePreviewBrowserAccess = async <T>(input: {
  appId: string;
  root: string;
  sandboxId: string;
  preview: WorkingPreviewRuntime;
  sandbox: Pick<SandboxSession, "run"> & Partial<Pick<SandboxSession, "writeTextFile">>;
  signal?: AbortSignal;
  assertCurrent: () => void;
  operation: (environment: Record<string, string>) => Promise<T>;
}): Promise<T> => {
  const launch = launchSchema.safeParse(input.preview.receipt.url);
  if (
    !launch.success ||
    input.preview.receipt.appId !== input.appId ||
    input.preview.sandboxId !== input.sandboxId ||
    !Number.isFinite(Date.parse(input.preview.receipt.expiresAt)) ||
    Date.parse(input.preview.receipt.expiresAt) <= Date.now() ||
    !input.sandbox.writeTextFile
  ) {
    throw new PrivatePreviewBrowserPrerequisiteError();
  }
  const file = path.posix.join(
    path.posix.dirname(localRuntimeEnvironmentPath(input.root, input.appId)),
    "browser-access",
    randomUUID(),
    "authority.json",
  );
  const content = JSON.stringify({
    version: 1,
    kind: "private-preview-browser-access",
    appId: input.appId,
    origin: launch.data.origin,
    launchUrl: launch.data.href,
    expiresAt: input.preview.receipt.expiresAt,
  });
  const digest = createHash("sha256").update(content).digest("hex");
  const run = async (operation: "prepare" | "seal" | "remove") => {
    const commandInput = (): Parameters<SandboxSession["run"]>[0] => {
      const request: Parameters<SandboxSession["run"]>[0] = {
        command: fileOperation(file, operation, digest),
        workingDirectory: input.root,
      };
      if (operation !== "remove") {
        request.abortSignal = input.signal;
      }
      return request;
    };
    const result = await input.sandbox.run(commandInput());
    if (result.exitCode !== 0) {
      throw new PrivatePreviewBrowserPrerequisiteError();
    }
  };
  input.signal?.throwIfAborted();
  input.assertCurrent();
  await run("prepare");
  try {
    input.assertCurrent();
    input.signal?.throwIfAborted();
    await input.sandbox.writeTextFile({
      path: file,
      content,
    });
    input.signal?.throwIfAborted();
    input.assertCurrent();
    await run("seal");
    input.signal?.throwIfAborted();
    input.assertCurrent();
    const result = await input.operation({
      APP_TEST_PREVIEW_AUTHORITY_FILE: file,
      APP_TEST_BASE_URL: launch.data.origin,
    });
    input.signal?.throwIfAborted();
    input.assertCurrent();
    if (Date.parse(input.preview.receipt.expiresAt) <= Date.now()) {
      throw new PrivatePreviewBrowserPrerequisiteError();
    }
    return result;
  } catch {
    input.signal?.throwIfAborted();
    throw new PrivatePreviewBrowserPrerequisiteError();
  } finally {
    try {
      await run("remove");
    } catch {
      /* The owned runtime may already be stopped; preserve the original task outcome. */
    }
  }
};
