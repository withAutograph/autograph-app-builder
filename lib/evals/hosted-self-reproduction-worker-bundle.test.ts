/* oxlint-disable eslint/require-await -- async test compiler bridge */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { hostedEvalWorkerSource } from "./hosted-self-reproduction-worker-source";

it("preserves standalone worker imports through the installed Next webpack bundler", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hosted-worker-bundle-"));
  const require = createRequire(import.meta.url);
  const { webpack } = require("next/dist/compiled/webpack/webpack");
  try {
    const source = await readFile(
      new URL("hosted-self-reproduction-worker-source.ts", import.meta.url),
      "utf-8",
    );
    await writeFile(
      path.join(directory, "input.mjs"),
      `${source}\nexport const broken = (async () => { await import("node:child_process"); }).toString();`,
    );
    const stats = await promisify(webpack)({
      entry: path.join(directory, "input.mjs"),
      mode: "production",
      optimization: { minimize: false },
      output: { filename: "bundle.cjs", library: { type: "commonjs2" }, path: directory },
      target: "node",
    });
    expect(stats.hasErrors()).toBe(false);
    const bundled = require(path.join(directory, "bundle.cjs"));
    // Reproduces why serializing compiled functions is unsafe for a standalone VM.
    expect(bundled.broken).toContain("__webpack_require__");
    expect(bundled.hostedEvalWorkerSource).toBe(hostedEvalWorkerSource);
    expect(bundled.hostedEvalWorkerSource).toContain('import("node:child_process")');
    expect(bundled.hostedEvalWorkerSource).not.toContain("__webpack_require__");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
