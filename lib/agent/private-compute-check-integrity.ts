import type { SandboxSession } from "eve/sandbox";
import type { ImplementationFile } from "./apply-implementation-files";
import type { PrivateComputeProfile } from "../sandbox/private-compute-profile";

export const privateComputeCheckIntegrityProblem =
  "The selected private compute profile requires its exact reviewed executable check task and effective mise task. Restore that task and remove conflicting check overrides through an explicit Builder repair, or prepare a new plan and fresh approval for a changed policy.";

export const deletesPrivateComputeCheck = (
  profile: PrivateComputeProfile | undefined,
  files: readonly ImplementationFile[],
) =>
  profile !== undefined &&
  files.some((file) => file.operation === "delete" && file.path === profile.checkPolicy.path);

const program = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const input = JSON.parse(process.argv[1]);
try {
  if (process.cwd() !== input.root || fs.realpathSync(input.root) !== input.root) throw 0;
  const target = input.root + "/" + input.path;
  let parent = input.root;
  for (const part of input.path.split("/").slice(0,-1)) {
    parent += "/" + part;
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw 0;
  }
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o755 ||
        crypto.createHash("sha256").update(fs.readFileSync(descriptor)).digest("hex") !== input.sha256) throw 0;
  } finally { fs.closeSync(descriptor); }
  const task = JSON.parse(cp.execFileSync("mise", ["tasks", "info", "//apps/" + input.appId + ":check", "--json"], {encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
  if (task.source !== target || task.file !== target || task.dir !== input.root + "/apps/" + input.appId || !Array.isArray(task.run) || task.run.length !== 0 || task.skip_if != null) throw 0;
  process.stdout.write("verified");
} catch { process.stdout.write("unverified"); process.exitCode = 1; }
`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Read the actual maintained mise projection; configuration text is never guessed or executed as a task. */
export const verifyPrivateComputeCheckIntegrity = async (input: {
  appId: string;
  root: string;
  profile: PrivateComputeProfile | undefined;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}): Promise<boolean> => {
  if (input.profile === undefined) {
    return true;
  }
  input.signal?.throwIfAborted();
  if (
    input.root !== "/workspace/repository" ||
    input.profile.checkPolicy.path !== `apps/${input.appId}/.config/mise/tasks/check`
  ) {
    return false;
  }
  const request = {
    appId: input.appId,
    path: input.profile.checkPolicy.path,
    root: input.root,
    sha256: input.profile.checkPolicy.afterSha256,
  };
  try {
    const result = await input.sandbox.run({
      abortSignal: input.signal,
      command: `node -e ${quote(program)} ${quote(JSON.stringify(request))}`,
      workingDirectory: input.root,
    });
    input.signal?.throwIfAborted();
    return result.exitCode === 0 && result.stdout === "verified";
  } catch {
    input.signal?.throwIfAborted();
    return false;
  }
};
