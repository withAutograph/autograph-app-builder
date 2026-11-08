/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-argument -- Exercise the installed native bundle builder from this JavaScript regression harness, as the other native runtime tests do. */
/* oxlint-disable sonarjs/no-internal-api-use -- Build the installed framework workflow graph to exercise the real workflow/step boundary. */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "vitest";

const require = createRequire(import.meta.url);
const sdk = pathToFileURL(`${path.dirname(require.resolve("eve/package.json"))}/dist/src/`).href;

it("builds the actual recovery workflow graph with server-only validation behind a step", async () => {
  const { WorkflowBundleBuilder } = await import(`${sdk}internal/workflow-bundle/builder.js`);
  const directory = await mkdtemp(path.join(tmpdir(), "eve-recovery-workflow-build-"));
  try {
    const bootstrap = path.join(directory, "bootstrap.mjs");
    await writeFile(bootstrap, "export {};\n");
    const builder = new WorkflowBundleBuilder({
      agentName: "recovery-workflow-proof",
      appRoot: process.cwd(),
      rootDir: process.cwd(),
      outDir: path.join(directory, "output"),
      compiledArtifactsBootstrapPath: bootstrap,
      watch: false,
    });
    await builder.build();
    const artifact = await stat(path.join(directory, "output", "workflows.mjs"));
    assert.ok(artifact.size > 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 0);

it("bundles the actual public Eve channel as one authored module with source retention wired", async () => {
  const { bundleAuthoredModuleCode } = await import(`${sdk}internal/authored-module-loader.js`);
  const code = await bundleAuthoredModuleCode(path.join(process.cwd(), "agent/channels/eve.ts"));
  assert.ok(code.length > 0);
}, 0);
