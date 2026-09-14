import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import { loadEveEvalOidc } from "./eve-eval-oidc";
import { observeSource } from "./self-reproduction-source-observation";

const { values } = parseArgs({
  options: {
    "mise-executable": { type: "string" },
    "output-dir": { type: "string" },
    "sandbox-name": { type: "string" },
    "source-root": { type: "string" },
    "vercel-executable": { type: "string" },
  },
  strict: true,
});
const repository = await realpath(path.resolve(import.meta.dirname, ".."));
const outputArgument = values["output-dir"];
const sandboxName = values["sandbox-name"];
const sourceRoot = values["source-root"];
if (
  outputArgument === undefined ||
  sandboxName === undefined ||
  sourceRoot === undefined ||
  !path.posix.isAbsolute(sourceRoot)
) {
  throw new Error(
    "Supply existing --sandbox-name, absolute --source-root, and new external --output-dir.",
  );
}
const parent = await realpath(path.dirname(path.resolve(outputArgument)));
const output = path.join(parent, path.basename(outputArgument));
if (output === repository || output.startsWith(`${repository}/`)) {
  throw new Error("Observation output must be outside the reference checkout.");
}
await mkdir(output, { mode: 0o700 });
const startedAt = new Date().toISOString();
try {
  loadEveEvalOidc({
    miseExecutable: values["mise-executable"],
    realSandbox: true,
    repositoryRoot: repository,
    vercelExecutable: values["vercel-executable"],
  });
  const sandbox = await Sandbox.get({ name: sandboxName, resume: false });
  if (sandbox.status !== "running") {
    throw new Error("Existing Sandbox is not running");
  }
  const providerSessionId = sandbox.currentSession().sessionId;
  const result = await observeSource(sandbox.fs, sourceRoot, async (relative, bytes) => {
    const destination = path.join(output, "source", relative);
    await mkdir(path.dirname(destination), { mode: 0o700, recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  });
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        finishedAt: new Date().toISOString(),
        lifecycleLimitation:
          "No explicit resume requested. SDK filesystem methods may auto-resume if the session stops between the running-state check and a read.",
        providerSessionId,
        sandboxName,
        sourceRoot,
        startedAt,
        ...result,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (!result.completeWithinDeclaredScope) {
    process.exitCode = 1;
  }
} catch {
  await writeFile(
    path.join(output, "failure.json"),
    JSON.stringify(
      {
        reason:
          "Source observation unavailable. Verify owner binding, existing Sandbox availability and managed project OIDC. Retained bytes are partial.",
        startedAt,
        status: "blocked",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.exitCode = 1;
}
