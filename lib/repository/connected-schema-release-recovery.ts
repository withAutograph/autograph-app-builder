import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import { draftSchemaReleaseId } from "./sandbox-draft-schema-release";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const restoredPublishedPredecessorSchema = z.strictObject({
  releaseId: draftSchemaReleaseId,
  publishedManifestSha256: digest,
  previousManifestSha256: digest,
});
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const memberHashes = {
  schema: "app-artifact.json",
  source_map: "cue-to-sql-source-map.json",
  operation_docs: "data-operations.md",
  bindings: "data-operations.ts",
  server_bindings: "data-server.ts",
  operations: "operation-manifest.json",
  coverage: "runtime-coverage.json",
  bundle: "sql-bundle.sql",
  sql_manifest: "sql-manifest.json",
  transition_contract: "transition-contract.json",
  plan: "transition-plan.json",
};

const preserveConnectedSchemaReleaseProgram = String.raw`
import hashlib, json, os, stat, subprocess, sys
workspace, staging, raw = sys.argv[1:]
proof = json.loads(raw)
app, release = proof["appId"], proof["releaseId"]
relative = "apps/" + app + "/schema/release/" + release
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def open_directory(parent, path):
    for part in path.split("/"):
        parent = os.open(part, directory_flags, dir_fd=parent)
    return parent

def git(*args):
    return subprocess.check_output(
        ["/usr/bin/git", "--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false", *args],
        stderr=subprocess.DEVNULL,
    )

def same_file(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)

def read_member(parent, name, parse=False):
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode) or before.st_mode & 0o111 or before.st_nlink != 1:
        raise ValueError()
    with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent), "rb") as file:
        opened = os.fstat(file.fileno())
        if not same_file(before, opened):
            raise ValueError()
        checksum = hashlib.sha256()
        if parse:
            content = file.read()
            checksum.update(content)
            return checksum.hexdigest(), json.loads(content)
        for block in iter(lambda: file.read(65536), b""):
            checksum.update(block)
        return checksum.hexdigest(), None

def verified_release(directory, version, expected_manifest, expected_artifact):
    if sorted(os.listdir(directory)) != sorted(proof["members"]):
        return None
    manifest_hash, manifest = read_member(directory, "release-manifest.json", True)
    if manifest_hash != expected_manifest:
        return None
    if manifest["app"] != app or manifest["schema_version"] != version:
        raise ValueError()
    hashes = manifest["hashes"]
    if sorted(hashes) != sorted([*proof["memberHashes"], "source", "client"]):
        raise ValueError()
    for key, member in proof["memberHashes"].items():
        checksum, _ = read_member(directory, member)
        if hashes[key] != "sha256:" + checksum:
            raise ValueError()
    artifact_hash, artifact = read_member(directory, "app-artifact.json", True)
    if (artifact_hash != expected_artifact
        or artifact["schema"]["app_id"] != app or artifact["schema"]["version"] != version):
        raise ValueError()
    return manifest

def read_candidate(candidate, checkout):
    manifest = verified_release(candidate, release, proof["expectedManifestSha256"], proof["expectedArtifactSha256"])
    if manifest is None:
        return None
    _, plan = read_member(candidate, "transition-plan.json", True)
    if plan["app_id"] != app or plan["version"] != release:
        raise ValueError()
    online = plan.get("online_optional_text_addition")
    if (isinstance(online, dict)
        and online.get("kind") == "optional-text-addition-v1"
        and online.get("predecessor_artifact_sha256") == proof["expectedPredecessorArtifactSha256"]):
        return plan
    approved_cue = proof.get("expectedCueSha256")
    if "online_optional_text_addition" not in plan and proof.get("restoredPublishedPredecessor") and approved_cue:
        relative_cue = "apps/" + app + "/schema/" + app + ".cue"
        if manifest.get("sources", {}).get(relative_cue) == "sha256:" + approved_cue:
            schema_directory = open_directory(checkout, "apps/" + app + "/schema")
            try:
                observed_cue, _ = read_member(schema_directory, app + ".cue")
            finally:
                os.close(schema_directory)
            if observed_cue == approved_cue:
                return plan
    return None

def can_recompile(parent, plan):
    restored = proof.get("restoredPublishedPredecessor")
    online = plan.get("online_optional_text_addition")
    seen = False
    for other in os.listdir(parent):
        if other == release or not stat.S_ISDIR(os.stat(other, dir_fd=parent, follow_symlinks=False).st_mode):
            continue
        previous = os.open(other, directory_flags, dir_fd=parent)
        try:
            try:
                checksum, _ = read_member(previous, "app-artifact.json")
            except FileNotFoundError:
                continue
            if checksum != proof["expectedPredecessorArtifactSha256"]:
                continue
            schema = online.get("predecessor_schema") if online is not None else None
            wrong_plan_version = online is not None and (not isinstance(schema, dict) or schema.get("version") != other)
            if (seen or not restored or other != restored["releaseId"]
                or wrong_plan_version
                or not verified_release(previous, other, restored["publishedManifestSha256"], checksum)):
                return False
            if online is not None and restored["publishedManifestSha256"] == restored["previousManifestSha256"]:
                return False
            seen = True
        finally:
            os.close(previous)
    return online is not None or seen

def preserve():
    directory = os.open(workspace, directory_flags)
    checkout = open_directory(directory, "repository")
    os.fchdir(checkout)
    if git("rev-parse", "--show-prefix") != b"\n" or git("rev-parse", "HEAD").strip().decode() != proof["expectedSourceSha"]:
        raise ValueError()
    if git("ls-tree", "-z", "HEAD", "--", relative) or git("ls-files", "-z", "--", relative):
        return False
    parent = open_directory(checkout, "apps/" + app + "/schema/release")
    private = open_directory(directory, ".app-builder")
    try:
        candidate = os.open(release, directory_flags, dir_fd=parent)
    except FileNotFoundError:
        try:
            saved = os.open(staging, directory_flags, dir_fd=private)
            plan = read_candidate(os.open(release, directory_flags, dir_fd=saved), checkout)
            return plan is not None and can_recompile(parent, plan)
        except FileNotFoundError:
            return False
    plan = read_candidate(candidate, checkout)
    if plan is None or not can_recompile(parent, plan):
        return False
    try:
        os.mkdir(staging, 0o700, dir_fd=private)
    except FileExistsError:
        pass
    saved = os.open(staging, directory_flags, dir_fd=private)
    if os.listdir(saved) or not same_file(os.fstat(candidate), os.stat(release, dir_fd=parent, follow_symlinks=False)):
        raise ValueError()
    os.rename(release, release, src_dir_fd=parent, dst_dir_fd=saved)
    return True

try:
    print(json.dumps({"preserved": preserve()}))
except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError):
    sys.exit(1)
`;

