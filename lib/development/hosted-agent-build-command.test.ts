import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { hostedEveBuildCommand } from "./hosted-agent-build-command";

const require = createRequire(import.meta.url);
const roots: string[] = [];
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hosted-eve-command-")));
  roots.push(root);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  const guard = ".config/mise/scripts/repository/assert-hosted-eve-build-budget.mts";
  await mkdir(path.dirname(path.join(root, guard)), { recursive: true });
  await writeFile(path.join(root, guard), await readFile(path.resolve(guard)));
  return root;
};
afterEach(async () => {
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

it("carries the budget through the actual Next/Eve generated Services command", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "agent"));
  await writeFile(path.join(root, "agent", "instructions.md"), "Synthetic command fixture.\n");
  await mkdir(path.join(root, ".vercel", "output"), { recursive: true });
  const config = path.resolve("next.config.ts");
  const script = `import nextConfig from ${JSON.stringify(config)};
await nextConfig("phase-production-server", {});`;
  execFileSync(
    process.execPath,
    ["--import", require.resolve("tsx"), "--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf-8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", VERCEL: "1" },
    },
  );
  const output = z
    .object({
      services: z.object({
        eve: z.object({ buildCommand: z.string(), framework: z.literal("eve") }),
      }),
    })
    .parse(
      JSON.parse(await readFile(path.join(root, ".vercel", "output", "config.json"), "utf-8")),
    );
  const service = output.services.eve;
  expect(service.framework).toBe("eve");
  expect(service.buildCommand).toContain("EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY=");
  expect(service.buildCommand).toContain("EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY=");
  expect(service.buildCommand.endsWith(` && ${hostedEveBuildCommand}`)).toBe(true);
  expect(service.buildCommand).not.toContain("--skip-sandbox-prewarm");
});

it("bounds the actual Node child heap while preserving other Node options and CLI arguments", async () => {
  const root = await fixture();
  const binary = path.join(root, "node_modules", "eve", "bin", "eve.js");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(
    binary,
    `import v8 from "node:v8";
console.log(JSON.stringify({heapLimit:v8.getHeapStatistics().heap_size_limit,args:process.argv.slice(2),options:process.env.NODE_OPTIONS}));\n`,
  );
  const result = execFileSync("/bin/sh", ["-c", hostedEveBuildCommand], {
    cwd: root,
    encoding: "utf-8",
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      NODE_ENV: "production",
      NODE_OPTIONS: "--no-warnings --max-old-space-size=4096",
    },
  });
  const observed = z
    .object({ args: z.array(z.string()), heapLimit: z.number().positive(), options: z.string() })
    .parse(JSON.parse(result));
  expect(observed.args).toEqual(["build"]);
  expect(observed.options).toContain("--no-warnings");
  expect(observed.heapLimit).toBeGreaterThan(2 * 1024 ** 3);
  expect(observed.heapLimit).toBeLessThan(2.2 * 1024 ** 3);
});

it("rejects a percentage heap override before initializing Eve without exposing options", async () => {
  const root = await fixture();
  const binary = path.join(root, "node_modules", "eve", "bin", "eve.js");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, 'console.log("EVE_INITIALIZED");\n');
  const result = spawnSync("/bin/sh", ["-c", hostedEveBuildCommand], {
    cwd: root,
    encoding: "utf-8",
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      NODE_ENV: "production",
      NODE_OPTIONS: "--max-old-space-size-percentage=100",
    },
  });
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("EVE_INITIALIZED");
  expect(result.stderr).toContain("Remove conflicting Node heap options");
  expect(result.stderr).not.toContain("--max-old-space-size-percentage");
});
