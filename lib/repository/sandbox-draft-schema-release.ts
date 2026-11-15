import { randomUUID } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import type { PreparedDraftReconciliation } from "./sandbox-draft-reconciliation";

export const draftSchemaReleaseId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

const discardProgram = String.raw`
import hashlib, json, os, re, stat, subprocess, sys
workspace, root, app, release, base, base_tree, head, head_tree, replayed, saved_tree, staging, raw_members, raw_recovery = sys.argv[1:]
relative = "apps/" + app + "/schema/release/" + release
members = sorted(json.loads(raw_members))
recovery = json.loads(raw_recovery)
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def git(*args):
    return subprocess.check_output(["git", "--no-replace-objects", "--literal-pathspecs", *args], stderr=subprocess.DEVNULL)

def directory(parent, path):
    for part in path.split("/"):
        if not part or part in (".", ".."):
            raise ValueError("The candidate path is outside its workspace.")
        parent = os.open(part, flags, dir_fd=parent)
    return parent

def read_member(directory_fd, name):
    with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd), "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError("The captured schema input is not a regular file.")
        return file.read()

def digest(bytes):
    return hashlib.sha256(bytes).hexdigest()

# A known one-label correction is the only permitted private CUE difference.
# The publication check still proves the field's full semantics after recompilation.
def approved_cue(candidate_fd):
    cue_name = app + ".cue"
    schema_path = "apps/" + app + "/schema"
    cue_path = schema_path + "/" + cue_name
    base_cue = git("cat-file", "blob", base + ":" + cue_path)
    approved = git("cat-file", "blob", head + ":" + cue_path)
    private_cue = read_member(directory(candidate_fd, schema_path), cue_name)
    if (digest(base_cue) != recovery["installed"]["cueSha256"]
        or digest(approved) != recovery["approvedCandidateCueSha256"]
        or digest(private_cue) != recovery["privateCueSha256"]):
        return False
    if private_cue == approved:
        return digest(base_cue) == recovery["approvedPriorCueSha256"]
    label = re.compile(rb'\blabel\s*:\s*("(?:[^"\\\r\n]|\\.)*")')
    old = list(label.finditer(approved))
    new = list(label.finditer(private_cue))
    changes = [(before, after) for before, after in zip(old, new) if before[1] != after[1]]
    if len(old) != len(new) or len(changes) != 1:
        return False
    before, after = changes[0]
    old_label, new_label = before[1], after[1]
    if (json.loads(old_label).lower() != json.loads(new_label).lower()
        or approved.count(old_label) != 1 or base_cue.count(new_label) != 1):
        return False
    return (approved.replace(old_label, new_label, 1) == private_cue
        and digest(base_cue.replace(new_label, old_label, 1)) == recovery["approvedPriorCueSha256"])

def online_predecessor(entries):
    plan = json.loads(git("cat-file", "blob", entries["transition-plan.json"]))
    operations = json.loads(git("cat-file", "blob", entries["operation-manifest.json"]))
    online = plan.get("online_optional_text_addition") or {}
    compatibility = operations.get("predecessorCompatibility") or {}
    schema = online.get("predecessor_schema") or {}
    artifact = online.get("predecessor_artifact_sha256")
    field = {"modelId": online.get("model_id"), "fieldId": online.get("field_id")}
    if (online.get("kind") != "optional-text-addition-v1"
        or compatibility.get("kind") != "optional-text-addition-v1"
        or not all(isinstance(value, str) and value for value in field.values())):
        return None
    if any(entry.get("artifactSha256") == artifact and entry.get("field") == field
           and entry.get("schema") == schema for entry in compatibility.get("predecessors", [])):
        return (schema.get("version"), artifact, field)
    return None

def stale_compatibility(entries, approved_entries):
    prior = recovery["installed"]
    files = ("app-artifact.json", "release-manifest.json")
    if prior["releaseId"] == release:
        return False
    prior_path = "apps/" + app + "/schema/release/" + prior["releaseId"]
    for member, expected in zip(files, (prior["artifactSha256"], prior["manifestSha256"])):
        for tree in (base, recovery["inspectedTree"]):
            if digest(git("cat-file", "blob", tree + ":" + prior_path + "/" + member)) != expected:
                return False
    candidate = online_predecessor(entries)
    if candidate is None or candidate[:2] != (prior["releaseId"], prior["artifactSha256"]):
        return True
    approved = online_predecessor(approved_entries)
    return approved is not None and approved[2] != candidate[2]

def checked_discard():
    workspace_fd = os.open(workspace, flags)
    candidate_root = os.path.relpath(root, workspace)
    if not candidate_root.startswith(".app-builder/draft-reconcile/"):
        raise ValueError("The selected source is not an isolated draft candidate.")
    candidate_fd = directory(workspace_fd, candidate_root)
    os.fchdir(candidate_fd)
    checkout_head = git("rev-parse", "HEAD").strip().decode()
    if replayed:
        expected_worktree = git("rev-list", "--parents", "-n", "1", "HEAD").split() == [replayed.encode(), head.encode()]
    else:
        expected_worktree = checkout_head == head
    if (git("rev-parse", "--show-prefix") != b"\n"
        or not expected_worktree
        or git("rev-parse", base + "^{tree}").strip().decode() != base_tree
        or git("rev-parse", head + "^{tree}").strip().decode() != head_tree):
        raise ValueError("The private checkout no longer matches the verified draft and base. Prepare the same owned draft again. After any local replay, inspect the CUE to confirm the intended correction before recompilation.")
    common = git("merge-base", "--all", base, head).decode().splitlines()
    if not common or any(git("ls-tree", "-z", rev, "--", relative) for rev in [base, *common]):
        raise ValueError("The release is part of established base history and was preserved.")

    def generated_entries(tree):
        entries = {}
        for entry in git("ls-tree", "-r", "-z", tree, "--", relative).split(b"\0"):
            if not entry:
                continue
            metadata, filename = entry.decode().split("\t", 1)
            mode, kind, oid = metadata.split(" ")
            if mode != "100644" or kind != "blob" or not filename.startswith(relative + "/"):
                raise ValueError("This release is not plain generated draft output.")
            entries[filename[len(relative) + 1:]] = oid
        if sorted(entries) != members:
            raise ValueError("The verified source does not contain this generated release.")
        manifest = json.loads(git("cat-file", "blob", entries["release-manifest.json"]))
        if (manifest.get("app") != app or manifest.get("schema_version") != release
            or manifest.get("compiler", {}).get("name") != "schema-compiler"):
            raise ValueError("The compiler manifest does not name this app and release.")
        return entries

    proven = [generated_entries(head)]
    if replayed:
        # The provider draft still proves this cut is eligible. The exact local
        # replay may also prove a complete set of candidate preimage bytes.
        try:
            proven.append(generated_entries(replayed))
        except ValueError:
            pass
    if saved_tree and saved_tree != head_tree:
        # A compiler success is retained against an immutable candidate tree by Builder.
        # It can prove an alternate preimage, but cannot expand the set of draft-owned cuts.
        proven.append(generated_entries(saved_tree))

    parent = directory(candidate_fd, "apps/" + app + "/schema/release")
    release_fd = os.open(release, flags, dir_fd=parent)
    if sorted(os.listdir(release_fd)) != members:
        raise ValueError("The private release directory differs from the exact draft output.")
    observed = {}
    for member in members:
        info = os.stat(member, dir_fd=release_fd, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o111:
            raise ValueError("This release contains a link or unexpected file type or mode.")
        with os.fdopen(os.open(member, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=release_fd), "rb") as file:
            opened = os.fstat(file.fileno())
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError("The private release changed during verification.")
            digest = hashlib.sha1()
            digest.update(("blob " + str(opened.st_size) + "\0").encode())
            for block in iter(lambda: file.read(65536), b""):
                digest.update(block)
            observed[member] = digest.hexdigest()
    if observed not in proven:
        raise ValueError("The private release does not match the draft or saved compiler output.")
    if recovery:
        if observed != generated_entries(recovery["inspectedTree"]):
            return False
        if not approved_cue(candidate_fd) or not stale_compatibility(observed, proven[0]):
            return False
    current = os.stat(release, dir_fd=parent, follow_symlinks=False)
    opened = os.fstat(release_fd)
    if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
        raise ValueError("The private release changed during verification.")
    private = directory(workspace_fd, ".app-builder")
    os.mkdir(staging, 0o700, dir_fd=private)
    retained = os.open(staging, flags, dir_fd=private)
    os.rename(release, release, src_dir_fd=parent, dst_dir_fd=retained)
    return True

try:
    discarded = checked_discard()
except subprocess.CalledProcessError:
    print(json.dumps({"error": "The existing draft and base Git objects could not be verified."}))
except OSError:
    print(json.dumps({"error": "The private release path is missing, linked, or no longer writable."}))
except (json.JSONDecodeError, AttributeError, TypeError):
    print(json.dumps({"error": "The checked compiler manifest has an invalid format."}))
except ValueError as error:
    print(json.dumps({"error": str(error)}))
else:
    print(json.dumps({"discarded": discarded}))
`;

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const recoveryEvidence = z.strictObject({
  approvedCandidateCueSha256: hash,
  approvedPriorCueSha256: hash,
  privateCueSha256: hash,
  inspectedTree: z.string().regex(/^[a-f0-9]{40}$/u),
  installed: z.strictObject({
    releaseId: draftSchemaReleaseId,
    artifactSha256: hash,
    manifestSha256: hash,
    cueSha256: hash,
  }),
});

