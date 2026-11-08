/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Sequential binary reads bound memory and recheck every captured file before retention. */
import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import type { ApplicationSourceManifest } from "./application-source-contract";
import { applicationSourceOmissionReason } from "./application-source-contract";
import { validateApplicationSourceArtifact } from "./application-source-bytes";

const SOURCE_CHANGED_MESSAGE = "Application source changed during capture";

export const applicationSourceInventoryProgram = String.raw`import json,os,stat,sys
root='/workspace/repository'
app=sys.argv[1]
base=os.path.join(root,'apps',app)
if os.path.realpath(base)!=os.path.join(os.path.realpath(root),'apps',app) or not os.path.isdir(base): raise RuntimeError('app source unavailable')
rows=[]
for directory,dirs,files in os.walk(base,followlinks=False):
 for name in sorted(dirs+files):
  absolute=os.path.join(directory,name)
  relative=os.path.relpath(absolute,root).replace(os.sep,'/')
  info=os.lstat(absolute)
  if stat.S_ISLNK(info.st_mode):
   rows.append({'path':relative,'kind':'symlink'})
   if name in dirs: dirs.remove(name)
  elif stat.S_ISDIR(info.st_mode):
   if name in ['.git','.vercel','.eve','.artifacts','.scratch','.sandbox','local-native-recovery','node_modules','.turbo','.cache','.aws','.ssh','.kube','.auth'] or (directory==base and name in ['.next','coverage','dist','build','test-results','playwright-report','blob-report']):
    rows.append({'path':relative,'kind':'directory'})
    dirs.remove(name)
  elif stat.S_ISREG(info.st_mode):
   rows.append({'path':relative,'kind':'file','bytes':info.st_size,'mode':'100755' if info.st_mode & 0o111 else '100644'})
  else: rows.append({'path':relative,'kind':'unsupported'})
print(json.dumps(rows))`;
const listingSchema = z.array(
  z.strictObject({
    path: z.string(),
    kind: z.enum(["file", "directory", "symlink", "unsupported"]),
    bytes: z.number().int().nonnegative().optional(),
    mode: z.enum(["100644", "100755"]).optional(),
  }),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Capture actual current app-owned Sandbox bytes; never read the host source or a previous artifact. */
export const captureApplicationSource = async (input: {
  sandbox: Pick<SandboxSession, "run" | "readBinaryFile">;
  appId: string;
  displayName: string;
  sourceSessionId: string;
  signal: AbortSignal;
  assertCurrent: () => Promise<void>;
}) => {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.appId)) {
    throw new Error("Invalid app source identity");
  }
  input.signal.throwIfAborted();
  await input.assertCurrent();
  const list = async () => {
    const result = await input.sandbox.run({
      command: `python3 -c ${quote(applicationSourceInventoryProgram)} ${quote(input.appId)}`,
      workingDirectory: "/workspace/repository",
    });
    input.signal.throwIfAborted();
    if (result.exitCode !== 0) {
      throw new Error("Application source inventory is unavailable");
    }
    return listingSchema.parse(JSON.parse(result.stdout));
  };
  const inventory = await list();
  const files: { path: string; contentBase64: string }[] = [];
  const manifestFiles: {
    path: string;
    mode: "100644" | "100755";
    bytes: number;
    sha256: string;
  }[] = [];
  const omissions: ApplicationSourceManifest["omissions"] = [];
  for (const row of inventory) {
    input.signal.throwIfAborted();
    const omitted = applicationSourceOmissionReason(row.path);
    if (omitted || row.kind !== "file") {
      omissions.push({
        path: row.path,
        reason: omitted ?? (row.kind === "symlink" ? "symlink" : "unsupported"),
      });
      continue;
    }
    if (row.mode === undefined || row.bytes === undefined) {
      throw new Error("Application source metadata is unavailable");
    }
    const bytes = await input.sandbox.readBinaryFile({ path: `/workspace/repository/${row.path}` });
    input.signal.throwIfAborted();
    if (bytes === null || bytes.byteLength !== row.bytes) {
      throw new Error(SOURCE_CHANGED_MESSAGE);
    }
    const data = Buffer.from(bytes);
    files.push({ path: row.path, contentBase64: data.toString("base64") });
    manifestFiles.push({
      path: row.path,
      mode: row.mode,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  for (const entry of manifestFiles) {
    const observed = await input.sandbox.readBinaryFile({
      path: `/workspace/repository/${entry.path}`,
    });
    input.signal.throwIfAborted();
    if (observed === null || createHash("sha256").update(observed).digest("hex") !== entry.sha256) {
      throw new Error(SOURCE_CHANGED_MESSAGE);
    }
  }
  if (JSON.stringify(await list()) !== JSON.stringify(inventory)) {
    throw new Error(SOURCE_CHANGED_MESSAGE);
  }
  await input.assertCurrent();
  input.signal.throwIfAborted();
  return validateApplicationSourceArtifact({
    manifest: {
      version: 1,
      kind: "application-source-v1",
      appId: input.appId,
      displayName: input.displayName,
      sourceSessionId: input.sourceSessionId,
      files: manifestFiles,
      omissions,
    },
    files,
  });
};
