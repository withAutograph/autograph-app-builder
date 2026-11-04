import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import { localRuntimeEnvironmentPath } from "./runtime-environment";

const recordedOrigin = z
  .string()
  .regex(/^(?:http:\/\/localhost:3000|https:\/\/[a-z0-9-]+\.vercel\.run)$/u);
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export const localPreviewAuthOriginReadProgram = (file: string) =>
  `const fs=require('node:fs');const path=require('node:path');const file=${JSON.stringify(file)};const dir=path.dirname(file);for(const p of [dir,file]){const s=fs.lstatSync(p);if(s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0)throw new Error('Local runtime ownership changed');}if(fs.realpathSync(dir)!==dir)throw new Error('Local runtime path changed');const env=JSON.parse(fs.readFileSync(file,'utf8'));console.log(JSON.stringify(env.BETTER_AUTH_URL));`;

/** Read only the previous origin from the exact server-owned local runtime file. */
export const readLocalPreviewAuthOrigin = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
}): Promise<string> => {
  input.signal?.throwIfAborted();
  const file = localRuntimeEnvironmentPath(input.root, input.appId);
  const source = localPreviewAuthOriginReadProgram(file);
  const result = await input.sandbox.run({
    command: `node -e ${quote(source)}`,
    workingDirectory: input.root,
    ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
  });
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    throw new Error("The owned local Auth origin could not be read for preview reconciliation.");
  }
  return recordedOrigin.parse(JSON.parse(result.stdout));
};
