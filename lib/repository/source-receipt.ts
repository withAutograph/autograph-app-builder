import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

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

export function inspectSourceContractDigest(
  sourcePath: string,
  sourceSha: string,
): string {
  const contract = contractPaths.map((contractPath) => {
    const entry = execFileSync(
      "git",
      ["-C", sourcePath, "ls-tree", sourceSha, "--", contractPath],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ).trim();
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(entry);
    if (match === null || match[3] !== contractPath)
      throw new Error(
        `Repository contract path is not a regular blob at ${sourceSha}: ${contractPath}`,
      );
    return {
      path: contractPath,
      mode: match[1],
      objectId: match[2],
      sha256: sha256(
        execFileSync(
          "git",
          ["-C", sourcePath, "show", `${sourceSha}:${contractPath}`],
          { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
        ),
      ),
    };
  });
  return sha256(JSON.stringify(contract));
}

export type SourceReceipt = {
  version: 2;
  sourceKind: SourceKind;
  sourcePath: string;
  sourceSha: string;
  sourceTree: string;
  adapter: typeof SUPPORTED_TEMPLATE_ADAPTER;
  eligibilityDigest: string;
  /** Stable digest of the supported-template contract at the reviewed SHA. */
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
  const receipt = {
    version: 2,
    sourceKind,
    sourcePath: eligibility.sourcePath,
    sourceSha: eligibility.sourceSha,
    sourceTree: execFileSync(
      "git",
      [
        "-C",
        eligibility.sourcePath,
        "rev-parse",
        `${eligibility.sourceSha}^{tree}`,
      ],
      { encoding: "utf8" },
    ).trim(),
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: eligibility.digest,
    contractDigest: inspectSourceContractDigest(
      eligibility.sourcePath,
      eligibility.sourceSha,
    ),
    releaseEnabled: false,
  } as const;
  return { ...receipt, digest: sha256(JSON.stringify(receipt)) };
}