interface DraftSchemaReleaseMove {
  prepared: PreparedDraftReconciliation;
  releaseId: string;
  validatedTree?: string;
  sandbox: Pick<SandboxSession, "run">;
  assertCurrent: () => void;
  markUncertain: () => void;
  abortSignal?: AbortSignal;
}

export class DraftSchemaReleaseMoveUncertainError extends Error {
  readonly name = "DraftSchemaReleaseMoveUncertainError";
}

const moveDraftSchemaRelease = async (
  input: DraftSchemaReleaseMove,
  recovery?: z.infer<typeof recoveryEvidence>,
): Promise<{ path: string } | undefined> => {
  const { appId, root, workspaceRoot, baseSha, baseTree, headSha, headTree, replayedHeadSha } =
    input.prepared;
  const releaseId = draftSchemaReleaseId.parse(input.releaseId);
  const verifiedTrees = [baseSha, baseTree, headSha, headTree];
  if (replayedHeadSha !== undefined) {
    verifiedTrees.push(replayedHeadSha);
  }
  if (input.validatedTree !== undefined) {
    verifiedTrees.push(input.validatedTree);
  }
  if (
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(appId) ||
    baseSha === headSha ||
    !verifiedTrees.every((id) => /^[a-f0-9]{40}$/u.test(id))
  ) {
    throw new Error(
      "The app or its exact draft and base are unavailable for release recompilation.",
    );
  }
  const argumentsForSandbox = [
    workspaceRoot,
    root,
    appId,
    releaseId,
    baseSha,
    baseTree,
    headSha,
    headTree,
    replayedHeadSha ?? "",
    input.validatedTree ?? "",
    `draft-schema-recompile-${randomUUID()}`,
    JSON.stringify(GENERATED_RELEASE_MEMBERS),
    JSON.stringify(recovery ?? null),
  ];
  input.assertCurrent();
  let outcome;
  try {
    const result = await input.sandbox.run({
      abortSignal: input.abortSignal,
      command: `python3 -c ${quote(discardProgram)} ${argumentsForSandbox.map(quote).join(" ")}`,
      workingDirectory: workspaceRoot,
    });
    if (result.exitCode !== 0) {
      throw new Error("The private command did not confirm the release move.");
    }
    outcome = z
      .union([z.strictObject({ discarded: z.boolean() }), z.strictObject({ error: z.string() })])
      .parse(JSON.parse(result.stdout));
  } catch (error) {
    input.markUncertain();
    throw new DraftSchemaReleaseMoveUncertainError(
      "Builder could not confirm whether it moved the draft release. Inspect and revalidate the same private candidate.",
      { cause: error },
    );
  }
  if ("error" in outcome) {
    throw new Error(`Builder preserved the draft release. ${outcome.error}`);
  }
  return outcome.discarded ? { path: `apps/${appId}/schema/release/${releaseId}` } : undefined;
};

/** Preserve exact generated draft output outside the candidate so compilation can recreate it. */
export const discardUnissuedDraftSchemaRelease = async (input: DraftSchemaReleaseMove) => {
  const result = await moveDraftSchemaRelease(input);
  if (result === undefined) {
    throw new Error("The private draft release was not moved.");
  }
  return result;
};

/** Move a known unissued draft release only when it lacks the installed predecessor proof. */
export const preserveStaleDraftSchemaRelease = async (
  input: DraftSchemaReleaseMove & { recovery: z.infer<typeof recoveryEvidence> },
) => await moveDraftSchemaRelease(input, recoveryEvidence.parse(input.recovery));
