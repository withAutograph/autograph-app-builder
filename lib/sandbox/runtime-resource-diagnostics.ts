import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

/** Fixed read-only observation. No environment values, repository source, or raw process diagnostics escape. */
export const runtimeResourceDiagnosticProgram = String.raw`
const fs=require('node:fs');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const read=(file)=>{try{return fs.readFileSync(file,'utf8')}catch{return undefined}};
const numeric=(file)=>{const value=read(file)?.trim();return value && /^(?:[0-9]+|max)$/.test(value)?value:null};
const fields=(text,names)=>Object.fromEntries((text??'').split('\n').flatMap(line=>{const match=/^([A-Za-z_]+):\s+([0-9]+) kB\s*$/.exec(line);return match&&names.includes(match[1])?[[match[1],Number(match[2])]]:[]}));
const limits=(read('/proc/self/limits')??'').split('\n').flatMap(line=>{const match=/^(Max address space|Max data size|Max locked memory|Max processes)\s+([0-9]+|unlimited)\s+([0-9]+|unlimited)\s+(bytes|processes)\s*$/.exec(line);return match?[{name:match[1],soft:match[2],hard:match[3],unit:match[4]}]:[]});
const installed=['oxlint','vp'].map(name=>{
 // Vite+ owns the actual lint command; its oxlint executable is IDE-only.
 const file='/workspace/repository/node_modules/.bin/vp';
 let actualPath;try{actualPath=fs.realpathSync(file)}catch{return{name,available:false}};
 const args=name==='oxlint'?['toolchain','oxlint']:['--version'];
 const result=spawnSync(file,args,{cwd:'/workspace/repository',encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const text=(result.stdout??'')+'\n'+(result.stderr??'');
 const version=name==='oxlint'?text.match(/\boxlint@(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1]:text.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1];
 return{name,available:result.status===0&&version!==undefined,path:actualPath,versionSource:name==='oxlint'?'vite-plus-toolchain':'executable-version',...(version===undefined?{}:{version}),exitCode:result.status};
});
process.stdout.write(JSON.stringify({platform:os.platform(),architecture:os.arch(),availableParallelism:os.availableParallelism(),totalMemoryBytes:os.totalmem(),linux:{overcommitMemory:numeric('/proc/sys/vm/overcommit_memory'),overcommitRatio:numeric('/proc/sys/vm/overcommit_ratio'),memoryKiB:fields(read('/proc/meminfo'),['MemTotal','MemAvailable','SwapTotal','SwapFree','CommitLimit','Committed_AS']),cgroupMemoryMax:numeric('/sys/fs/cgroup/memory.max'),cgroupSwapMax:numeric('/sys/fs/cgroup/memory.swap.max'),processLimits:limits},installed}));
`;

const numericLimit = z
  .string()
  .regex(/^(?:[0-9]+|max)$/u)
  .nullable();
const resourceSchema = z.strictObject({
  architecture: z.string(),
  availableParallelism: z.number().int().positive(),
  installed: z.array(
    z.strictObject({
      available: z.boolean(),
      exitCode: z.number().int().nullable().optional(),
      name: z.enum(["oxlint", "vp"]),
      path: z.string().optional(),
      version: z
        .string()
        .regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u)
        .optional(),
      versionSource: z.enum(["vite-plus-toolchain", "executable-version"]).optional(),
    }),
  ),
  linux: z.strictObject({
    cgroupMemoryMax: numericLimit,
    cgroupSwapMax: numericLimit,
    memoryKiB: z.partialRecord(
      z.enum(["MemTotal", "MemAvailable", "SwapTotal", "SwapFree", "CommitLimit", "Committed_AS"]),
      z.number().int().nonnegative(),
    ),
    overcommitMemory: numericLimit,
    overcommitRatio: numericLimit,
    processLimits: z.array(
      z.strictObject({
        hard: z.string().regex(/^(?:[0-9]+|unlimited)$/u),
        name: z.enum(["Max address space", "Max data size", "Max locked memory", "Max processes"]),
        soft: z.string().regex(/^(?:[0-9]+|unlimited)$/u),
        unit: z.enum(["bytes", "processes"]),
      }),
    ),
  }),
  platform: z.string(),
  totalMemoryBytes: z.number().int().nonnegative(),
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const inspectSandboxRuntimeResources = async (sandbox: Pick<SandboxSession, "run">) => {
  const result = await sandbox.run({
    command: `node -e ${quote(runtimeResourceDiagnosticProgram)}`,
    workingDirectory: "/workspace/repository",
  });
  if (result.exitCode !== 0) {
    return { available: false as const, exitCode: result.exitCode };
  }
  return {
    available: true as const,
    observations: resourceSchema.parse(JSON.parse(result.stdout)),
  };
};
