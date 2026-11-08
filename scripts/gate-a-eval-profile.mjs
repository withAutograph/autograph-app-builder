/// <reference types="node" />
/// <reference lib="es2023.array" />

import { lstatSync, realpathSync } from "node:fs";
import nodePath from "node:path";
import { developmentExecutionEnvironment } from "../lib/development/execution-environment.mjs";

const { isAbsolute, relative, resolve, sep } = nodePath;
const sourceRootField = "source root";
const hostedArtifactProfile = "hosted-artifact";

/** @typedef {{ [key: string]: unknown }} UnknownRecord */
/** @typedef {{ path: string, device: string, inode: string, uid: string, mode: string, nlink: string }} RootIdentity */
/** @typedef {{ profile: "general", localPublication: "0" | "1", version: 1 } | { profile: "fresh", stateRoot: RootIdentity, allowedRoot: RootIdentity, fault: "after-stage" | null, version: 1 } | { profile: "sandbox" | "hosted-artifact", image: string | null, sourceRoot: RootIdentity | null, version: 1 }} GateAEvalProfile */

export const gateAEvalProfileKey = "__appBuilderAuthorizedGateAEvalProfileV1";

export const gateAEnvironmentFields = Object.freeze([
  ...Object.keys(developmentExecutionEnvironment),
  "APP_BUILDER_LOCAL_PUBLICATION",
  "APP_BUILDER_BRANCH_WORKTREE_PUBLICATION",
  "APP_BUILDER_BRANCH_WORKTREE_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_ENABLED",
  "APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT",
  "APP_BUILDER_FRESH_BOOTSTRAP_EVAL_FAULT",
  "APP_BUILDER_REAL_SANDBOX",
  "APP_BUILDER_EXECUTION_MODE",
  "APP_BUILDER_SANDBOX_PROVIDER",
  "APP_BUILDER_EXECUTION_BUNDLE",
  "APP_BUILDER_HOSTED_ARTIFACT_PROOF",
  "APP_BUILDER_SANDBOX_IMAGE",
  "APP_BUILDER_LOCAL_ADAPTER",
  "EVE_AGENT_HOST",
  "REPOSITORY_LOCAL_ROOTS",
  "REPOSITORY_WORKSPACE_ROOT",
  "WORKFLOW_LOCAL_BODY_TIMEOUT_MS",
  "WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS",
]);

const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/u;

/** @param {string} field @returns {never} */
const fail = (field) => {
  throw new Error(`The trusted Gate A eval ${field} was invalid.`);
};

/** @param {unknown} value @returns {value is UnknownRecord} */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
const isRecord = (value) => typeof value === "object" && value !== null;

/** @param {unknown} value @param {string[]} keys @returns {value is UnknownRecord} */
const exactKeys = (value, keys) =>
  isRecord(value) && Object.keys(value).toSorted().join(",") === [...keys].toSorted().join(",");

/** @param {string} root @param {string} candidate */
const within = (root, candidate) => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** @param {unknown} path @param {string} repositoryRoot @returns {RootIdentity} */
const observeRoot = (path, repositoryRoot) => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("root");
  }
  try {
    const resolved = resolve(path);
    const canonical = realpathSync(resolved);
    const state = lstatSync(resolved, { bigint: true });
    if (canonical !== resolved || !state.isDirectory() || state.isSymbolicLink()) {
      fail("root");
    }
    if (
      state.uid !== BigInt(process.getuid?.() ?? -1) ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (state.mode & 0o777n) !== 0o700n ||
      within(repositoryRoot, canonical)
    ) {
      fail("root");
    }
    if (within(canonical, repositoryRoot)) {
      fail("root");
    }
    return Object.freeze({
      device: String(state.dev),
      inode: String(state.ino),
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      mode: (state.mode & 0o777n).toString(8),
      nlink: String(state.nlink),
      path: canonical,
      uid: String(state.uid),
    });
  } catch {
    return fail("root");
  }
};

