import { z } from "zod";
import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import {
  PRIVATE_COMPUTE_CHECK_TASK,
  privateComputeProfileSchema,
} from "../sandbox/private-compute-profile";
import type { PrivateComputeProfile } from "../sandbox/private-compute-profile";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// The provider file-upload API does not preserve executable modes. Mutate the
// already approved regular file through one no-follow handle, then read it back.
const installProgram = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const request = JSON.parse(process.argv[1]);
try {
  if (process.cwd() !== request.root || fs.realpathSync(request.root) !== request.root)
    throw new Error("unsafe-path");
  let parent = process.cwd();
  for (const part of request.path.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    const entry = fs.lstatSync(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe-path");
  }
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const file = fs.openSync(request.path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
try {
  const original = fs.fstatSync(file);
  if (!original.isFile() || original.nlink !== 1) throw new Error("unsafe-path");
  const current = digest(fs.readFileSync(file));
  if (current !== request.beforeSha256 && current !== request.afterSha256)
    throw new Error("changed-task");
  if (current !== request.afterSha256) {
    const bytes = Buffer.from(request.content);
    // readFileSync advanced the descriptor; explicitly write from offset zero.
    let written = 0;
    while (written < bytes.length) {
      const count = fs.writeSync(file, bytes, written, bytes.length - written, written);
      if (count === 0) throw new Error("write-failed");
      written += count;
    }
    fs.ftruncateSync(file, bytes.length);
  }
  fs.fchmodSync(file, 0o755);
  fs.fsyncSync(file);
  const observed = fs.fstatSync(file);
  const named = fs.lstatSync(request.path);
  const bytes = Buffer.alloc(observed.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(file, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error("readback-failed");
    offset += count;
  }
  if (!named.isFile() || named.dev !== observed.dev || named.ino !== observed.ino ||
      (observed.mode & 0o7777) !== 0o755 || digest(bytes) !== request.afterSha256)
    throw new Error("readback-failed");
  process.stdout.write(JSON.stringify({ sha256: digest(bytes), mode: "755" }));
} finally { fs.closeSync(file); }
} catch (error) {
  const known = ["unsafe-path", "changed-task", "write-failed", "readback-failed"];
  const reason = known.includes(error.message) ? error.message :
    error.code === "ENOENT" ? "missing-task" :
    error.code === "ELOOP" ? "unsafe-path" : "install-failed";
  process.stdout.write(JSON.stringify({ error: reason }));
  process.exitCode = 1;
}
`;

/** A reviewed app-owned task mutation; preserve custom tasks and every lint/type-check family. */
export const applyPrivateComputeCheckPolicy = async (input: {
  sandbox: Pick<SandboxSession, "run">;
  applyRoot: string;
  profile: PrivateComputeProfile;
  abortSignal?: AbortSignal;
}) => {
  input.abortSignal?.throwIfAborted();
  const policy = privateComputeProfileSchema.parse(input.profile).checkPolicy;
  if (policy.afterSha256 !== hash(PRIVATE_COMPUTE_CHECK_TASK)) {
    throw new Error(
      "The reviewed compute check policy does not match its installed implementation.",
    );
  }
  if (input.applyRoot !== "/workspace/repository") {
    throw new Error("The reviewed compute check policy requires the owned application checkout.");
  }
  const result = await input.sandbox.run({
    abortSignal: input.abortSignal,
    command: `node -e ${shellQuote(installProgram)} ${shellQuote(
      JSON.stringify({
        afterSha256: policy.afterSha256,
        beforeSha256: policy.beforeSha256,
        content: PRIVATE_COMPUTE_CHECK_TASK,
        path: policy.path,
        root: input.applyRoot,
      }),
    )}`,
    workingDirectory: input.applyRoot,
  });
  input.abortSignal?.throwIfAborted();
  let observed: unknown;
  try {
    observed = JSON.parse(result.stdout);
  } catch {
    /* Fail closed below. */
  }
  if (result.exitCode !== 0) {
    const reasons = new Map([
      [
        "missing-task",
        "The approved check task is missing; prepare an explicit reviewed app-owned repair.",
      ],
      [
        "changed-task",
        "The app check task changed after planning; preserve it and prepare a new reviewed change.",
      ],
      [
        "unsafe-path",
        "The approved check task path is not an unlinked regular file inside the owned checkout.",
      ],
      ["write-failed", "The approved check task write was incomplete."],
      ["readback-failed", "The approved check task bytes or executable mode failed readback."],
    ]);
    const failure = z.strictObject({ error: z.string() }).safeParse(observed);
    const code = failure.success ? failure.data.error : "install-failed";
    throw new Error(
      `${reasons.get(code) ?? "The approved check task could not be installed and verified."} Apply is incomplete.`,
    );
  }
  if (JSON.stringify(observed) !== JSON.stringify({ mode: "755", sha256: policy.afterSha256 })) {
    throw new Error(
      "The approved app check task bytes or executable mode failed readback; apply is incomplete.",
    );
  }
};
