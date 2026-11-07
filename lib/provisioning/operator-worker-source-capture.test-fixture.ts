import { createHash } from "node:crypto";
import { operatorWorkerCatalogReceiptSchema } from "./operator-worker-source-capture";

export const sources = {
  arrusted: { sha: "c".repeat(40), tree: "d".repeat(40) },
  builder: { sha: "a".repeat(40), tree: "b".repeat(40) },
};
const entry = {
  bytes: 12,
  entries: [
    {
      path: "packages/generated-app-runtime/protected-installer-worker.ts",
      repository: "arrusted",
    },
  ],
  mode: "100755",
  path: "bin/worker",
  sha256: "e".repeat(64),
};
export const receipt = operatorWorkerCatalogReceiptSchema.parse({
  compiler: { name: "bun", target: "bun-linux-x64", version: "1.3.14" },
  kind: "operator-worker-catalog-v1",
  sources,
  version: 1,
  workers: Object.fromEntries(
    ["genericInstaller", "authProposal", "auth", "resources", "managedRuntime"].map((family) => [
      family,
      entry,
    ]),
  ),
});
export const bytes = Buffer.from(JSON.stringify(receipt));
export const capture = {
  catalogPath: "/trusted/current/catalog.json",
  catalogSha256: createHash("sha256").update(bytes).digest("hex"),
  family: "genericInstaller" as const,
  kind: "operator-worker-catalog-v1" as const,
  sources,
};
export const worker = {
  executablePath: "/trusted/current/bin/worker",
  sha256: entry.sha256,
  sourceCapture: capture,
};
export const capturedGenericWorkerFixture = {
  executablePath: worker.executablePath,
  id: "current-generic-installer",
  operationScope: "generated-app-release-install-v1" as const,
  sha256: worker.sha256,
  sourceCapture: capture,
  subcommand: "protected-generated-app-install" as const,
};
