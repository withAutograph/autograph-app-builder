import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { preserveUnissuedConnectedSchemaRelease } from "./connected-schema-release-recovery";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const exactPrior = JSON.stringify({ schema: { app_id: "demo", version: "v8" } });
const priorDigest = sha(exactPrior);
const sourceRelative = "apps/demo/schema/release/v9";
const manifestMember = "release-manifest.json";
const planMember = "transition-plan.json";
const artifactMember = "app-artifact.json";
const cuePath = "apps/demo/schema/demo.cue";
const acceptedCue = "package demo\n";
const cueDigest = sha(acceptedCue);

const writeRelease = (input: {
  directory: string;
  releaseId: string;
  artifact: string;
  transitionPlan: string;
  bundle?: string;
  cueSha256?: string;
}) => {
  const { directory, releaseId, artifact, transitionPlan } = input;
  mkdirSync(directory, { recursive: true });
  const payload = {
    schema: [artifactMember, artifact],
    source_map: ["cue-to-sql-source-map.json", "source map"],
    operation_docs: ["data-operations.md", "operation docs"],
    bindings: ["data-operations.ts", "bindings"],
    server_bindings: ["data-server.ts", "server bindings"],
    operations: ["operation-manifest.json", "operations"],
    coverage: ["runtime-coverage.json", "coverage"],
    bundle: ["sql-bundle.sql", input.bundle ?? "bundle"],
    sql_manifest: ["sql-manifest.json", "SQL manifest"],
    transition_contract: ["transition-contract.json", "transition contract"],
    plan: [planMember, transitionPlan],
  };
  for (const [member, bytes] of Object.values(payload)) {
    writeFileSync(path.join(directory, member), bytes);
  }
  const manifest = JSON.stringify({
    app: "demo",
    schema_version: releaseId,
    sources: { [cuePath]: `sha256:${input.cueSha256 ?? cueDigest}` },
    hashes: {
      ...Object.fromEntries(
        Object.entries(payload).map(([key, [, bytes]]) => [key, `sha256:${sha(bytes)}`]),
      ),
      source: "sha256:source",
      client: "sha256:client",
    },
  });
  writeFileSync(path.join(directory, manifestMember), manifest);
  return sha(manifest);
};

const fixture = (includeMarker = true, manifestCueSha256 = cueDigest) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "builder-connected-release-"));
  temporary.push(workspace);
  const checkout = path.join(workspace, "repository");
  const privateRoot = path.join(workspace, ".app-builder");
  const candidatePath = path.join(checkout, sourceRelative);
  mkdirSync(candidatePath, { recursive: true });
  mkdirSync(privateRoot);
  const git = (...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", checkout, ...args],
      { encoding: "utf-8" },
    ).trim();
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(path.join(checkout, "existing.txt"), "original source");
  writeFileSync(path.join(checkout, cuePath), acceptedCue);
  git("add", "existing.txt");
  git("commit", "--quiet", "-m", "checked source");
  const artifact = JSON.stringify({ schema: { app_id: "demo", version: "v9" } });
  const plan = { app_id: "demo", version: "v9" };
  const transitionPlan = JSON.stringify(
    includeMarker
      ? {
          ...plan,
          online_optional_text_addition: {
            kind: "optional-text-addition-v1",
            predecessor_artifact_sha256: priorDigest,
            predecessor_schema: { version: "v8" },
          },
        }
      : plan,
  );
  const manifestSha256 = writeRelease({
    directory: candidatePath,
    releaseId: "v9",
    artifact,
    transitionPlan,
    cueSha256: manifestCueSha256,
  });
  const sandbox: Parameters<typeof preserveUnissuedConnectedSchemaRelease>[0]["sandbox"] = {
    async run({ command }) {
      const process = spawnSync(
        "/bin/sh",
        ["-c", command.replace(" '/workspace' ", ` '${workspace}' `)],
        { cwd: checkout, encoding: "utf-8" },
      );
      return await Promise.resolve({
        exitCode: process.status ?? -1,
        stdout: process.stdout,
        stderr: process.stderr,
      });
    },
  };
  const run = async (
    override: Partial<Parameters<typeof preserveUnissuedConnectedSchemaRelease>[0]> = {},
  ) =>
    await preserveUnissuedConnectedSchemaRelease({
      sandbox,
      appId: "demo",
      releaseId: "v9",
      expectedArtifactSha256: sha(artifact),
      expectedManifestSha256: manifestSha256,
      expectedPredecessorArtifactSha256: priorDigest,
      expectedSourceSha: git("rev-parse", "HEAD"),
      ...override,
    });
  return { artifact, candidatePath, checkout, git, privateRoot, run };
};

