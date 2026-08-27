import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const gateAEvalProfileKey = "__appBuilderAuthorizedGateAEvalProfileV1";

export const gateAEnvironmentFields = Object.freeze([
  "APP_BUILDER_LOCAL_PUBLICATION",
  "APP_BUILDER_BRANCH_WORKTREE_PUBLICATION",
  "APP_BUILDER_BRANCH_WORKTREE_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_ENABLED",
  "APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_EVAL_FAULT",
  "APP_BUILDER_REAL_SANDBOX",
  "APP_BUILDER_HOSTED_ARTIFACT_PROOF",
  "APP_BUILDER_SANDBOX_IMAGE",
  "APP_BUILDER_LOCAL_ADAPTER",
  "EVE_AGENT_HOST",
  "REPOSITORY_LOCAL_ROOTS",
  "REPOSITORY_WORKSPACE_ROOT",
]);

const imagePattern =
  /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/u;

function fail(field) {
  throw new Error(`The trusted Gate A eval ${field} was invalid.`);
}

function exactKeys(value, keys) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function observeRoot(path, repositoryRoot) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("root");
  try {
    const resolved = resolve(path);
    const canonical = realpathSync(resolved);
    const state = lstatSync(resolved, { bigint: true });
    if (
      canonical !== resolved ||
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      state.uid !== BigInt(process.getuid?.() ?? -1) ||
      (state.mode & BigInt(0o777)) !== BigInt(0o700) ||
      within(repositoryRoot, canonical) ||
      within(canonical, repositoryRoot)
    )
      fail("root");
    return Object.freeze({
      path: canonical,
      device: String(state.dev),
      inode: String(state.ino),
      uid: String(state.uid),
      mode: (state.mode & BigInt(0o777)).toString(8),
      nlink: String(state.nlink),
    });
  } catch {
    fail("root");
  }
}

function observeReadOnlyRoot(path, repositoryRoot) {
  if (path === null) return null;
  if (typeof path !== "string" || !isAbsolute(path)) fail("source root");
  try {
    const resolved = resolve(path);
    const canonical = realpathSync(resolved);
    const state = lstatSync(resolved, { bigint: true });
    if (
      canonical !== resolved ||
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      state.uid !== BigInt(process.getuid?.() ?? -1) ||
      (state.mode & BigInt(0o022)) !== BigInt(0) ||
      within(repositoryRoot, canonical) ||
      within(canonical, repositoryRoot)
    )
      fail("source root");
    return Object.freeze({
      path: canonical,
      device: String(state.dev),
      inode: String(state.ino),
      uid: String(state.uid),
      mode: (state.mode & BigInt(0o777)).toString(8),
      nlink: String(state.nlink),
    });
  } catch {
    fail("source root");
  }
}

function validateReadOnlyRootIdentity(value, repositoryRoot) {
  if (value === null) return null;
  if (!exactKeys(value, ["path", "device", "inode", "uid", "mode", "nlink"]))
    fail("source root identity");
  const observed = observeReadOnlyRoot(value.path, repositoryRoot);
  for (const key of ["path", "device", "inode", "uid", "mode", "nlink"])
    if (value[key] !== observed[key]) fail("source root identity");
  return observed;
}

function validateRootIdentity(value, repositoryRoot) {
  if (!exactKeys(value, ["path", "device", "inode", "uid", "mode", "nlink"]))
    fail("root identity");
  const observed = observeRoot(value.path, repositoryRoot);
  for (const key of ["path", "device", "inode", "uid", "mode", "nlink"])
    if (value[key] !== observed[key]) fail("root identity");
  return observed;
}

