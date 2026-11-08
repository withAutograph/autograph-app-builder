import type { SandboxSession } from "eve/sandbox";
import type { validateApplicationSourceArtifact } from "../handoff/application-source-bytes";
import type { ApplicationSourceImportReceipt } from "../agent/application-source-import-state";

const sandboxWorkingDirectory = "/workspace";

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

/** Only repository-owned file operations execute here. Uploaded source is never loaded. */
export const applicationSourceImportProgram = (input: {
  receipt: ApplicationSourceImportReceipt;
  files: readonly { path: string; mode: string; sha256: string; bytes: number }[];
  staging: string;
  root?: string;
}) => `
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(${JSON.stringify(`${input.staging}/plan.json`)}, 'utf8'));
const root = ${JSON.stringify(input.root ?? "/workspace/repository")};
const target = path.join(root, input.receipt.appRoot);
const marker = path.join(root, '.app-builder', 'application-source-import-' + input.receipt.reference.appId + '.json');
const reject = () => { throw new Error('Application source import cannot replace occupied or changed source.'); };
for (const dir of [root, path.join(root, 'apps'), path.join(root, '.app-builder')]) {
 if (fs.existsSync(dir) && (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())) reject();
}
if (fs.existsSync(marker)) {
 const prior = JSON.parse(fs.readFileSync(marker, 'utf8'));
 if (JSON.stringify(prior) !== JSON.stringify(input.receipt) || !fs.existsSync(target) || !fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) reject();
 process.exit(0);
}
if (fs.existsSync(target)) reject();
const stage = path.join(input.staging, 'app'); fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
for (let i = 0; i < input.files.length; i++) {
 const file = input.files[i]; const prefix = input.receipt.appRoot + '/';
 if (!file.path.startsWith(prefix)) reject();
 const relative = file.path.slice(prefix.length);
 if (!relative || relative.split('/').some(p => !p || p === '.' || p === '..') || relative.includes('\\\\')) reject();
 const encoded = fs.readFileSync(path.join(input.staging, String(i) + '.base64'), 'utf8');
 const bytes = Buffer.from(encoded, 'base64');
 if (bytes.length !== file.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) reject();
 const destination = path.join(stage, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
 if (fs.existsSync(destination)) reject();
 fs.writeFileSync(destination, bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
 if (crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== file.sha256) reject();
}
fs.mkdirSync(path.dirname(target), {recursive: true}); fs.mkdirSync(path.dirname(marker), {recursive: true, mode: 0o700});
// The marker is reserved first. Interrupted renames remain visible and require reconciliation.
fs.writeFileSync(marker, JSON.stringify(input.receipt), {flag: 'wx', mode: 0o600});
fs.renameSync(stage, target);
`;