/** Keep the verified unissued cut available privately so the compiler can regenerate it. */
export const preserveUnissuedConnectedSchemaRelease = async (input: {
  sandbox: Pick<SandboxSession, "run">;
  appId: string;
  releaseId: string;
  expectedArtifactSha256: string;
  expectedManifestSha256: string;
  expectedPredecessorArtifactSha256: string;
  expectedSourceSha: string;
  expectedCueSha256?: string;
  restoredPublishedPredecessor?: z.input<typeof restoredPublishedPredecessorSchema>;
  signal?: AbortSignal;
}): Promise<boolean> => {
  const identity = {
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .parse(input.appId),
    releaseId: draftSchemaReleaseId.parse(input.releaseId),
    expectedArtifactSha256: digest.parse(input.expectedArtifactSha256),
    expectedManifestSha256: digest.parse(input.expectedManifestSha256),
    expectedPredecessorArtifactSha256: digest.parse(input.expectedPredecessorArtifactSha256),
    expectedSourceSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .parse(input.expectedSourceSha),
    members: GENERATED_RELEASE_MEMBERS,
    memberHashes,
  };
  const proof = {
    ...identity,
    expectedCueSha256: digest.optional().parse(input.expectedCueSha256),
    restoredPublishedPredecessor: restoredPublishedPredecessorSchema
      .optional()
      .parse(input.restoredPublishedPredecessor),
  };
  const staging = `connected-schema-recompile-${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")}`;
  const args = ["/workspace", staging, JSON.stringify(proof)].map(quote).join(" ");
  input.signal?.throwIfAborted();
  const result = await input.sandbox.run({
    abortSignal: input.signal,
    command: `python3 -c ${quote(preserveConnectedSchemaReleaseProgram)} ${args}`,
    workingDirectory: "/workspace/repository",
  });
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    throw new Error(
      "Builder could not verify the saved unissued schema release in its private workspace.",
    );
  }
  return z.strictObject({ preserved: z.boolean() }).parse(JSON.parse(result.stdout)).preserved;
};
