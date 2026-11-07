import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { readableAppBaselinePaths } from "./app-baseline";
import type { AppBaselineSelection } from "./app-baseline";
import {
  EVE_NATIVE_RESULT_PAGE_BYTES,
  fitOutputNativeFrame,
  serializedNativeActionResultBytes,
} from "../eve/payload-envelope";
import type { NativeActionResultMetadata } from "../eve/payload-envelope";

export const WORKSPACE_REPOSITORY_ROOT = "/workspace/repository";
const WORKSPACE_PATH_DENIED = "workspace-path-denied";
const WORKSPACE_DIRECTORY = "workspace-directory";
export const isWorkspaceDescendant = (input: string): boolean =>
  input.startsWith(`${WORKSPACE_REPOSITORY_ROOT}/`);
export const normalizedWorkspacePath = (input: string): string => {
  const selected = path.posix.normalize(input).replace(/\/+$/u, "");
  const requestedWithin = input === WORKSPACE_REPOSITORY_ROOT || isWorkspaceDescendant(input);
  const selectedWithin = selected === WORKSPACE_REPOSITORY_ROOT || isWorkspaceDescendant(selected);
  if (!requestedWithin || !selectedWithin || selected.includes("\0")) {
    throw new Error("Workspace inspection must stay inside the selected repository.");
  }
  return selected;
};
const entrySchema = z.strictObject({
  kind: z.enum(["file", "directory", "symlink", "other"]),
  path: z.string(),
});
const resultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    continuation: z.strictObject({ directoryOffset: z.number().int().nonnegative() }).optional(),
    entries: z.array(entrySchema),
    kind: z.literal(WORKSPACE_DIRECTORY),
    path: z.string(),
    resolvedPath: z.string(),
  }),
  z.strictObject({
    entryKind: z.enum(["file", "other"]),
    kind: z.literal("workspace-entry"),
    path: z.string(),
    resolvedPath: z.string(),
  }),
  z.strictObject({ kind: z.literal("workspace-missing"), path: z.string() }),
  z.strictObject({ kind: z.literal(WORKSPACE_PATH_DENIED) }),
]);
const quote = (input: string) => {
  const escaped = input.replaceAll("'", "'\"'\"'");
  return `'${escaped}'`;
};

/** Maintained read-only program; root is fixed by the tool, injectable only for owned filesystem tests. */
export const workspaceInspectionProgram = (input: {
  root: string;
  relativePath: string;
  requestedPath: string;
  directoryOffset: number;
  entryBytes: number;
}): string => String.raw`
const fs=require("node:fs");const path=require("node:path");
const input=${JSON.stringify(input)};
const denied=${JSON.stringify(WORKSPACE_PATH_DENIED)};
const emit=value=>process.stdout.write(JSON.stringify(value));
const within=(root,value)=>value===root||value.startsWith(root+path.sep);
try{
 const root=fs.realpathSync(input.root);
 if(root!==path.resolve(input.root)||fs.lstatSync(input.root).isSymbolicLink()){emit({kind:denied});process.exit(0);}
 const target=path.resolve(root,input.relativePath);
 if(!within(root,target)){emit({kind:denied});process.exit(0);}
 const resolved=fs.realpathSync(target);
 if(!within(root,resolved)){emit({kind:denied});process.exit(0);}
 const info=fs.statSync(resolved);
 if(!info.isDirectory()){emit({kind:"workspace-entry",path:input.requestedPath,resolvedPath:resolved,entryKind:info.isFile()?"file":"other"});process.exit(0);}
 const directory=fs.opendirSync(resolved);const entries=[];let index=0;let bytes=0;let continuation;
 try{
  while(true){const item=directory.readSync();if(item===null)break;
   if(index<input.directoryOffset){index++;continue;}
   const entry={path:input.requestedPath+"/"+item.name,kind:item.isSymbolicLink()?"symlink":item.isDirectory()?"directory":item.isFile()?"file":"other"};
   const size=Buffer.byteLength(JSON.stringify(entry))+(entries.length>0?1:0);
   if(bytes+size>input.entryBytes){if(entries.length===0)throw new Error("entry envelope");continuation={directoryOffset:index};break;}
   entries.push(entry);bytes+=size;index++;
  }
 }finally{directory.closeSync();}
 if(fs.realpathSync(target)!==resolved){emit({kind:denied});process.exit(0);}
 emit({kind:${JSON.stringify(WORKSPACE_DIRECTORY)},path:input.requestedPath,resolvedPath:resolved,entries,...(continuation?{continuation}:{})});
}catch(error){if(error&&error.code==="ENOENT"){emit({kind:"workspace-missing",path:input.requestedPath});}else{process.stderr.write("Workspace entry inspection failed");process.exitCode=1;}}
`;

