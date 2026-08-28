import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  hostedProofScenarioSchema,
  runHostedProof,
} from "./hosted-portable-proof";
import { verifyPortableProofArtifact } from "./portable-proof-artifact";
import { sha256 } from "./portable-release";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return value;
};

const required = (name: string) => {
  const value = argument(name);
  if (value === undefined) throw new Error(`Missing required ${name}.`);
  return value;
};

async function secretFile(pathValue: string) {
  const requested = resolve(pathValue);
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("OAuth token input must be a regular, non-symbolic file.");
  if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error("OAuth token input must be owner-bound with mode 0600.");
  const canonical = await realpath(requested);
  if (canonical !== requested)
    throw new Error("OAuth token input path must be canonical.");
  const token = (await readFile(canonical, "utf8")).trim();
  if (token === "" || token.length > 16_384 || /\s/u.test(token))
    throw new Error("OAuth token input was malformed.");
  return token;
}

const releaseRoot = await realpath(resolve(required("--release")));
const installRoot = await realpath(resolve(required("--install-root")));
const requestedScenario = resolve(required("--scenario"));
const scenarioInfo = await lstat(requestedScenario);
if (!scenarioInfo.isFile() || scenarioInfo.isSymbolicLink())
  throw new Error("Proof scenario must be a regular, non-symbolic file.");
const scenarioPath = await realpath(requestedScenario);
const verifiedArtifact = await verifyPortableProofArtifact({
  releaseRoot,
  installRoot,
  repositoryRoot: resolve("."),
});
const release = verifiedArtifact.receipt;
const receiptPath = join(releaseRoot, "release-receipt.json");

const scenarioBytes = await readFile(scenarioPath);
const scenario = hostedProofScenarioSchema.parse(
  JSON.parse(scenarioBytes.toString("utf8")),
);
const token = await secretFile(required("--token-file"));
const crossTenantToken = await secretFile(
  required("--cross-tenant-token-file"),
);
if (token === crossTenantToken)
  throw new Error("Cross-tenant proof requires a distinct principal token.");
const output = resolve(required("--receipt"));
if ((await realpath(dirname(output))) !== dirname(output))
  throw new Error("Receipt parent must be canonical.");
try {
  await lstat(output);
  throw new Error(`Proof receipt already exists: ${output}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const result = await runHostedProof({
  endpoint: release.endpoint,
  token,
  crossTenantToken,
  scenario,
  sourceSha: release.source.sha,
  sourceTree: release.source.tree,
  releaseArchiveSha256: release.archive.sha256,
  permitApprovals: process.argv.includes("--permit-approvals"),
});
const proof = {
  format: "autograph-hosted-fresh-client-proof-v1",
  specification: "agent-plugins/1.0.0",
  portableClientsPrepared: ["codex", "vscode", "cursor"],
  liveProofClient: "agent-plugins-streamable-http-harness",
  release: {
    source: release.source,
    archive: release.archive,
    receiptSha256: sha256(await readFile(receiptPath)),
  },
  endpoint: { origin: result.endpointOrigin, route: "/mcp" },
  scenario: {
    name: basename(scenarioPath),
    sha256: sha256(scenarioBytes),
    approvalsPermitted: process.argv.includes("--permit-approvals"),
  },
  evidence: {
    tools: result.discoveredTools,
    missingAuthRejected: result.missingAuthRejected,
    invalidAuthRejected: result.invalidAuthRejected,
    oauthMetadataBound: result.oauthMetadataBound,
    oauthMetadataDigest: result.oauthMetadataDigest,
    primaryIdentityDigest: result.primaryIdentityDigest,
    secondaryIdentityDigest: result.secondaryIdentityDigest,
    idempotentStart: result.idempotentStart,
    discardedStartResponseRecovered: result.discardedStartResponseRecovered,
    responseCount: result.responseCount,
    responseBatchCount: result.responseBatchCount,
    iterationProved: result.iterationProved,
    draftPrEvidenceProved: result.publicationEvidenceProved,
    draftPrEvidenceDigest: result.draftPrEvidenceDigest,
    staleSessionRejected: result.staleSessionRejected,
    mutualWorkspaceDenial: result.mutualWorkspaceDenial,
    cancellationProved: result.cancellationProved,
    publicResponsesScanned: result.publicResponsesScanned,
    publicResponseDisclosureScanDigest:
      result.publicResponseDisclosureScanDigest,
    sessionEvidenceDigest: result.sessionEvidenceDigest,
  },
  secretsPersisted: false,
  productionClaimed: false,
};
await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
console.log(`Hosted proof passed; sanitized receipt: ${output}`);
