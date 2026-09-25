import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";
import { z } from "zod";

import { sandboxGitHubSourceManifestProgram } from "./sandbox-github-source";

const git = "/usr/bin/git";
const sourceManifestResult = z.strictObject({
  sourceSha: z.string(),
  sourceTree: z.string(),
  workspaceDigest: z.string(),
});
const sourceFile = z.strictObject({
  mode: z.string(),
  objectId: z.string(),
  path: z.string(),
  sha256: z.string(),
});

it("records a generic provider checkout manifest from a linked Git source", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "builder-github-source-"));
  try {
    const checkout = path.join(temporary, "checkout");
    const app = path.join(checkout, "apps", "demo");
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, "page.tsx"), "export default function Page() { return null; }\n");
    symlinkSync("page.tsx", path.join(app, "page-link.tsx"));
    execFileSync(git, ["init", "-q", checkout]);
    execFileSync(git, ["-C", checkout, "add", "--all"]);
    execFileSync(git, [
      "-C",
      checkout,
      "-c",
      "user.name=Builder Test",
      "-c",
      "user.email=builder-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "seed",
    ]);
    const repository = path.join(temporary, "repository");
    symlinkSync(checkout, repository);
    const metadata = path.join(temporary, ".app-builder");
    const result = sourceManifestResult.parse(
      JSON.parse(
        execFileSync(
          process.execPath,
          ["-e", sandboxGitHubSourceManifestProgram(repository, metadata)],
          { encoding: "utf-8" },
        ),
      ),
    );
    const files = z
      .array(sourceFile)
      .parse(JSON.parse(readFileSync(path.join(metadata, "source-files.json"), "utf-8")));
    expect(files).toEqual([
      {
        mode: "100644",
        objectId: execFileSync(git, ["-C", checkout, "rev-parse", "HEAD:apps/demo/page.tsx"], {
          encoding: "utf-8",
        }).trim(),
        path: "apps/demo/page.tsx",
        sha256: createHash("sha256")
          .update("export default function Page() { return null; }\n")
          .digest("hex"),
      },
    ]);
    expect(result.sourceSha).toBe(
      execFileSync(git, ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim(),
    );
    expect(result.workspaceDigest).toBe(
      createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    );
    expect(readFileSync(path.join(metadata, "source-checksums.sha256"), "utf-8")).toBe(
      `${files[0]?.sha256}  repository/apps/demo/page.tsx\n`,
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});