export function createGateAEvalProfile(input, repositoryRoot) {
  if (
    !isAbsolute(repositoryRoot) ||
    realpathSync(repositoryRoot) !== repositoryRoot
  )
    fail("repository root");
  if (
    exactKeys(input, ["profile", "localPublication"]) &&
    input.profile === "general"
  ) {
    if (input.localPublication !== "1" && input.localPublication !== "0")
      fail("local publication profile");
    return Object.freeze({
      version: 1,
      profile: "general",
      localPublication: input.localPublication,
    });
  }
  if (
    exactKeys(input, ["profile", "stateRoot", "allowedRoot", "fault"]) &&
    input.profile === "fresh"
  ) {
    if (input.fault !== null && input.fault !== "after-stage")
      fail("fresh fault");
    const stateRoot = observeRoot(input.stateRoot, repositoryRoot);
    const allowedRoot = observeRoot(input.allowedRoot, repositoryRoot);
    if (
      within(stateRoot.path, allowedRoot.path) ||
      within(allowedRoot.path, stateRoot.path)
    )
      fail("fresh roots");
    return Object.freeze({
      version: 1,
      profile: "fresh",
      stateRoot,
      allowedRoot,
      fault: input.fault,
    });
  }
  if (
    exactKeys(input, ["profile", "image", "sourceRoot"]) &&
    (input.profile === "sandbox" || input.profile === "hosted-artifact")
  ) {
    if (
      input.image !== null &&
      (typeof input.image !== "string" || !imagePattern.test(input.image))
    )
      fail("sandbox image");
    const sourceRoot = observeReadOnlyRoot(input.sourceRoot, repositoryRoot);
    return Object.freeze({
      version: 1,
      profile: input.profile === "sandbox" ? "sandbox" : "hosted-artifact",
      image: input.image,
      sourceRoot,
    });
  }
  fail("profile");
}

export function validateGateAEvalProfile(value, repositoryRoot) {
  if (typeof value !== "object" || value === null || value.version !== 1)
    fail("profile envelope");
  if (
    value.profile === "general" &&
    exactKeys(value, ["version", "profile", "localPublication"])
  )
    return createGateAEvalProfile(
      { profile: "general", localPublication: value.localPublication },
      repositoryRoot,
    );
  if (
    value.profile === "fresh" &&
    exactKeys(value, [
      "version",
      "profile",
      "stateRoot",
      "allowedRoot",
      "fault",
    ])
  ) {
    const stateRoot = validateRootIdentity(value.stateRoot, repositoryRoot);
    const allowedRoot = validateRootIdentity(value.allowedRoot, repositoryRoot);
    if (
      within(stateRoot.path, allowedRoot.path) ||
      within(allowedRoot.path, stateRoot.path)
    )
      fail("fresh roots");
    if (value.fault !== null && value.fault !== "after-stage")
      fail("fresh fault");
    return Object.freeze({
      version: 1,
      profile: "fresh",
      stateRoot,
      allowedRoot,
      fault: value.fault,
    });
  }
  if (
    (value.profile === "sandbox" || value.profile === "hosted-artifact") &&
    exactKeys(value, ["version", "profile", "image", "sourceRoot"])
  ) {
    if (
      value.image !== null &&
      (typeof value.image !== "string" || !imagePattern.test(value.image))
    )
      fail("sandbox image");
    return Object.freeze({
      version: 1,
      profile: value.profile === "sandbox" ? "sandbox" : "hosted-artifact",
      image: value.image,
      sourceRoot: validateReadOnlyRootIdentity(
        value.sourceRoot,
        repositoryRoot,
      ),
    });
  }
  fail("profile envelope");
}

export function installGateAEvalProfile(environment, value, repositoryRoot) {
  const profile = validateGateAEvalProfile(value, repositoryRoot);
  for (const field of gateAEnvironmentFields) delete environment[field];
  if (profile.profile === "general") {
    environment.APP_BUILDER_LOCAL_PUBLICATION = profile.localPublication;
    environment.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION = "1";
  } else if (profile.profile === "fresh") {
    environment.APP_BUILDER_LOCAL_PUBLICATION = "1";
    environment.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION = "1";
    environment.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED = "1";
    environment.APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT = profile.stateRoot.path;
    environment.APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT =
      profile.allowedRoot.path;
    if (profile.fault !== null)
      environment.APP_BUILDER_FRESH_BOOTSTRAP_EVAL_FAULT = profile.fault;
  } else {
    environment.APP_BUILDER_REAL_SANDBOX = "1";
    if (profile.profile === "hosted-artifact")
      environment.APP_BUILDER_HOSTED_ARTIFACT_PROOF = "1";
    if (profile.image !== null)
      environment.APP_BUILDER_SANDBOX_IMAGE = profile.image;
    if (profile.sourceRoot !== null)
      environment.REPOSITORY_LOCAL_ROOTS = profile.sourceRoot.path;
  }
  return profile;
}
