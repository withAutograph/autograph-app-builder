import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const index = process.argv.indexOf("--bun-bin");
const bun = index === -1 ? undefined : process.argv[index + 1];
assert.ok(
  bun !== undefined && path.isAbsolute(bun),
  "An explicit installed --bun-bin path is required; this proof installs no toolchain",
);
const root = process.cwd();
const projectRoot = path.join(root, "lib/provisioning/operator-host");
const configuration = z
  .object({
    rewrites: z.array(
      z.object({ destination: z.object({ service: z.string() }), source: z.string() }),
    ),
    services: z.object({ operator: z.object({ entrypoint: z.string(), root: z.literal(".") }) }),
  })
  .parse(JSON.parse(await readFile(path.join(projectRoot, "vercel.json"), "utf-8")));
// The owned temporary directory is nested only so Node resolves the same pinned operator workspace dependencies.
const scratch = await mkdtemp(path.join(projectRoot, ".compiled-operator-proof-"));
const artifact = path.join(scratch, "operator.mjs");
const run = (binary: string, args: string[]) => {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf-8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 0, `${path.basename(binary)} failed: ${result.stderr}`);
  return result.stdout;
};
try {
  run(bun, [
    "build",
    path.join(projectRoot, configuration.services.operator.entrypoint),
    "--target=node",
    "--packages=external",
    "--env=disable",
    `--outfile=${artifact}`,
  ]);
  const driver = path.join(scratch, "exercise.mjs");
  await writeFile(
    driver,
    `import assert from 'node:assert/strict';
let outbound=0;
globalThis.fetch=async()=>{outbound+=1;throw new Error('Unexpected network in credential-free compiled proof');};
const operator=(await import(${JSON.stringify(pathToFileURL(artifact).href)})).default;
const configuration=${JSON.stringify(configuration)};
const paths=['/v1/key-custody/possession','/v1/runtime','/v1/public-release','/v1/app-integrations','/v1/central-integrations','/v1/central-deployment-events','/v1/repository-production','/v1/repository-production/access/complete'];
for(const pathname of paths){
  const rewrite=configuration.rewrites.find(rule=>rule.source===pathname);
  assert.equal(rewrite?.destination.service,'operator','The actual Services route must reach the native operator: '+pathname);
  const response=await operator.fetch(new Request('https://operator.example'+pathname,pathname==='/v1/key-custody/possession'?{}:{method:'POST',body:'{}',headers:{'content-type':'application/json'}}));
  assert.equal(response.status,503,'Missing private configuration must fail closed through the default compiled factory: '+pathname);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json();
  assert.deepEqual(body,pathname==='/v1/key-custody/possession'?{error:'key_custody_unavailable'}:pathname.startsWith('/v1/repository-production')?{code:'app_access_unavailable'}:{code:'protected_operator_required'});
}
for(const pathname of ['/v1/central-integrations/unapproved','/v1/central-deployment-events/unapproved','/v1/repository-production/unapproved']){
  assert.equal(configuration.rewrites.some(rule=>rule.source===pathname),false);
  const response=await operator.fetch(new Request('https://operator.example'+pathname,{method:'POST',body:'{}'}));
  assert.equal(response.status,404);
}
for(const pathname of ['/v1/repository-production','/v1/repository-production/access/complete']){
  const response=await operator.fetch(new Request('https://operator.example'+pathname));
  assert.equal(response.status,404,'Unexpected methods deny before Production initialization');
}
assert.equal(outbound,0);
console.log('PASS compiled native operator: '+paths.length+' actual closed Services routes reach default compiled Hono factory; missing private configuration fails closed, unknown paths deny, zero network effects');
`,
  );
  console.log(run(process.execPath, [driver]).trim());
} finally {
  await rm(scratch, { force: true, recursive: true });
}
