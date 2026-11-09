import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { authSchemaRolloutConfigurationSchema } from "../../../../lib/provisioning/production-auth-schema-rollout-configuration";

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
    services: z.object({ operator: z.object({ root: z.literal("."), entrypoint: z.string() }) }),
    rewrites: z.array(
      z.object({ source: z.string(), destination: z.object({ service: z.string() }) }),
    ),
  })
  .parse(JSON.parse(await readFile(path.join(projectRoot, "vercel.json"), "utf-8")));
const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "offline-platform",
  ownerUserId: "offline-administrator",
};
const ownerContext = {
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  adapterSessionId: "offline-adapter",
  adapterGeneration: 1,
  sessionId: "offline-session",
};
const sourceCapture = {
  kind: "operator-worker-catalog-v1",
  catalogPath: "/offline/catalog.json",
  catalogSha256: "a".repeat(64),
  sources: {
    builder: { sha: "b".repeat(40), tree: "c".repeat(40) },
    arrusted: { sha: "d".repeat(40), tree: "e".repeat(40) },
  },
};
const authConfiguration = authSchemaRolloutConfigurationSchema.parse({
  version: 1,
  builderWorkload: {
    audience: "https://vercel.com/offline-team",
    issuer: "https://oidc.vercel.com/offline-team",
    ownerId: "offline-team",
    projectId: "offline-builder",
    subject: "offline-builder-production",
    environment: "production",
  },
  profiles: [
    {
      id: "offline-auth",
      label: "Offline controlled Auth",
      administrators: [authority],
      resource: {
        version: 1,
        resourceId: "offline-auth",
        environment: "production",
        hostname: "offline-auth.neon.tech",
        port: 5432,
        database: "controlled_auth",
        schema: "public",
        migratorRole: "auth_owner",
        runtimeRole: "auth_runtime",
        neon: { projectId: "offline-project", branchId: "offline-branch" },
      },
      authOperatorRole: "auth_operator",
      runtime: {
        sandbox: {
          source: { type: "snapshot", snapshotId: "offline-snapshot" },
          projectId: "offline-operator",
          teamId: "offline-team",
        },
        worker: {
          id: "auth-protected-schema-v1",
          operationScope: "auth-protected-schema-v1",
          subcommand: "auth-protected-schema",
          executablePath: "/offline/auth",
          sha256: "f".repeat(64),
          sourceCapture: { ...sourceCapture, family: "auth" },
        },
        proposalWorker: {
          id: "offline-proposal",
          executablePath: "/offline/authProposal",
          sha256: "1".repeat(64),
          sourceCapture: { ...sourceCapture, family: "authProposal" },
        },
        catalogAppIds: ["controlled-app"],
        migrationConnectionEnvironment: "OFFLINE_SCHEMA_OWNER_URL",
      },
    },
  ],
});
const sensitiveMarker = "offline-sensitive-value-must-not-appear";
// The owned temporary directory is nested only so Node resolves the same pinned operator workspace dependencies.
const scratch = await mkdtemp(path.join(projectRoot, ".compiled-operator-proof-"));
const artifact = path.join(scratch, "operator.mjs");
const run = (binary: string, args: string[]) => {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
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
const paths=['/v1/key-custody/possession','/v1/runtime','/v1/public-release','/v1/app-integrations','/v1/central-integrations','/v1/central-deployment-events','/v1/repository-production','/v1/repository-production/access/complete','/v1/auth-schema-rollout'];
for(const pathname of paths){
  const rewrite=configuration.rewrites.find(rule=>rule.source===pathname);
  assert.equal(rewrite?.destination.service,'operator','The actual Services route must reach the native operator: '+pathname);
  const response=await operator.fetch(new Request('https://operator.example'+pathname,pathname==='/v1/key-custody/possession'?{}:{method:'POST',body:'{}',headers:{'content-type':'application/json'}}));
  assert.equal(response.status,503,'Missing private configuration must fail closed through the default compiled factory: '+pathname);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json();
  assert.deepEqual(body,pathname==='/v1/key-custody/possession'?{error:'key_custody_unavailable'}:pathname.startsWith('/v1/repository-production')?{code:'app_access_unavailable'}:pathname==='/v1/auth-schema-rollout'?{code:'auth_schema_rollout_unavailable'}:{code:'protected_operator_required'});
}
for(const pathname of ['/v1/central-integrations/unapproved','/v1/central-deployment-events/unapproved','/v1/repository-production/unapproved','/v1/auth-schema-rollout/unapproved']){
  assert.equal(configuration.rewrites.some(rule=>rule.source===pathname),false);
  const response=await operator.fetch(new Request('https://operator.example'+pathname,{method:'POST',body:'{}'}));
  assert.equal(response.status,404);
}
for(const pathname of ['/v1/repository-production','/v1/repository-production/access/complete','/v1/auth-schema-rollout']){
  const response=await operator.fetch(new Request('https://operator.example'+pathname));
  assert.equal(response.status,404,'Unexpected methods deny before Production initialization');
}
const marker=${JSON.stringify(sensitiveMarker)};
process.env.PRODUCTION_AUTH_SCHEMA_ROLLOUT_CONFIGURATION=${JSON.stringify(JSON.stringify(authConfiguration))};
process.env.DATABASE_URL=marker;
process.env.OFFLINE_SCHEMA_OWNER_URL=marker;
const ownerContext=${JSON.stringify(ownerContext)};
const base={version:1,sessionId:ownerContext.sessionId,ownerContext};
const operationRef='11111111-1111-4111-8111-111111111111';
const requests=[
  {...base,action:'plan',profileId:'offline-auth'},
  {...base,action:'status',operationRef},
  {...base,action:'execute',operationRef,planDigest:'2'.repeat(64),approvedByCallId:'offline-call'},
];
const privateFailure=async(body,status,code,authorization)=>{
  const response=await operator.fetch(new Request('https://operator.example/v1/auth-schema-rollout',{method:'POST',body,headers:{'content-type':'application/json',...(authorization?{authorization}:{})}}));
  assert.equal(response.status,status,'Private Auth ingress must reject before any provider access');
  assert.equal(response.headers.get('cache-control'),'no-store');
  const text=await response.text();
  assert.equal(text.includes(marker),false,'Private request and configuration values must not be reflected');
  assert.deepEqual(JSON.parse(text),{code});
};
for(const request of requests){
  await privateFailure(JSON.stringify(request),403,'authorization_required');
}
await privateFailure(JSON.stringify(requests[0]),403,'authorization_required','Bearer not-a-valid-jwt');
await privateFailure('{'+marker,503,'auth_schema_rollout_unavailable');
await privateFailure(JSON.stringify({...requests[0],sql:marker,directDatabaseUrl:marker}),503,'auth_schema_rollout_unavailable');
await privateFailure(JSON.stringify({...base,action:marker}),503,'auth_schema_rollout_unavailable');
for(const method of ['DELETE','PATCH']){
  const response=await operator.fetch(new Request('https://operator.example/v1/auth-schema-rollout',{method}));
  assert.equal(response.status,404,'Unexpected methods cannot enter Auth maintenance');
  assert.deepEqual(await response.json(),{code:'not_found'});
}
assert.equal(outbound,0);
console.log('PASS compiled native operator: '+paths.length+' actual closed Services routes; Auth schema methods, malformed and unauthorized requests deny without sensitive output; zero network effects');
`,
  );
  const output = run(process.execPath, [driver]).trim();
  assert.equal(
    output.includes(sensitiveMarker),
    false,
    "Private fixture values must not reach proof output",
  );
  console.log(output);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