export const materializeApplicationSource = async (input: {
  sandbox: Pick<SandboxSession, "run" | "writeTextFile">;
  validated: ReturnType<typeof validateApplicationSourceArtifact>;
  receipt: ApplicationSourceImportReceipt;
  assertCurrent?: () => Promise<void>;
  abortSignal?: AbortSignal;
}) => {
  input.abortSignal?.throwIfAborted();
  await input.assertCurrent?.();
  const markerPath = `/workspace/repository/.app-builder/application-source-import-${input.receipt.reference.appId}.json`;
  const targetPath = `/workspace/repository/${input.receipt.appRoot}`;
  const probeProgram = `const fs=require("node:fs");const marker=${JSON.stringify(markerPath)};const target=${JSON.stringify(targetPath)};if(!fs.existsSync(marker))process.exit(3);if(fs.lstatSync(marker).isSymbolicLink()||!fs.lstatSync(marker).isFile()||!fs.existsSync(target)||!fs.lstatSync(target).isDirectory()||fs.lstatSync(target).isSymbolicLink()||JSON.stringify(JSON.parse(fs.readFileSync(marker,"utf8")))!==${JSON.stringify(JSON.stringify(input.receipt))})process.exit(2);`;
  const probe = await input.sandbox.run({
    command: `node -e ${quote(probeProgram)}`,
    workingDirectory: sandboxWorkingDirectory,
  });
  if (probe.exitCode === 0) {
    input.abortSignal?.throwIfAborted();
    await input.assertCurrent?.();
    return;
  }
  if (probe.exitCode !== 3) {
    throw new Error(
      "Application source import has conflicting private state; preserve it for reconciliation.",
    );
  }
  const staging = `/workspace/.app-builder/application-source-import/${input.receipt.reference.uploadId}`;
  // Staging lives outside the repository; every transport write is bounded independently.
  const preparationProgram = `const fs=require("node:fs"); for(const p of ["/workspace/.app-builder","/workspace/.app-builder/application-source-import",${JSON.stringify(staging)}]) { if(fs.existsSync(p) && (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink())) throw new Error("Unsafe source staging"); fs.mkdirSync(p,{recursive:true,mode:0o700}); } for(const entry of fs.readdirSync(${JSON.stringify(staging)})){ const p=${JSON.stringify(staging)}+"/"+entry; if(!fs.lstatSync(p).isFile() || fs.lstatSync(p).isSymbolicLink()) throw new Error("Unsafe source staging entry"); }`;
  const created = await input.sandbox.run({
    command: `node -e ${quote(preparationProgram)}`,
    workingDirectory: sandboxWorkingDirectory,
  });
  if (created.exitCode !== 0) {
    throw new Error("Application source staging unavailable.");
  }
  for (const [index, file] of input.validated.files.entries()) {
    input.abortSignal?.throwIfAborted();
    const encoded = Buffer.from(file.bytes).toString("base64");
    // Append through a trusted program; never interpret source content as shell or code.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each ordered file initializes its own bounded transport stream.
    await input.sandbox.writeTextFile({
      path: `${staging.slice("/workspace/".length)}/${index}.base64`,
      content: "",
    });
    for (let offset = 0; offset < encoded.length; offset += 32_768) {
      input.abortSignal?.throwIfAborted();
      const chunk = encoded.slice(offset, offset + 32_768);
      const encodedPath = `${staging}/${index}.base64`;
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Appending chunks to one file must preserve byte order.
      const result = await input.sandbox.run({
        command: `printf '%s' ${quote(chunk)} >> ${quote(encodedPath)}`,
        workingDirectory: sandboxWorkingDirectory,
      });
      if (result.exitCode !== 0) {
        throw new Error("Application source chunk staging failed.");
      }
    }
  }
  const plan = JSON.stringify({
    receipt: input.receipt,
    files: input.validated.artifact.manifest.files,
    staging,
  });
  await input.sandbox.writeTextFile({
    path: `${staging.slice("/workspace/".length)}/plan.json`,
    content: "",
  });
  for (let offset = 0; offset < plan.length; offset += 8192) {
    const manifestPath = `${staging}/plan.json`;
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Append the manifest in exact transport order.
    const result = await input.sandbox.run({
      command: `printf '%s' ${quote(plan.slice(offset, offset + 8192))} >> ${quote(manifestPath)}`,
      workingDirectory: sandboxWorkingDirectory,
    });
    if (result.exitCode !== 0) {
      throw new Error("Application source manifest staging failed.");
    }
  }
  const scriptPath = `${staging.slice("/workspace/".length)}/import.cjs`;
  await input.sandbox.writeTextFile({
    path: scriptPath,
    content: applicationSourceImportProgram({
      receipt: input.receipt,
      files: input.validated.artifact.manifest.files,
      staging,
    }),
  });
  input.abortSignal?.throwIfAborted();
  await input.assertCurrent?.();
  const absoluteScriptPath = `/workspace/${scriptPath}`;
  const applied = await input.sandbox.run({
    command: `node ${quote(absoluteScriptPath)}`,
    workingDirectory: sandboxWorkingDirectory,
  });
  input.abortSignal?.throwIfAborted();
  await input.assertCurrent?.();
  if (applied.exitCode !== 0) {
    throw new Error(
      "Application source import blocked; private source was preserved for reconciliation.",
    );
  }
};