/** @param {unknown} path @param {string} repositoryRoot @returns {RootIdentity | null} */
const observeReadOnlyRoot = (path, repositoryRoot) => {
  if (path === null) {
    return null;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail(sourceRootField);
  }
  try {
    const resolved = resolve(path);
    const canonical = realpathSync(resolved);
    const state = lstatSync(resolved, { bigint: true });
    if (canonical !== resolved || !state.isDirectory() || state.isSymbolicLink()) {
      fail(sourceRootField);
    }
    if (
      state.uid !== BigInt(process.getuid?.() ?? -1) ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (state.mode & 0o022n) !== 0n ||
      within(repositoryRoot, canonical)
    ) {
      fail(sourceRootField);
    }
    if (within(canonical, repositoryRoot)) {
      fail(sourceRootField);
    }
    return Object.freeze({
      device: String(state.dev),
      inode: String(state.ino),
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      mode: (state.mode & 0o777n).toString(8),
      nlink: String(state.nlink),
      path: canonical,
      uid: String(state.uid),
    });
  } catch {
    return fail(sourceRootField);
  }
};

/** @param {unknown} value @param {string} repositoryRoot */
const validateReadOnlyRootIdentity = (value, repositoryRoot) => {
  if (value === null) {
    return null;
  }
  if (!exactKeys(value, ["path", "device", "inode", "uid", "mode", "nlink"])) {
    fail("source root identity");
  }
  const observed = observeReadOnlyRoot(value.path, repositoryRoot);
  for (const key of ["path", "device", "inode", "uid", "mode", "nlink"]) {
    if (value[key] !== observed[key]) {
      fail("source root identity");
    }
  }
  return observed;
};

/** @param {unknown} value @param {string} repositoryRoot */
const validateRootIdentity = (value, repositoryRoot) => {
  if (!exactKeys(value, ["path", "device", "inode", "uid", "mode", "nlink"])) {
    fail("root identity");
  }
  const observed = observeRoot(value.path, repositoryRoot);
  for (const key of ["path", "device", "inode", "uid", "mode", "nlink"]) {
    if (value[key] !== observed[key]) {
      fail("root identity");
    }
  }
  return observed;
};

/** @param {unknown} input @param {string} repositoryRoot @returns {GateAEvalProfile} */
export const createGateAEvalProfile = (input, repositoryRoot) => {
  if (!isAbsolute(repositoryRoot) || realpathSync(repositoryRoot) !== repositoryRoot) {
    fail("repository root");
  }
  if (exactKeys(input, ["profile", "localPublication"]) && input.profile === "general") {
    if (input.localPublication !== "1" && input.localPublication !== "0") {
      fail("local publication profile");
    }
    return Object.freeze({
      localPublication: input.localPublication,
      profile: "general",
      version: 1,
    });
  }
  if (
    exactKeys(input, ["profile", "stateRoot", "allowedRoot", "fault"]) &&
    input.profile === "fresh"
  ) {
    if (input.fault !== null && input.fault !== "after-stage") {
      fail("fresh fault");
    }
    const stateRoot = observeRoot(input.stateRoot, repositoryRoot);
    const allowedRoot = observeRoot(input.allowedRoot, repositoryRoot);
    if (within(stateRoot.path, allowedRoot.path) || within(allowedRoot.path, stateRoot.path)) {
      fail("fresh roots");
    }
    return Object.freeze({
      allowedRoot,
      fault: input.fault,
      profile: "fresh",
      stateRoot,
      version: 1,
    });
  }
  if (
    exactKeys(input, ["profile", "image", "sourceRoot"]) &&
    (input.profile === "sandbox" || input.profile === hostedArtifactProfile)
  ) {
    if (
      input.image !== null &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
      (typeof input.image !== "string" || !imagePattern.test(input.image))
    ) {
      fail("sandbox image");
    }
    const sourceRoot = observeReadOnlyRoot(input.sourceRoot, repositoryRoot);
    return Object.freeze({
      image: input.image,
      profile: input.profile === "sandbox" ? "sandbox" : hostedArtifactProfile,
      sourceRoot,
      version: 1,
    });
  }
  return fail("profile");
};