it("preserves and resumes the exact unissued cut with a missing stale predecessor", async () => {
  const { artifact, candidatePath, checkout, privateRoot, run } = fixture();
  await expect(run()).resolves.toBe(true);
  expect(existsSync(candidatePath)).toBe(false);
  const [retained] = readdirSync(privateRoot);
  expect(readFileSync(path.join(privateRoot, retained, "v9", artifactMember), "utf-8")).toBe(
    artifact,
  );
  expect(readFileSync(path.join(checkout, "existing.txt"), "utf-8")).toBe("original source");
  await expect(run()).resolves.toBe(true);
  expect(readdirSync(privateRoot)).toEqual([retained]);
  await expect(run({ expectedSourceSha: "a".repeat(40) })).rejects.toThrow("could not verify");
});

const restoredFixture = (includeMarker = true, manifestCueSha256 = cueDigest) => {
  const f = fixture(includeMarker, manifestCueSha256);
  const directory = path.join(f.checkout, "apps/demo/schema/release/v8");
  const release = {
    directory,
    releaseId: "v8",
    artifact: exactPrior,
    transitionPlan: JSON.stringify({ app_id: "demo", version: "v8" }),
  };
  const previousManifestSha256 = writeRelease({ ...release, bundle: "old private SQL" });
  const publishedManifestSha256 = writeRelease({ ...release, bundle: "current published SQL" });
  f.git("add", "apps/demo/schema/release/v8");
  f.git("commit", "--quiet", "-m", "published v8");
  return {
    ...f,
    directory,
    proof: { releaseId: "v8", previousManifestSha256, publishedManifestSha256 },
  };
};

it("keeps and verifies the published predecessor when only its generated SQL changed", async () => {
  const { run, proof, directory, candidatePath, privateRoot } = restoredFixture();
  await expect(run()).resolves.toBe(false);
  await expect(run({ restoredPublishedPredecessor: proof })).resolves.toBe(true);
  expect(existsSync(candidatePath)).toBe(false);
  expect(readFileSync(path.join(directory, artifactMember), "utf-8")).toBe(exactPrior);
  expect(readFileSync(path.join(directory, "sql-bundle.sql"), "utf-8")).toBe(
    "current published SQL",
  );
  expect(readdirSync(privateRoot)).toHaveLength(1);
  await expect(run({ restoredPublishedPredecessor: proof })).resolves.toBe(true);
});

it.each([
  ["wrong release", { releaseId: "v7" }],
  ["wrong current digest", { publishedManifestSha256: "f".repeat(64) }],
])("does not use a published predecessor with %s", async (_reason, change) => {
  const { run, proof, candidatePath, privateRoot } = restoredFixture();
  await expect(run({ restoredPublishedPredecessor: { ...proof, ...change } })).resolves.toBe(false);
  expect(existsSync(candidatePath)).toBe(true);
  expect(readdirSync(privateRoot)).toEqual([]);
});

it("preserves an online candidate when the manifest did not change", async () => {
  const { run, proof, candidatePath, privateRoot } = restoredFixture();
  await expect(
    run({
      restoredPublishedPredecessor: {
        ...proof,
        previousManifestSha256: proof.publishedManifestSha256,
      },
    }),
  ).resolves.toBe(false);
  expect(existsSync(candidatePath)).toBe(true);
  expect(readdirSync(privateRoot)).toEqual([]);
});

