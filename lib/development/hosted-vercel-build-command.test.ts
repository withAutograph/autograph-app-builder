import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import configuration from "../../vercel.json";

// oxlint-disable-next-line typescript/strict-void-return -- Adapt Node's overloaded callback API.
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const outputSchema = z.object({
  services: z.record(z.string(), z.object({ buildCommand: z.string(), root: z.string() })),
});

it("prepares the hosted app and delegates Eve output to the generated service build", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hosted-vercel-build-"));
  const write = async (relative: string, content: string) => {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  };
  try {
    await write("package.json", JSON.stringify({ type: "module" }));
    await write("vercel.json", JSON.stringify(configuration));
    await write(".vercel/project.json", JSON.stringify({ projectId: "fixture-project" }));
    await write(
      ".config/mise/scripts/prepare-emulate-runtime.mjs",
      `import {writeFileSync} from 'node:fs';
       writeFileSync('prepared-runtime', 'prepared');`,
    );
    await write(
      ".config/mise/scripts/repository/generate-hosted-runtime-assets.mts",
      `import {readFileSync,writeFileSync} from 'node:fs';
       if(readFileSync('prepared-runtime','utf8') !== 'prepared') throw Error('Runtime preparation missing');
       writeFileSync('hosted-assets', 'generated');`,
    );
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await symlink(
      path.dirname(require.resolve("tsx/package.json")),
      path.join(root, "node_modules/tsx"),
    );
    const generator = pathToFileURL(
      path.join(
        path.dirname(require.resolve("eve/package.json")),
        "dist/src/public/next/vercel-output-config.js",
      ),
    ).href;
    await write(
      "node_modules/next/dist/bin/next",
      `import {readFileSync,writeFileSync} from 'node:fs';
       import {ensureEveVercelOutputConfig} from ${JSON.stringify(generator)};
       if(readFileSync('hosted-assets','utf8') !== 'generated') throw Error('Hosted assets missing');
       if(!process.argv.includes('--webpack')) throw Error('Required webpack build mode missing');
       await ensureEveVercelOutputConfig({nextRoot:process.cwd(), agents:[{
         appRoot:process.cwd(), buildCommand:'node node_modules/eve/bin/eve.js build',
         publicRoutePrefix:'', servicePrefix:'/_eve_internal/eve'
       }]});
       writeFileSync('next-prepared', 'ready');`,
    );
    await write(
      "node_modules/eve/bin/eve.js",
      `import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
       import {resolve,join} from 'node:path';
       const serviceOutput=process.env.EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY;
       const hostOutput=process.env.EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY;
       if(!serviceOutput || !hostOutput) throw Error('Standalone Eve build cannot own hosted output');
       if(resolve(serviceOutput) === resolve(hostOutput)) throw Error('Service output must be isolated');
       if(readFileSync('next-prepared','utf8') !== 'ready') throw Error('Next service generation missing');
       mkdirSync(serviceOutput,{recursive:true});
       writeFileSync(join(serviceOutput,'fixture-eve-built'), 'service-owned');`,
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      VERCEL: "1",
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    };
    delete environment.NODE_OPTIONS;
    delete environment.EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY;
    delete environment.EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY;
    await execute("/bin/sh", ["-c", configuration.buildCommand], { cwd: root, env: environment });
    const outputPath = path.join(root, ".vercel/output/config.json");
    const hostOutput = await readFile(outputPath, "utf-8");
    const generated = outputSchema.parse(JSON.parse(hostOutput));
    const service = Object.values(generated.services)[0];
    if (service === undefined) {
      throw new Error("Hosted Next integration did not generate an Eve service");
    }
    // Execute the real installed generator's service command as the build scheduler would.
    await execute("/bin/sh", ["-c", service.buildCommand], {
      cwd: path.join(root, service.root),
      env: environment,
    });
    expect(
      await readFile(path.join(root, service.root, ".vercel/output/fixture-eve-built"), "utf-8"),
    ).toBe("service-owned");
    // The child build leaves the host's generated routing/service output intact.
    expect(await readFile(outputPath, "utf-8")).toBe(hostOutput);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