export const workspaceInspectionCommand = (
  input: Parameters<typeof workspaceInspectionProgram>[0],
): string => `node -e ${quote(workspaceInspectionProgram(input))}`;

export const inspectWorkspacePath = async (input: {
  path: string;
  directoryOffset?: number;
  metadata: NativeActionResultMetadata;
  baseline: AppBaselineSelection | undefined;
  sandbox: Pick<SandboxSession, "run" | "readTextFile">;
  signal?: AbortSignal;
}) => {
  const selected = normalizedWorkspacePath(input.path);
  const readable = await readableAppBaselinePaths(input.sandbox, input.baseline, [selected]);
  if (readable.length !== 1) {
    throw new Error("The requested archive is outside the selected app baseline.");
  }
  const base = {
    continuation: { directoryOffset: Number.MAX_SAFE_INTEGER },
    entries: [],
    kind: WORKSPACE_DIRECTORY,
    path: selected,
  };
  const entryBytes =
    EVE_NATIVE_RESULT_PAGE_BYTES - serializedNativeActionResultBytes(base, input.metadata) - 2;
  if (entryBytes < 1) {
    throw new Error("Workspace inspection metadata exceeds the native result envelope.");
  }
  input.signal?.throwIfAborted();
  const command = workspaceInspectionCommand({
    directoryOffset: input.directoryOffset ?? 0,
    entryBytes,
    relativePath: path.posix.relative(WORKSPACE_REPOSITORY_ROOT, selected),
    requestedPath: selected,
    root: WORKSPACE_REPOSITORY_ROOT,
  });
  const observed = await input.sandbox.run({
    abortSignal: input.signal,
    command,
    // Inspection runs only the maintained built-in reader, never inherited app preload hooks.
    env: { NODE_OPTIONS: "" },
  });
  input.signal?.throwIfAborted();
  if (observed.exitCode !== 0) {
    throw new Error("The selected workspace entry could not be inspected.");
  }
  const result = resultSchema.parse(JSON.parse(observed.stdout));
  if (result.kind === WORKSPACE_PATH_DENIED) {
    throw new Error("Workspace inspection must stay inside the selected repository.");
  }
  if (result.kind !== "workspace-missing") {
    const resolved = await readableAppBaselinePaths(input.sandbox, input.baseline, [
      result.resolvedPath,
    ]);
    if (resolved.length !== 1) {
      throw new Error("The requested archive is outside the selected app baseline.");
    }
  }
  if (result.kind === "workspace-directory") {
    const canonicalEntryPath = (entry: z.infer<typeof entrySchema>) =>
      path.posix.join(result.resolvedPath, path.posix.relative(result.path, entry.path));
    const allowed = new Set(
      await readableAppBaselinePaths(
        input.sandbox,
        input.baseline,
        result.entries.map(canonicalEntryPath),
      ),
    );
    const { resolvedPath: _resolved, ...visible } = result;
    void _resolved;
    return fitOutputNativeFrame(
      {
        ...visible,
        entries: result.entries.filter((entry) => allowed.has(canonicalEntryPath(entry))),
      },
      input.metadata,
      EVE_NATIVE_RESULT_PAGE_BYTES,
    );
  }
  if (result.kind === "workspace-entry") {
    return fitOutputNativeFrame(
      {
        entryKind: result.entryKind,
        guidance: "Read file content with paths, using this exact file path.",
        kind: result.kind,
        path: result.path,
      },
      input.metadata,
      EVE_NATIVE_RESULT_PAGE_BYTES,
    );
  }
  return fitOutputNativeFrame(result, input.metadata, EVE_NATIVE_RESULT_PAGE_BYTES);
};
