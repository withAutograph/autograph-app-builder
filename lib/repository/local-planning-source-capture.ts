import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import { LocalPlanningSourcePrerequisiteError } from "./local-planning-source-prerequisite";
import { localSourceBaselineManifestSchema } from "./local-source-baseline-contract";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { safeSourcePath } from "./source-path";
import { inspectDevelopmentSourceGeneration } from "./development-source-generation";
import { processStdoutByteStream } from "./captured-process-output";
import { z } from "zod";

const gitHashObjectCommand = "hash-object";
const gitNoFiltersOption = "--no-filters";

const objectId = z.string().regex(/^[a-f0-9]{40}$/u);
const gitExecutable = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
const fixedGitArgs = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
];
const gitEnvironment = {
  NODE_ENV: process.env.NODE_ENV ?? "production",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Autograph Builder",
  GIT_AUTHOR_EMAIL: "builder@autograph.so",
  GIT_COMMITTER_NAME: "Autograph Builder",
  GIT_COMMITTER_EMAIL: "builder@autograph.so",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  PATH: "/usr/bin:/bin",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const runGit = (args: readonly string[], input?: string | Buffer) =>
  execFileSync(gitExecutable, [...fixedGitArgs, ...args], {
    encoding: "utf-8",
    env: gitEnvironment,
    input,
    maxBuffer: Infinity,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();

const assertStableCaptureGeneration = async (
  root: string,
  generation: Awaited<ReturnType<typeof inspectDevelopmentSourceGeneration>>,
  links: readonly [string, string][],
  inspectSource: typeof inspectDevelopmentSourceGeneration,
) => {
  const current = await inspectSource(root);
  const currentLinks: [string, string][] = [];
  for (const name of current.names) {
    const absolute = path.join(root, name);
    if (lstatSync(absolute).isSymbolicLink()) {
      currentLinks.push([name, readlinkSync(absolute)]);
    }
  }
  const stable = [
    current.sourceSha === generation.sourceSha,
    current.workspaceDigest === generation.workspaceDigest,
    JSON.stringify(current.names) === JSON.stringify(generation.names),
    JSON.stringify(currentLinks) === JSON.stringify(links),
  ].every(Boolean);
  if (!stable) {
    throw new Error(
      "The local source changed while its planning bytes were captured. Prepare again; the app checkout is unchanged.",
    );
  }
};

const selectedLocalSourcePath = (root: string, name: string) => {
  if (!safeSourcePath(name) || name.split("/").includes(".git")) {
    throw new Error("Local source contains an unsafe file path.");
  }
  const absolute = path.join(root, name);
  const parent = realpathSync(path.dirname(absolute));
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new Error("Local source crosses its selected checkout boundary.");
  }
  return absolute;
};

/** Capture actual live bytes into private Git objects; original checkout, refs and index stay untouched. */
export const captureLocalPlanningSource = async (
  sourcePath: string,
  originalSourceSha: string,
  dependencies: {
    readAuthority?: typeof readLocalOperatorArtifactAuthority;
    inspectSource?: typeof inspectDevelopmentSourceGeneration;
  } = {},
) => {
  objectId.parse(originalSourceSha);
  const authority = await (dependencies.readAuthority ?? readLocalOperatorArtifactAuthority)();
  const retainedRunsRoot =
    authority === undefined ? undefined : path.join(authority.stateRoot, "runs");
  const inspectSource = dependencies.inspectSource ?? inspectDevelopmentSourceGeneration;
  const generation = await inspectSource(sourcePath);
  const root = generation.sourcePath;
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "app-builder-local-planning-")));
  const gitDir = path.join(directory, "source.git");
  try {
    runGit([
      "clone",
      "--bare",
      "--shared",
      "--no-hardlinks",
      "--no-tags",
      "--template=",
      root,
      gitDir,
    ]);
    const git = (args: readonly string[], input?: string | Buffer) =>
      runGit(["--git-dir", gitDir, ...args], input);
    git(["cat-file", "-e", `${originalSourceSha}^{commit}`]);
    const sourceSha = objectId.parse(git(["rev-parse", "HEAD"]));
    if (sourceSha !== generation.sourceSha) {
      throw new Error(
        "The local source advanced while its planning input was captured. Retry preparation; the app checkout is unchanged.",
      );
    }
    git(["read-tree", "--empty"]);
    const regular: { name: string; absolute: string; mode: string }[] = [];
    const records: string[] = [];
    const links: [string, string][] = [];
    for (const name of generation.names) {
      const absolute = selectedLocalSourcePath(root, name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        links.push([name, target]);
        const oid = objectId.parse(
          git([gitHashObjectCommand, "-w", gitNoFiltersOption, "--stdin"], Buffer.from(target)),
        );
        records.push(`120000 ${oid}\t${name}`);
      } else if (info.isFile()) {
        // oxlint-disable-next-line eslint/no-bitwise -- Preserve the actual executable mode.
        regular.push({ name, absolute, mode: (info.mode & 0o111) === 0 ? "100644" : "100755" });
      } else {
        throw new Error(
          "The local source contains a non-file Git entry that cannot be reconciled; the app checkout is unchanged.",
        );
      }
    }
    // Batch argv for the operating system's command limit, without a total file limit.
    for (let offset = 0; offset < regular.length; offset += 256) {
      const batch = regular.slice(offset, offset + 256);
      const ids = git([
        gitHashObjectCommand,
        "-w",
        gitNoFiltersOption,
        "--",
        ...batch.map((file) => file.absolute),
      ])
        .split("\n")
        .map((value) => objectId.parse(value));
      if (ids.length !== batch.length) {
        throw new Error("Git did not capture every selected local source file.");
      }
      for (const [index, file] of batch.entries()) {
        records.push(`${file.mode} ${ids[index]}\t${file.name}`);
      }
    }
    git(["update-index", "-z", "--index-info"], Buffer.from(`${records.join("\0")}\0`));
    const snapshotTree = objectId.parse(git(["write-tree"]));
    await assertStableCaptureGeneration(root, generation, links, inspectSource);
    // This is a private planning tree, not host Git history. Parent only the
    // actual retained base so an incremental bundle never requires unrelated
    // merged host ancestors that the file-archive candidate does not possess.
    const snapshotSha = objectId.parse(
      git(
        ["commit-tree", snapshotTree, "-p", originalSourceSha],
        "Current local Builder planning source\n",
      ),
    );
    const packOriginalBase = (
      baseSha: string,
      expectedWorkspaceDigest: string,
      linksCapturedAtPreparation = false,
      authoritySourceSha = originalSourceSha,
    ):
      | {
          originalSourceSha: string;
          sourceSha: string;
          sourceTree: string;
          streamPack: () => ReadableStream<Uint8Array>;
        }
      | undefined => {
      z.string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(expectedWorkspaceDigest);
      const baseTree = objectId.parse(git(["rev-parse", `${baseSha}^{tree}`]));
      const entries = git(["ls-tree", "-rz", "-t", "--full-tree", baseSha])
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const match =
            /^(?<mode>040000|100644|100755|120000) (?<type>tree|blob) (?<oid>[a-f0-9]{40})\t(?<path>.+)$/u.exec(
              line,
            )?.groups;
          if (
            match === undefined ||
            !safeSourcePath(match.path) ||
            match.path.split("/").includes(".git")
          ) {
            throw new Error(
              "The retained original source has unsupported entries; no candidate metadata was changed.",
            );
          }
          return {
            mode: match.mode,
            type: match.type,
            oid: objectId.parse(match.oid),
            path: match.path,
          };
        });
      if (!linksCapturedAtPreparation && entries.some((entry) => entry.mode === "120000")) {
        // Legacy regular-file digests do not prove an original dirty symlink.
        // A first-preparation artifact records its separate exact captured tree.
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Legacy symlink baseline is unproven.
        return undefined;
      }
      const blobs = [
        ...new Set(entries.flatMap((entry) => (entry.type === "blob" ? [entry.oid] : []))),
      ];
      const bytes = execFileSync(
        gitExecutable,
        [...fixedGitArgs, "--git-dir", gitDir, "cat-file", "--batch"],
        {
          env: gitEnvironment,
          input: `${blobs.join("\n")}\n`,
          maxBuffer: Infinity,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let offset = 0;
      const digests = new Map<string, string>();
      for (const expected of blobs) {
        // Buffer.indexOf narrows its offset to a signed 32-bit integer.
        // Search from the start of a view to preserve offsets past 2 GiB.
        const record = bytes.subarray(offset);
        const headerLength = record.indexOf(10);
        if (headerLength === -1) {
          throw new Error("The retained original source object stream is incomplete.");
        }
        const header = /^(?<oid>[a-f0-9]{40}) blob (?<size>[0-9]+)$/u.exec(
          record.subarray(0, headerLength).toString("utf-8"),
        )?.groups;
        if (header === undefined || header.oid !== expected) {
          throw new Error("The retained original source object identity is invalid.");
        }
        const length = Number(header.size);
        offset += headerLength + 1;
        if (
          !Number.isSafeInteger(length) ||
          offset + length >= bytes.length ||
          bytes[offset + length] !== 10
        ) {
          throw new Error("The retained original source object bytes are incomplete.");
        }
        digests.set(
          expected,
          createHash("sha256")
            .update(bytes.subarray(offset, offset + length))
            .digest("hex"),
        );
        offset += length + 1;
      }
      if (offset !== bytes.length) {
        throw new Error("The retained original source object stream has unexpected bytes.");
      }
      const files = entries
        .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
        .toSorted((a, b) => {
          if (a.path < b.path) {
            return -1;
          }
          if (a.path > b.path) {
            return 1;
          }
          return 0;
        })
        .map((entry) => {
          const digest = digests.get(entry.oid);
          if (digest === undefined) {
            throw new Error("The original source object digest is missing.");
          }
          return {
            mode: entry.mode,
            objectId: digest.slice(0, 40),
            path: entry.path,
            sha256: digest,
          };
        });
      if (hash(JSON.stringify(files)) !== expectedWorkspaceDigest) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A nonmatching candidate is explicitly absent.
        return undefined;
      }
      const objects = [
        ...new Set([
          authoritySourceSha,
          ...git([
            "rev-list",
            "--objects",
            "--no-object-names",
            `${authoritySourceSha}^{tree}`,
          ]).split("\n"),
          baseSha,
          baseTree,
          ...entries.map((entry) => entry.oid),
        ]),
      ];
      const prefix = path.join(directory, "original-base");
      const packId = objectId.parse(git(["pack-objects", prefix], `${objects.join("\n")}\n`));
      return {
        originalSourceSha: authoritySourceSha,
        sourceSha: baseSha,
        sourceTree: baseTree,
        streamPack: () => processStdoutByteStream("/bin/cat", [`${prefix}-${packId}.pack`]),
      };
    };
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing retained paths explicitly yield no matching base.
    const captureOmittedRetainedPaths = (
      snapshot: string,
      baseSha: string,
      expectedWorkspaceDigest: string,
    ) => {
      // Snapshot creation copied originally tracked files before its new
      // Git index applied ignore rules. Recover only those omitted paths
      // from the actual retained source, with exact full-inventory proof.
      const originalPaths = git(["ls-tree", "-rz", "--name-only", originalSourceSha])
        .split("\0")
        .filter(Boolean);
      const committedPaths = new Set(git(["ls-tree", "-rz", "--name-only", baseSha]).split("\0"));
      const omitted = originalPaths.filter((name) => !committedPaths.has(name));
      if (omitted.length === 0) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- No matching original retained inventory.
        return undefined;
      }
      git(["read-tree", baseSha]);
      let complete = true;
      for (const name of omitted) {
        const absolute = selectedLocalSourcePath(snapshot, name);
        if (!existsSync(absolute)) {
          complete = false;
          break;
        }
        const info = lstatSync(absolute);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
          complete = false;
          break;
        }
        const oid = objectId.parse(
          git([gitHashObjectCommand, "-w", gitNoFiltersOption, "--stdin"], readFileSync(absolute)),
        );
        // oxlint-disable-next-line eslint/no-bitwise -- Preserve the actual retained executable mode.
        const mode = info.mode & 0o100 ? "100755" : "100644";
        git(["update-index", "--add", "--cacheinfo", mode, oid, name]);
      }
      if (!complete) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- No matching original retained inventory.
        return undefined;
      }
      const retainedTree = objectId.parse(git(["write-tree"]));
      const capturedBase = objectId.parse(
        git(
          ["commit-tree", retainedTree, "-p", originalSourceSha],
          "Captured original retained development source\n",
        ),
      );
      const completeBase = packOriginalBase(capturedBase, expectedWorkspaceDigest);
      return completeBase;
    };
    const artifactOriginalBase = (
      expectedWorkspaceDigest: string,
    ): ReturnType<typeof packOriginalBase> => {
      if (authority === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- No local artifact authority is available.
        return undefined;
      }
      {
        const artifact = path.join(
          authority.stateRoot,
          "source-baselines",
          originalSourceSha,
          expectedWorkspaceDigest,
        );
        const manifestPath = path.join(artifact, "manifest.json");
        const sourceGit = path.join(artifact, "source.git");
        if (existsSync(artifact)) {
          for (const name of [
            path.dirname(path.dirname(artifact)),
            path.dirname(artifact),
            artifact,
            sourceGit,
            manifestPath,
          ]) {
            const info = lstatSync(name);
            const validType = name === manifestPath ? info.isFile() : info.isDirectory();
            // oxlint-disable-next-line eslint/no-bitwise -- Read only owner-private artifact metadata.
            const privateOwner = info.uid === authority.ownerUid && (info.mode & 0o077) === 0;
            if (
              !validType ||
              info.isSymbolicLink() ||
              !privateOwner ||
              realpathSync(name) !== name
            ) {
              throw new LocalPlanningSourcePrerequisiteError(
                originalSourceSha,
                expectedWorkspaceDigest,
              );
            }
          }
          const manifest = localSourceBaselineManifestSchema.parse(
            JSON.parse(readFileSync(manifestPath, "utf-8")),
          );
          if (
            manifest.originalSourceSha !== originalSourceSha ||
            manifest.workspaceDigest !== expectedWorkspaceDigest
          ) {
            throw new LocalPlanningSourcePrerequisiteError(
              originalSourceSha,
              expectedWorkspaceDigest,
            );
          }
          git([
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            sourceGit,
            manifest.sourceSha,
          ]);
          if (git(["rev-parse", `${manifest.sourceSha}^{tree}`]) !== manifest.sourceTree) {
            throw new LocalPlanningSourcePrerequisiteError(
              originalSourceSha,
              expectedWorkspaceDigest,
            );
          }
          const retained = packOriginalBase(manifest.sourceSha, expectedWorkspaceDigest, true);
          if (retained === undefined) {
            throw new LocalPlanningSourcePrerequisiteError(
              originalSourceSha,
              expectedWorkspaceDigest,
            );
          }
          return retained;
        }
      }
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Artifact is explicitly absent.
      return undefined;
    };
    const originalBase = (expectedWorkspaceDigest: string) => {
      const historical = packOriginalBase(originalSourceSha, expectedWorkspaceDigest);
      if (historical !== undefined) {
        return historical;
      }
      const retainedArtifact = artifactOriginalBase(expectedWorkspaceDigest);
      if (retainedArtifact !== undefined) {
        return retainedArtifact;
      }
      // Only the closed launcher's owner-only retained run roots are candidates.
      // Read committed snapshot objects, never mutable snapshot or app bytes.
      if (retainedRunsRoot !== undefined) {
        for (const entry of readdirSync(retainedRunsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^run-[a-zA-Z0-9]+$/u.test(entry.name)) {
            continue;
          }
          const run = path.join(retainedRunsRoot, entry.name);
          const snapshot = path.join(run, "source");
          if (!existsSync(snapshot)) {
            continue;
          }
          const owned = [run, snapshot, path.join(snapshot, ".git")].every((name) => {
            const info = lstatSync(name);
            const ownedUid = info.uid === process.getuid?.();
            // oxlint-disable-next-line eslint/no-bitwise -- Enforce private retained source ownership.
            const privateMode = (info.mode & 0o077) === 0;
            const isDirectory = info.isDirectory() && !info.isSymbolicLink();
            return isDirectory && ownedUid && privateMode && realpathSync(name) === name;
          });
          if (!owned) {
            continue;
          }
          const baseSha = objectId.parse(runGit(["-C", snapshot, "rev-parse", "HEAD"]));
          // Fetch objects into this operation's private Git store only. No
          // retained snapshot refs/index or candidate bytes are changed.
          git([
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            snapshot,
            baseSha,
          ]);
          const retained = packOriginalBase(baseSha, expectedWorkspaceDigest);
          if (retained !== undefined) {
            return retained;
          }
          const completeBase = captureOmittedRetainedPaths(
            snapshot,
            baseSha,
            expectedWorkspaceDigest,
          );
          if (completeBase !== undefined) {
            return completeBase;
          }
        }
      }
      throw new LocalPlanningSourcePrerequisiteError(originalSourceSha, expectedWorkspaceDigest);
    };
    const currentCommit = () => {
      const sourceTree = objectId.parse(git(["rev-parse", `${sourceSha}^{tree}`]));
      const objects = [
        sourceSha,
        ...git(["rev-list", "--objects", "--no-object-names", sourceTree]).split("\n"),
      ];
      const prefix = path.join(directory, "current-commit");
      const packId = objectId.parse(git(["pack-objects", prefix], `${objects.join("\n")}\n`));
      return {
        sourceSha,
        sourceTree,
        streamPack: () => processStdoutByteStream("/bin/cat", [`${prefix}-${packId}.pack`]),
      };
    };
    const reference = `refs/app-builder/local-source/${snapshotSha}`;
    git(["update-ref", reference, snapshotSha]);
    return {
      generation,
      originalBase,
      capturedBase: () => {
        const base = packOriginalBase(snapshotSha, generation.workspaceDigest, true, sourceSha);
        if (base === undefined) {
          throw new LocalPlanningSourcePrerequisiteError(
            originalSourceSha,
            generation.workspaceDigest,
          );
        }
        return base;
      },
      currentCommit,
      sourceSha,
      snapshotSha,
      snapshotTree,
      needsBundle: snapshotSha !== originalSourceSha,
      streamBundle: () =>
        processStdoutByteStream(
          gitExecutable,
          [
            ...fixedGitArgs,
            "--git-dir",
            gitDir,
            "bundle",
            "create",
            "-",
            reference,
            `^${originalSourceSha}`,
          ],
          { env: gitEnvironment },
        ),
      dispose: () => {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
};