/** @param {unknown} value @param {string} repositoryRoot @returns {GateAEvalProfile} */
export const validateGateAEvalProfile = (value, repositoryRoot) => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof value !== "object" || value === null || value.version !== 1) {
    fail("profile envelope");
  }
  if (value.profile === "general" && exactKeys(value, ["version", "profile", "localPublication"])) {
    return createGateAEvalProfile(
      { localPublication: value.localPublication, profile: "general" },
      repositoryRoot,
    );
  }
  if (
    value.profile === "fresh" &&
    exactKeys(value, ["version", "profile", "stateRoot", "allowedRoot", "fault"])
  ) {
    const stateRoot = validateRootIdentity(value.stateRoot, repositoryRoot);
    const allowedRoot = validateRootIdentity(value.allowedRoot, repositoryRoot);
    if (within(stateRoot.path, allowedRoot.path) || within(allowedRoot.path, stateRoot.path)) {
      fail("fresh roots");
    }
    if (value.fault !== null && value.fault !== "after-stage") {
      fail("fresh fault");
    }
    return Object.freeze({
      allowedRoot,
      fault: value.fault,
      profile: "fresh",
      stateRoot,
      version: 1,
    });
  }
  if (
    (value.profile === "sandbox" || value.profile === hostedArtifactProfile) &&
    exactKeys(value, ["version", "profile", "image", "sourceRoot"])
  ) {
    if (
      value.image !== null &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
      (typeof value.image !== "string" || !imagePattern.test(value.image))
    ) {
      fail("sandbox image");
    }
    return Object.freeze({
      image: value.image,
      profile: value.profile === "sandbox" ? "sandbox" : hostedArtifactProfile,
      sourceRoot: validateReadOnlyRootIdentity(value.sourceRoot, repositoryRoot),
      version: 1,
    });
  }
  return fail("profile envelope");
};

/** @param {Record<string, string | undefined>} environment @param {unknown} value @param {string} repositoryRoot */
export const installGateAEvalProfile = (environment, value, repositoryRoot) => {
  const profile = validateGateAEvalProfile(value, repositoryRoot);
  for (const field of gateAEnvironmentFields) {
    Reflect.deleteProperty(environment, field);
  }
  if (profile.profile === "general") {
    environment.APP_BUILDER_LOCAL_PUBLICATION = profile.localPublication;
    environment.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION = "1";
  } else if (profile.profile === "fresh") {
    environment.APP_BUILDER_LOCAL_PUBLICATION = "1";
    environment.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION = "1";
    environment.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED = "1";
    environment.APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT = profile.stateRoot.path;
    environment.APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT = profile.allowedRoot.path;
    if (profile.fault !== null) {
      environment.APP_BUILDER_FRESH_BOOTSTRAP_EVAL_FAULT = profile.fault;
    }
  } else {
    environment.APP_BUILDER_REAL_SANDBOX = "1";
    if (profile.profile === "sandbox") {
      Object.assign(environment, developmentExecutionEnvironment);
    }
    environment.WORKFLOW_LOCAL_BODY_TIMEOUT_MS = "360000";
    environment.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS = "360000";
    if (profile.profile === hostedArtifactProfile) {
      environment.APP_BUILDER_HOSTED_ARTIFACT_PROOF = "1";
    }
    if (profile.image !== null) {
      environment.APP_BUILDER_SANDBOX_IMAGE = profile.image;
    }
    if (profile.sourceRoot !== null) {
      environment.REPOSITORY_LOCAL_ROOTS = profile.sourceRoot.path;
    }
  }
  return profile;
};
