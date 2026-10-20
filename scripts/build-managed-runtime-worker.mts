#!/usr/bin/env bun
// Source-owned cross-repository bundle, invoked explicitly by the deployment owner.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The installed Bun runtime owns this supported API; no runtime package is installed by this builder.
declare const Bun: {
  version: string;
  build: (input: {
    entrypoints: string[];
    target: "bun";
    compile: { target: string; outfile: string };
  }) => Promise<{ success: boolean }>;
};

const [arrustedRoot, outputFile, target = "bun-linux-x64", ...extra] = process.argv.slice(2);
if (!arrustedRoot || !outputFile || extra.length) {
  throw new Error("Expected Arrusted source root, output executable, optional Bun target");
}
const directory = await mkdtemp(path.join(tmpdir(), "autograph-managed-runtime-build-"));
try {
  const entry = path.join(directory, "entry.ts");
  const builder = path.resolve("lib/agent/managed-runtime-entry.ts");
  const verifier = path.resolve(
    arrustedRoot,
    "packages/platform-microfrontends/src/policy/managed-gateway-verification.ts",
  );
  await writeFile(
    entry,
    `import {runManagedRuntimeEntryCli} from ${JSON.stringify(builder)};\nimport {createManagedGatewayVerification,verifyManagedGatewayRequest} from ${JSON.stringify(verifier)};\nawait runManagedRuntimeEntryCli({createVerification:createManagedGatewayVerification,verifyRequest:verifyManagedGatewayRequest});\n`,
    { mode: 0o600, flag: "wx" },
  );
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    compile: { target, outfile: path.resolve(outputFile) },
  });
  if (!result.success) {
    throw new Error("Managed runtime executable build failed");
  }
  const bytes = await readFile(outputFile);
  const compiler = `bun@${Bun.version}`;
  process.stdout.write(
    `${JSON.stringify({ compiler, target, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length })}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
