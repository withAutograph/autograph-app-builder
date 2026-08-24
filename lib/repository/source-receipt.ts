import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  inspectSupportedRepository,
  SUPPORTED_TEMPLATE_ADAPTER,
} from "./supported-template";

export type SourceKind = "existing-repository" | "fresh-template";

const contractPaths = [
  ".config/mise/config.toml",
  ".github/workflows/cd.yml",
  ".config/mise/scripts/repository/app-contract.ts",
  ".config/mise/scripts/repository/repository-preflight.ts",
  ".config/mise/scripts/repository/repository-release-gate.sh",
  ".config/turbo/generators/config.ts",
] as const;

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export type SourceReceipt = {
  version: 1;
  sourceKind: SourceKind;
  sourcePath: string;
  sourceSha: string;
  adapter: typeof SUPPORTED_TEMPLATE_ADAPTER;
  eligibilityDigest: string;
  contractDigest: string;
  releaseEnabled: false;
  digest: string;
};

export async function inspectSourceReceipt(
  sourceKind: SourceKind,
  path: string,
): Promise<SourceReceipt> {
  const eligibility = await inspectSupportedRepository(path);
  if (!eligibility.eligible || eligibility.sourceSha === undefined)
    throw new Error(
      `Source is not eligible: ${eligibility.failures.join("; ")}`,
    );
  const contract = contractPaths.map((contractPath) => ({
    path: contractPath,
    sha256: sha256(readFileSync(resolve(eligibility.sourcePath, contractPath))),
  }));
  const receipt = {
    version: 1,
    sourceKind,
    sourcePath: eligibility.sourcePath,
    sourceSha: eligibility.sourceSha,
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: eligibility.digest,
    contractDigest: sha256(JSON.stringify(contract)),
    releaseEnabled: false,
  } as const;
  return { ...receipt, digest: sha256(JSON.stringify(receipt)) };
}
