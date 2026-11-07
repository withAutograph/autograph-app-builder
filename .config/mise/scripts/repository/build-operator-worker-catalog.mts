/* oxlint-disable eslint/no-await-in-loop, eslint/no-bitwise -- Release build steps depend on prior emitted files; POSIX executable modes are verified by their permission bits. */
import { execFile } from "node:child_process";
import type { z } from "zod";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  operatorWorkerCatalogReceiptSchema,
  operatorWorkerFamilySchema,
} from "../../../../lib/provisioning/operator-worker-source-capture";

const [arrustedArgument, outputArgument, bunArgument, ...extra] = process.argv.slice(2);
if (!arrustedArgument || !outputArgument || !bunArgument || extra.length) {
  throw new Error(
    "Expected Arrusted source directory, fresh external output directory, Bun executable",
  );
}
const builder = await realpath(process.cwd());
const arrusted = await realpath(arrustedArgument);
const bun = await realpath(bunArgument);
const outputParent = await realpath(path.dirname(path.resolve(outputArgument)));
const output = path.join(outputParent, path.basename(outputArgument));
for (const source of [builder, arrusted]) {
  const relative = path.relative(source, output);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("Worker outputs must remain outside both source checkouts");
  }
}
const environment = {
  HOME: process.env.HOME,
  NODE_ENV: "production" as const,
  PATH: process.env.PATH,
};
const command = async (cwd: string, executable: string, args: string[]) => {
  try {
    // oxlint-disable-next-line promise/avoid-new -- Node execFile exposes the bounded subprocess completion through a callback.
    return await new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        args,
        { cwd, encoding: "utf-8", env: environment, maxBuffer: 4 * 1024 * 1024 },
        (error: Error | null, stdout: string) => {
          if (error === null) {
            resolve(stdout.trim());
          } else {
            reject(error);
          }
        },
      );
    });
  } catch {
    throw new Error(
      `Worker catalog build failed (${path.basename(executable)} ${path.basename(args[0] ?? "")}); no catalog receipt published`,
    );
  }
};
const identify = async (cwd: string) => {
  if (await command(cwd, "git", ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Release worker source must be a clean committed checkout");
  }
  return {
    sha: await command(cwd, "git", ["rev-parse", "HEAD"]),
    tree: await command(cwd, "git", ["rev-parse", "HEAD^{tree}"]),
  };
};
const sources = { arrusted: await identify(arrusted), builder: await identify(builder) };
if ((await command(builder, bun, ["--version"])) !== "1.3.14") {
  throw new Error("Expected maintained Bun 1.3.14 compiler");
}
// Exclusive creation: never replace an old release, partial build, receipt or legacy catalog.
await mkdir(output, { mode: 0o700 });
await mkdir(path.join(output, "bin"), { mode: 0o700 });
await mkdir(path.join(output, "intermediate"), { mode: 0o700 });
const binary = (family: string) => path.join(output, "bin", `${family}-linux-x64`);
const repositoryScript = (name: string) => `.config/mise/scripts/repository/${name}.mjs`;
await command(arrusted, bun, [
  repositoryScript("build-protected-generated-app-worker"),
  binary("genericInstaller"),
  "bun-linux-x64",
]);
await command(arrusted, bun, [
  repositoryScript("build-protected-auth-proposal"),
  binary("authProposal"),
  "bun-linux-x64",
]);
for (const [family, script, emitted] of [
  ["auth", "build-protected-auth-worker", "protected-installer-worker.js"],
  ["resources", "build-neon-resource-bootstrap-worker", "neon-resource-bootstrap-worker.js"],
]) {
  const intermediate = path.join(output, "intermediate", family);
  await mkdir(intermediate, { mode: 0o700 });
  await command(arrusted, bun, [repositoryScript(script), intermediate]);
  await command(arrusted, bun, [
    "build",
    path.join(intermediate, emitted),
    "--compile",
    "--target=bun-linux-x64",
    "--outfile",
    binary(family),
  ]);
}
await command(builder, bun, [
  "scripts/build-managed-runtime-worker.mjs",
  arrusted,
  binary("managedRuntime"),
  "bun-linux-x64",
]);
type CatalogWorkers = z.infer<typeof operatorWorkerCatalogReceiptSchema>["workers"];
const entries = {
  auth: [{ path: "packages/auth/protected-installer-worker.ts", repository: "arrusted" }],
  authProposal: [
    { path: ".config/mise/scripts/repository/auth-schema-proposal.ts", repository: "arrusted" },
  ],
  genericInstaller: [
    {
      path: "packages/generated-app-runtime/protected-installer-worker.ts",
      repository: "arrusted",
    },
  ],
  managedRuntime: [
    { path: "lib/agent/managed-runtime-entry.ts", repository: "builder" },
    {
      path: "packages/platform-microfrontends/src/policy/managed-gateway-verification.ts",
      repository: "arrusted",
    },
  ],
  resources: [
    { path: "packages/provisioning/neon-resource-bootstrap-worker.ts", repository: "arrusted" },
  ],
} satisfies { [Family in keyof CatalogWorkers]: CatalogWorkers[Family]["entries"] };
const workers: Partial<CatalogWorkers> = {};
for (const family of operatorWorkerFamilySchema.options) {
  const file = binary(family);
  await chmod(file, 0o755);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o755) {
    throw new Error("Invalid compiled worker file");
  }
  const bytes = await readFile(file);
  // This catalog is a Linux x64 deployment input, not a host-native executable build.
  if (
    bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[18] !== 62 ||
    bytes[19] !== 0
  ) {
    throw new Error("Compiled worker is not Linux x64 ELF");
  }
  workers[family] = {
    bytes: bytes.length,
    entries: entries[family],
    mode: "100755",
    path: `bin/${family}-linux-x64`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const after = { arrusted: await identify(arrusted), builder: await identify(builder) };
if (JSON.stringify(after) !== JSON.stringify(sources)) {
  throw new Error("Source changed during release worker build; receipt not published");
}
const receipt = operatorWorkerCatalogReceiptSchema.parse({
  compiler: { name: "bun", target: "bun-linux-x64", version: "1.3.14" },
  kind: "operator-worker-catalog-v1",
  sources,
  version: 1,
  workers,
});
const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
const catalogPath = path.join(output, "catalog.json");
// Completion last. Build failures retain their owned partial output for diagnosis.
await writeFile(catalogPath, bytes, { flag: "wx", mode: 0o600 });
const observedReceipt = await readFile(catalogPath);
if (!observedReceipt.equals(bytes)) {
  throw new Error("Catalog receipt readback failed");
}
console.log(
  JSON.stringify({
    catalogPath,
    catalogSha256: createHash("sha256").update(bytes).digest("hex"),
    sources,
    workers: receipt.workers,
  }),
);
