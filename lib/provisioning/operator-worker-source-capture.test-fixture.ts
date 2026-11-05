import { createHash } from "node:crypto";
import { operatorWorkerCatalogReceiptSchema } from "./operator-worker-source-capture";

export const sources = {
  builder: { sha: "a".repeat(40), tree: "b".repeat(40) },
  arrusted: { sha: "c".repeat(40), tree: "d".repeat(40) },
};
const entry = {
  path: "bin/worker",
  sha256: "e".repeat(64),
  bytes: 12,
  mode: "100755",
  entries: [
    {
      repository: "arrusted",
      path: "packages/generated-app-runtime/protected-installer-worker.ts",
    },
  ],
};
export const receipt = operatorWorkerCatalogReceiptSchema.parse({
  version: 1,
  kind: "operator-worker-catalog-v1",
  sources,
  compiler: { name: "bun", version: "1.3.14", target: "bun-linux-x64" },
  workers: Object.fromEntries(
    ["genericInstaller", "authProposal", "auth", "resources", "managedRuntime"].map((family) => [
      family,
      entry,
    ]),
  ),
});
export const bytes = Buffer.from(JSON.stringify(receipt));
export const capture = {
  kind: "operator-worker-catalog-v1" as const,
  catalogPath: "/trusted/current/catalog.json",
  catalogSha256: createHash("sha256").update(bytes).digest("hex"),
  family: "genericInstaller" as const,
  sources,
};
export const worker = {
  executablePath: "/trusted/current/bin/worker",
  sha256: entry.sha256,
  sourceCapture: capture,
};
export const capturedGenericWorkerFixture = {
  id: "current-generic-installer",
  executablePath: worker.executablePath,
  sha256: worker.sha256,
  sourceCapture: capture,
  operationScope: "generated-app-release-install-v1" as const,
  subcommand: "protected-generated-app-install" as const,
};