it("rejects a changed checked predecessor member", async () => {
  const { run, proof, directory, candidatePath, privateRoot } = restoredFixture();
  writeFileSync(path.join(directory, "sql-bundle.sql"), "modified after publication");
  await expect(run({ restoredPublishedPredecessor: proof })).rejects.toThrow("could not verify");
  expect(existsSync(candidatePath)).toBe(true);
  expect(readdirSync(privateRoot)).toEqual([]);
});

it("preserves a marker-less captured cut on exact CUE and published predecessor proof", async () => {
  const { run, proof, artifact, candidatePath, privateRoot } = restoredFixture(false);
  const options = {
    expectedCueSha256: cueDigest,
    restoredPublishedPredecessor: {
      ...proof,
      previousManifestSha256: proof.publishedManifestSha256,
    },
  };
  await expect(run({ expectedCueSha256: cueDigest })).resolves.toBe(false);
  await expect(run({ restoredPublishedPredecessor: proof })).resolves.toBe(false);
  await expect(run(options)).resolves.toBe(true);
  await expect(run(options)).resolves.toBe(true);

  writeRelease({
    directory: candidatePath,
    releaseId: "v9",
    artifact,
    transitionPlan: JSON.stringify({ app_id: "demo", version: "v9", regenerated: true }),
  });
  await expect(run(options)).resolves.toBe(false);
  expect(existsSync(candidatePath)).toBe(true);
  expect(readdirSync(privateRoot)).toHaveLength(1);
});

it.each(["working CUE", "captured CUE", "checked predecessor"] as const)(
  "retains the marker-less cut if verification cannot prove the %s",
  async (mismatch) => {
    const { run, proof, directory, checkout, candidatePath, privateRoot } = restoredFixture(
      false,
      mismatch === "captured CUE" ? "c".repeat(64) : cueDigest,
    );
    if (mismatch === "working CUE") {
      writeFileSync(path.join(checkout, cuePath), "changed CUE\n");
    }
    if (mismatch === "checked predecessor") {
      rmSync(directory, { force: true, recursive: true });
    }
    await expect(
      run({ expectedCueSha256: cueDigest, restoredPublishedPredecessor: proof }),
    ).resolves.toBe(false);
    expect(existsSync(candidatePath)).toBe(true);
    expect(readdirSync(privateRoot)).toEqual([]);
  },
);

it.each([
  "staged",
  "committed",
  "changed manifest",
  "extra member",
  "existing predecessor",
  "without marker",
] as const)("keeps the live workspace unchanged when the release is %s", async (reason) => {
  const { candidatePath, checkout, git, privateRoot, run } = fixture(reason !== "without marker");
  if (reason === "staged" || reason === "committed") {
    git("add", sourceRelative);
  }
  if (reason === "committed") {
    git("commit", "--quiet", "-m", "already issued");
  }
  if (reason === "changed manifest") {
    writeFileSync(path.join(candidatePath, manifestMember), "{}");
  }
  if (reason === "extra member") {
    writeFileSync(path.join(candidatePath, "unverified.txt"), "other work");
  }
  if (reason === "existing predecessor") {
    const previous = path.join(checkout, "apps/demo/schema/release/v8");
    mkdirSync(previous);
    writeFileSync(path.join(previous, artifactMember), exactPrior);
  }
  await expect(run()).resolves.toBe(false);
  expect(existsSync(candidatePath)).toBe(true);
  expect(readdirSync(privateRoot)).toEqual([]);
});

it("rejects a member symlink without moving the release", async () => {
  const { candidatePath, checkout, privateRoot, run } = fixture();
  const artifactPath = path.join(candidatePath, artifactMember);
  rmSync(artifactPath);
  symlinkSync(path.join(checkout, "existing.txt"), artifactPath);
  await expect(run()).rejects.toThrow("could not verify");
  expect(existsSync(candidatePath)).toBe(true);
  expect(readdirSync(privateRoot)).toEqual([]);
});

it("rejects changed bytes covered by the retained manifest", async () => {
  const { candidatePath, privateRoot, run } = fixture();
  writeFileSync(path.join(candidatePath, "sql-bundle.sql"), "unapproved change");
  await expect(run()).rejects.toThrow("could not verify");
  expect(existsSync(candidatePath)).toBe(true);
  expect(readdirSync(privateRoot)).toEqual([]);
});
