import { createHash } from "node:crypto";

import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import { assertExactReviewedChangeSet, stableDigest } from "./local-publication";
import type { SourceReceipt } from "./source-receipt";
import { safeSourcePath } from "./source-path";

export const FRESH_BOOTSTRAP_VERSION = 3 as const;

export interface PathIdentity {
  path: string;
  device: string;
  inode: string;
  uid: string;
  mode: string;
  nlink: string;
}

export type ExecutableIdentity = PathIdentity & { sha256: string };

export interface FreshBootstrapCapability {
  kind: "fresh-bootstrap-local-v1";
  stateRoot: PathIdentity;
  allowedRoot: PathIdentity;
  systemGit: string;
  systemPython: string;
  systemGitIdentity: ExecutableIdentity;
  systemPythonIdentity: ExecutableIdentity;
  systemNode: string;
  systemNodeIdentity: ExecutableIdentity;
  lockStrategy: "flock" | "lockf";
  lockHelper: string;
  lockHelperIdentity: ExecutableIdentity;
  authority: "configured-production" | "structural-test-injection";
}

export type FreshBootstrapPrestate =
  | {
      kind: "absent";
      destinationPath: string;
      parent: PathIdentity;
    }
  | {
      kind: "empty-directory";
      destination: PathIdentity;
      parent: PathIdentity;
    };

export interface FreshBootstrapIdentity {
  initialBranch: string;
  authorName: string;
  authorEmail: string;
  commitMessage: string;
  commitTimestamp: string;
}

export interface FreshBootstrapFile {
  path: string;
  mode: "100644" | "100755";
  blob: string;
}

export interface FreshBootstrapProposal {
  version: typeof FRESH_BOOTSTRAP_VERSION;
  capability: {
    stateRoot: PathIdentity;
    allowedRoot: PathIdentity;
    systemGit: FreshBootstrapCapability["systemGit"];
    systemPython: FreshBootstrapCapability["systemPython"];
    systemGitIdentity: ExecutableIdentity;
    systemPythonIdentity: ExecutableIdentity;
    systemNode: string;
    systemNodeIdentity: ExecutableIdentity;
    lockStrategy: FreshBootstrapCapability["lockStrategy"];
    lockHelper: FreshBootstrapCapability["lockHelper"];
    lockHelperIdentity: ExecutableIdentity;
  };
  destinationPath: string;
  stagingPath: string;
  journalPath: string;
  lockPath: string;
  destinationLockDigest: string;
  claimMarkerName: ".repository-bootstrap-claim";
  atomicAdapterDigest: string;
  materializeAdapterDigest: string;
  destinationPrestate: FreshBootstrapPrestate;
  sourceReceiptDigest: string;
  sourceSha: string;
  sourceTree: string;
  contractDigest: string;
  reviewDigest: string;
  changeSetDigest: string;
  appSpecDigest: string;
  appSpecPath: string;
  applyDigest: string;
  validationDigest: string;
  repositoryIdentity: FreshBootstrapIdentity;
  exactTree: readonly FreshBootstrapFile[];
  exactTreeDigest: string;
  expectedGitTree: string;
  expectedInitialCommit: string;
  publicationIdentityDigest: string;
  intendedOutcome: "bootstrap-fresh-local-repository";
  githubOutcome: "unavailable";
  releaseEnabled: false;
  digest: string;
}

type TerminalBase = Omit<FreshBootstrapProposal, "digest"> & {
  proposalDigest: string;
  publishedByCallId: string;
  leaseMarkerDigest: string;
  recoveryOfDigest?: string;
  previousLeaseMarkerDigest?: string;
};

export type FreshBootstrapPendingReceipt = Omit<FreshBootstrapProposal, "digest"> & {
  proposalDigest: string;
  status: "pending";
  publishedByCallId: string;
  leaseMarkerDigest: string;
  recoveryOfDigest?: string;
  previousLeaseMarkerDigest?: string;
  layout: FreshBootstrapLayout;
  stageCreated: boolean;
  destinationPublished: boolean;
  digest: string;
};

export type FreshBootstrapSuccessReceipt = TerminalBase & {
  status: "succeeded";
  destinationIdentity: PathIdentity;
  gitDirectoryIdentity: PathIdentity;
  swappedOldIdentity?: PathIdentity;
  headReference: string;
  headCommit: string;
  headTree: string;
  commitCount: 1;
  remoteDigest: string;
  worktreeDigest: string;
  recoveryRequired: false;
  digest: string;
};

export enum FreshBootstrapFailureReason {
  PreconditionFailed = "precondition-failed",
  Collision = "collision",
  MaterializationPartial = "materialization-partial",
  PublicationPartial = "publication-partial",
  CapabilityDisabled = "capability-disabled",
  RecoveryConflict = "recovery-conflict",
}

export type FreshBootstrapFailureReceipt = TerminalBase & {
  status: "failed";
  reason: FreshBootstrapFailureReason;
  failureMessage: string;
  layout: FreshBootstrapLayout;
  stageCreated: boolean;
  destinationPublished: boolean;
  recoveryRequired: true;
  digest: string;
};

export type FreshBootstrapJournal =
  | FreshBootstrapPendingReceipt
  | FreshBootstrapSuccessReceipt
  | FreshBootstrapFailureReceipt;

export type FreshBootstrapLayout =
  | { phase: "intent" }
  | { phase: "stage-owned"; stageIdentity: PathIdentity }
  | { phase: "stage-ready"; stageIdentity: PathIdentity }
  | {
      phase: "published";
      destinationIdentity: PathIdentity;
      swappedOldIdentity?: PathIdentity;
    };

const GIT_OBJECT_HASH = "sha1";

const makeGitHash = (algorithm: string) => createHash(algorithm);

const sha1Object = (kind: "blob" | "tree" | "commit", objectBytes: Uint8Array) =>
  // SAFETY: Git requires SHA-1 object IDs; this digest is only for Git format compatibility.
  makeGitHash(GIT_OBJECT_HASH)
    .update(Buffer.from(`${kind} ${objectBytes.byteLength}\0`))
    .update(objectBytes)
    .digest("hex");

interface Tree {
  files: FreshBootstrapFile[];
  directories: Map<string, Tree>;
}

const FRESH_BOOTSTRAP_MARKER = ".repository-bootstrap-claim";

const encodeTreeEntry = ({ mode, name, oid }: { mode: string; name: string; oid: string }) =>
  Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);

const hasReservedComponent = (components: readonly string[]): boolean =>
  components.some((component) => {
    const normalized = component.toLowerCase();
    return normalized === ".git" || normalized === FRESH_BOOTSTRAP_MARKER;
  });

const hasParentPath = (components: readonly string[], paths: ReadonlySet<string>): boolean => {
  for (let index = 1; index < components.length; index += 1) {
    if (paths.has(components.slice(0, index).join("/"))) {
      return true;
    }
  }
  return false;
};

const hasChildPath = (path: string, paths: ReadonlySet<string>): boolean => {
  for (const existingPath of paths) {
    if (existingPath.startsWith(`${path}/`)) {
      return true;
    }
  }
  return false;
};

const validateTreeFile = (file: FreshBootstrapFile, components: string[], paths: Set<string>) =>
  isValidTreeBlob(file) &&
  isUniqueTreePath(file, components, paths) &&
  !hasParentPath(components, paths) &&
  !hasChildPath(file.path, paths);

const isValidTreeBlob = (file: FreshBootstrapFile) =>
  safeSourcePath(file.path) && /^[0-9a-f]{40}$/u.test(file.blob);

const isUniqueTreePath = (file: FreshBootstrapFile, components: string[], paths: Set<string>) =>
  !paths.has(file.path) && !hasReservedComponent(components);

export const gitTreeId = (files: readonly FreshBootstrapFile[]): string => {
  const root: Tree = { directories: new Map(), files: [] };
  const paths = new Set<string>();
  for (const file of files) {
    const components = file.path.split("/");
    if (!validateTreeFile(file, components, paths)) {
      throw new Error("The fresh-bootstrap tree contains an unsafe entry.");
    }
    paths.add(file.path);
    const segments = components;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = node.directories.get(segment) ?? {
        directories: new Map(),
        files: [],
      };
      node.directories.set(segment, next);
      node = next;
    }
    const leaf = segments.at(-1);
    if (leaf === undefined) {
      throw new Error("The fresh-bootstrap tree contains an unsafe entry.");
    }
    node.files.push({ ...file, path: leaf });
  }
  const walk = (node: Tree): string => {
    const entries = [
      ...node.files.map((file) => ({
        mode: file.mode,
        name: file.path,
        oid: file.blob,
        sort: file.path,
      })),
      ...[...node.directories].map(([name, child]) => ({
        mode: "40000" as const,
        name,
        oid: walk(child),
        sort: `${name}/`,
      })),
    ].toSorted((left, right) => Buffer.from(left.sort).compare(Buffer.from(right.sort)));
    return sha1Object("tree", Buffer.concat(entries.map(encodeTreeEntry)));
  };
  return walk(root);
};

const commitActor = (identity: FreshBootstrapIdentity): string => {
  const validBranch = isValidInitialBranch(identity.initialBranch);
  const validAuthor =
    identity.authorName.trim() === identity.authorName &&
    identity.authorName.length > 0 &&
    !/[\n\r<>]/u.test(identity.authorName) &&
    /^[^\s<>@]+@[^\s<>@]+$/u.test(identity.authorEmail);
  const validMessage =
    !/[\0\r]/u.test(identity.commitMessage) && identity.commitMessage.trim().length > 0;
  if (!validBranch || !validAuthor || !validMessage) {
    throw new Error("The fresh-bootstrap Git identity is invalid.");
  }
  const milliseconds = Date.parse(identity.commitTimestamp);
  const offset = /(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2})$/u.exec(identity.commitTimestamp);
  if (!Number.isFinite(milliseconds) || offset === null) {
    throw new Error("The fresh-bootstrap commit timestamp is invalid.");
  }
  return `${identity.authorName} <${identity.authorEmail}> ${Math.floor(milliseconds / 1000)} ${offset[1]}${offset[2]}${offset[3]}`;
};

const isValidInitialBranch = (branch: string) => {
  if (!/^(?![.-])[A-Za-z0-9._/-]+$/u.test(branch)) {
    return false;
  }
  return !["..", "@{", "//"].some((part) => branch.includes(part)) && !branch.endsWith("/");
};

export const initialCommitId = (input: {
  tree: string;
  identity: FreshBootstrapIdentity;
}): string => {
  const actor = commitActor(input.identity);
  const message = input.identity.commitMessage.endsWith("\n")
    ? input.identity.commitMessage
    : `${input.identity.commitMessage}\n`;
  return sha1Object(
    "commit",
    Buffer.from(`tree ${input.tree}\nauthor ${actor}\ncommitter ${actor}\n\n${message}`),
  );
};

const exactCapability = (
  capability: FreshBootstrapCapability,
): FreshBootstrapProposal["capability"] => {
  if (
    capability.authority !== "configured-production" &&
    capability.authority !== "structural-test-injection"
  ) {
    throw new Error("Fresh local bootstrap capability is not authorized.");
  }
  return {
    allowedRoot: capability.allowedRoot,
    lockHelper: capability.lockHelper,
    lockHelperIdentity: capability.lockHelperIdentity,
    lockStrategy: capability.lockStrategy,
    stateRoot: capability.stateRoot,
    systemGit: capability.systemGit,
    systemGitIdentity: capability.systemGitIdentity,
    systemNode: capability.systemNode,
    systemNodeIdentity: capability.systemNodeIdentity,
    systemPython: capability.systemPython,
    systemPythonIdentity: capability.systemPythonIdentity,
  };
};

export const createFreshBootstrapProposal = (input: {
  capability: FreshBootstrapCapability;
  destinationPath: string;
  stagingPath: string;
  atomicAdapterDigest: string;
  materializeAdapterDigest: string;
  journalPath: string;
  lockPath: string;
  destinationPrestate: FreshBootstrapPrestate;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  repositoryIdentity: FreshBootstrapIdentity;
  exactTree: readonly FreshBootstrapFile[];
}): FreshBootstrapProposal => {
  assertExactReviewedChangeSet(input.review);
  if (input.sourceReceipt.sourceKind !== "fresh-template") {
    throw new Error("Fresh bootstrap requires a fresh-template source.");
  }
  if (
    input.review.sourceSha !== input.sourceReceipt.sourceSha ||
    input.review.sourceTree !== input.sourceReceipt.sourceTree ||
    input.review.repositoryContractDigest !== input.sourceReceipt.contractDigest
  ) {
    throw new Error("The fresh-bootstrap source and review bindings differ.");
  }
  const capability = exactCapability(input.capability);
  const destinationLockDigest = stableDigest({
    allowedRoot: capability.allowedRoot,
    destinationPath: input.destinationPath,
  });
  const expectedGitTree = gitTreeId(input.exactTree);
  const publicationIdentityDigest = stableDigest({
    allowedRoot: capability.allowedRoot,
    destinationPath: input.destinationPath,
    destinationPrestate: input.destinationPrestate,
    expectedGitTree,
    repositoryIdentity: input.repositoryIdentity,
    reviewDigest: input.review.digest,
    sourceReceiptDigest: input.sourceReceipt.digest,
    stateRoot: capability.stateRoot,
  });
  const unsigned = {
    appSpecDigest: input.review.appSpecDigest,
    appSpecPath: input.review.appSpecPath,
    applyDigest: input.review.applyDigest,
    atomicAdapterDigest: input.atomicAdapterDigest,
    capability,
    changeSetDigest: input.review.changeSetDigest,
    claimMarkerName: ".repository-bootstrap-claim" as const,
    contractDigest: input.sourceReceipt.contractDigest,
    destinationLockDigest,
    destinationPath: input.destinationPath,
    destinationPrestate: input.destinationPrestate,
    exactTree: input.exactTree,
    exactTreeDigest: stableDigest(input.exactTree),
    expectedGitTree,
    expectedInitialCommit: initialCommitId({
      identity: input.repositoryIdentity,
      tree: expectedGitTree,
    }),
    githubOutcome: "unavailable" as const,
    intendedOutcome: "bootstrap-fresh-local-repository" as const,
    journalPath: input.journalPath,
    lockPath: input.lockPath,
    materializeAdapterDigest: input.materializeAdapterDigest,
    publicationIdentityDigest,
    releaseEnabled: false as const,
    repositoryIdentity: input.repositoryIdentity,
    reviewDigest: input.review.digest,
    sourceReceiptDigest: input.sourceReceipt.digest,
    sourceSha: input.sourceReceipt.sourceSha,
    sourceTree: input.sourceReceipt.sourceTree,
    stagingPath: input.stagingPath,
    validationDigest: input.review.validationDigest,
    version: FRESH_BOOTSTRAP_VERSION,
  };
  return { ...unsigned, digest: stableDigest(unsigned) };
};

type UnsignedProposal = Omit<FreshBootstrapProposal, "digest">;

const canonicalProposal = (proposal: FreshBootstrapProposal): UnsignedProposal => ({
  appSpecDigest: proposal.appSpecDigest,
  appSpecPath: proposal.appSpecPath,
  applyDigest: proposal.applyDigest,
  atomicAdapterDigest: proposal.atomicAdapterDigest,
  capability: proposal.capability,
  changeSetDigest: proposal.changeSetDigest,
  claimMarkerName: proposal.claimMarkerName,
  contractDigest: proposal.contractDigest,
  destinationLockDigest: proposal.destinationLockDigest,
  destinationPath: proposal.destinationPath,
  destinationPrestate: proposal.destinationPrestate,
  exactTree: proposal.exactTree,
  exactTreeDigest: proposal.exactTreeDigest,
  expectedGitTree: proposal.expectedGitTree,
  expectedInitialCommit: proposal.expectedInitialCommit,
  githubOutcome: proposal.githubOutcome,
  intendedOutcome: proposal.intendedOutcome,
  journalPath: proposal.journalPath,
  lockPath: proposal.lockPath,
  materializeAdapterDigest: proposal.materializeAdapterDigest,
  publicationIdentityDigest: proposal.publicationIdentityDigest,
  releaseEnabled: proposal.releaseEnabled,
  repositoryIdentity: proposal.repositoryIdentity,
  reviewDigest: proposal.reviewDigest,
  sourceReceiptDigest: proposal.sourceReceiptDigest,
  sourceSha: proposal.sourceSha,
  sourceTree: proposal.sourceTree,
  stagingPath: proposal.stagingPath,
  validationDigest: proposal.validationDigest,
  version: proposal.version,
});

const hasExactKeys = <Value extends object>(
  value: Value,
  keys: readonly string[] & readonly (keyof Value | string)[],
): boolean => {
  const observed = Object.keys(value).toSorted();
  return JSON.stringify(observed) === JSON.stringify([...keys].toSorted());
};

const pathIdentityKeys = ["path", "device", "inode", "uid", "mode", "nlink"] as const;
const executableIdentityKeys = [...pathIdentityKeys, "sha256"] as const;
const pathIdentityValidators: readonly ((value: PathIdentity) => boolean)[] = [
  ({ path }) => path.startsWith("/"),
  ({ device }) => /^\d+$/u.test(device),
  ({ inode }) => /^\d+$/u.test(inode),
  ({ uid }) => /^\d+$/u.test(uid),
  ({ mode }) => /^[0-7]+$/u.test(mode),
  ({ nlink }) => /^\d+$/u.test(nlink),
];

const validPathIdentity = (value: PathIdentity): boolean =>
  pathIdentityValidators.every((validator) => validator(value));

const IDENTITY_DIGEST_LENGTH = 64;
const JOURNAL_MALFORMED = "The fresh-bootstrap journal is malformed.";

const validExecutableIdentity = (value: ExecutableIdentity): boolean =>
  validPathIdentity(value) &&
  new RegExp(`^[0-9a-f]{${IDENTITY_DIGEST_LENGTH}}$`, "u").test(value.sha256);

const proposalPathIdentities = (proposal: FreshBootstrapProposal): PathIdentity[] => {
  const identities = [
    proposal.capability.stateRoot,
    proposal.capability.allowedRoot,
    proposal.destinationPrestate.parent,
  ];
  if (proposal.destinationPrestate.kind === "empty-directory") {
    identities.push(proposal.destinationPrestate.destination);
  }
  return identities;
};

const proposalExactKeys = [
  "version",
  "capability",
  "destinationPath",
  "stagingPath",
  "journalPath",
  "lockPath",
  "destinationLockDigest",
  "claimMarkerName",
  "atomicAdapterDigest",
  "materializeAdapterDigest",
  "destinationPrestate",
  "sourceReceiptDigest",
  "sourceSha",
  "sourceTree",
  "contractDigest",
  "reviewDigest",
  "changeSetDigest",
  "appSpecDigest",
  "appSpecPath",
  "applyDigest",
  "validationDigest",
  "repositoryIdentity",
  "exactTree",
  "exactTreeDigest",
  "expectedGitTree",
  "expectedInitialCommit",
  "publicationIdentityDigest",
  "intendedOutcome",
  "githubOutcome",
  "releaseEnabled",
  "digest",
] as const;

const proposalCapabilityKeys = [
  "stateRoot",
  "allowedRoot",
  "systemGit",
  "systemPython",
  "systemGitIdentity",
  "systemPythonIdentity",
  "systemNode",
  "systemNodeIdentity",
  "lockStrategy",
  "lockHelper",
  "lockHelperIdentity",
] as const;

const hasCanonicalProposalKeys = (proposal: FreshBootstrapProposal): boolean =>
  hasExactKeys(proposal, proposalExactKeys) &&
  hasExactKeys(proposal.capability, proposalCapabilityKeys) &&
  proposalPathIdentities(proposal).every((identity) => hasExactKeys(identity, pathIdentityKeys));

const validProposalIdentity = (proposal: FreshBootstrapProposal): boolean => {
  const { capability } = proposal;
  const identities = proposalPathIdentities(proposal);
  const executableIdentities = [
    capability.systemGitIdentity,
    capability.systemPythonIdentity,
    capability.systemNodeIdentity,
    capability.lockHelperIdentity,
  ];
  return (
    identities.every(validPathIdentity) &&
    executableIdentities.every(validExecutableIdentity) &&
    ["flock", "lockf"].includes(capability.lockStrategy)
  );
};

const dirnameForComparison = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

const validProposalShape = (proposal: FreshBootstrapProposal): boolean => {
  if (!hasCanonicalProposalKeys(proposal)) {
    return false;
  }
  if (!proposalPathIdentities(proposal).every((value) => hasExactKeys(value, pathIdentityKeys))) {
    return false;
  }
  const executableIdentities = [
    proposal.capability.systemGitIdentity,
    proposal.capability.systemPythonIdentity,
    proposal.capability.systemNodeIdentity,
    proposal.capability.lockHelperIdentity,
  ];
  if (!executableIdentities.every((value) => hasExactKeys(value, executableIdentityKeys))) {
    return false;
  }
  const prestateKeys =
    proposal.destinationPrestate.kind === "absent"
      ? ["kind", "destinationPath", "parent"]
      : ["kind", "destination", "parent"];
  if (!hasExactKeys(proposal.destinationPrestate, prestateKeys)) {
    return false;
  }
  if (
    !hasExactKeys(proposal.repositoryIdentity, [
      "initialBranch",
      "authorName",
      "authorEmail",
      "commitMessage",
      "commitTimestamp",
    ])
  ) {
    return false;
  }
  return proposal.exactTree.every((file) => hasExactKeys(file, ["path", "mode", "blob"]));
};

const validProposalBindings = (proposal: FreshBootstrapProposal): boolean => {
  if (
    proposal.version !== FRESH_BOOTSTRAP_VERSION ||
    proposal.githubOutcome !== "unavailable" ||
    proposal.releaseEnabled
  ) {
    return false;
  }
  if (
    !/^[0-9a-f]{64}$/u.test(proposal.atomicAdapterDigest) ||
    !/^[0-9a-f]{64}$/u.test(proposal.materializeAdapterDigest)
  ) {
    return false;
  }
  const expectedLockDigest = stableDigest({
    allowedRoot: proposal.capability.allowedRoot,
    destinationPath: proposal.destinationPath,
  });
  if (proposal.destinationLockDigest !== expectedLockDigest) {
    return false;
  }
  const expectedLockPath = `${proposal.capability.stateRoot.path}/locks/${proposal.destinationLockDigest}.lock`;
  if (proposal.lockPath !== expectedLockPath) {
    return false;
  }
  if (
    dirnameForComparison(proposal.stagingPath) !== dirnameForComparison(proposal.destinationPath)
  ) {
    return false;
  }
  if (proposal.exactTreeDigest !== stableDigest(proposal.exactTree)) {
    return false;
  }
  if (proposal.expectedGitTree !== gitTreeId(proposal.exactTree)) {
    return false;
  }
  const expectedCommit = initialCommitId({
    identity: proposal.repositoryIdentity,
    tree: proposal.expectedGitTree,
  });
  return (
    proposal.expectedInitialCommit === expectedCommit &&
    proposal.digest === stableDigest(canonicalProposal(proposal))
  );
};

export const assertExactFreshBootstrapProposal = (proposal: FreshBootstrapProposal): void => {
  if (
    !validProposalIdentity(proposal) ||
    !validProposalShape(proposal) ||
    !validProposalBindings(proposal)
  ) {
    throw new Error("The fresh-bootstrap proposal is not canonical V3.");
  }
};

export const freshBootstrapJournalDigest = (
  value: FreshBootstrapJournal | Omit<FreshBootstrapJournal, "digest">,
) => stableDigest(value);

export const proposalFromFreshBootstrapJournal = (
  journal: FreshBootstrapJournal,
): FreshBootstrapProposal => ({
  appSpecDigest: journal.appSpecDigest,
  appSpecPath: journal.appSpecPath,
  applyDigest: journal.applyDigest,
  atomicAdapterDigest: journal.atomicAdapterDigest,
  capability: journal.capability,
  changeSetDigest: journal.changeSetDigest,
  claimMarkerName: journal.claimMarkerName,
  contractDigest: journal.contractDigest,
  destinationLockDigest: journal.destinationLockDigest,
  destinationPath: journal.destinationPath,
  destinationPrestate: journal.destinationPrestate,
  digest: journal.proposalDigest,
  exactTree: journal.exactTree,
  exactTreeDigest: journal.exactTreeDigest,
  expectedGitTree: journal.expectedGitTree,
  expectedInitialCommit: journal.expectedInitialCommit,
  githubOutcome: journal.githubOutcome,
  intendedOutcome: journal.intendedOutcome,
  journalPath: journal.journalPath,
  lockPath: journal.lockPath,
  materializeAdapterDigest: journal.materializeAdapterDigest,
  publicationIdentityDigest: journal.publicationIdentityDigest,
  releaseEnabled: journal.releaseEnabled,
  repositoryIdentity: journal.repositoryIdentity,
  reviewDigest: journal.reviewDigest,
  sourceReceiptDigest: journal.sourceReceiptDigest,
  sourceSha: journal.sourceSha,
  sourceTree: journal.sourceTree,
  stagingPath: journal.stagingPath,
  validationDigest: journal.validationDigest,
  version: journal.version,
});

const assertExactPathIdentity = (value: PathIdentity, label: string): void => {
  if (!validPathIdentity(value)) {
    throw new Error(`The fresh-bootstrap ${label} identity is malformed.`);
  }
};

const assertExactFreshBootstrapLayout = (layout: FreshBootstrapLayout): void => {
  let keys: string[];
  if (layout.phase === "intent") {
    keys = ["phase"];
  } else if (layout.phase === "stage-owned" || layout.phase === "stage-ready") {
    keys = ["phase", "stageIdentity"];
  } else if (layout.phase === "published") {
    keys = [
      "phase",
      "destinationIdentity",
      ...(layout.swappedOldIdentity === undefined ? [] : ["swappedOldIdentity"]),
    ];
  } else {
    keys = [];
  }
  if (!hasExactKeys(layout, keys)) {
    throw new Error("The fresh-bootstrap layout receipt is malformed.");
  }
  for (const value of [
    ...(layout.phase === "stage-owned" || layout.phase === "stage-ready"
      ? [layout.stageIdentity]
      : []),
    ...(layout.phase === "published" ? [layout.destinationIdentity] : []),
    ...(layout.phase === "published" && layout.swappedOldIdentity !== undefined
      ? [layout.swappedOldIdentity]
      : []),
  ]) {
    assertExactPathIdentity(value, "layout");
  }
};

const assertJournalEnvelope = (journal: FreshBootstrapJournal): void => {
  const callIdValid =
    journal.publishedByCallId.length > 0 && journal.publishedByCallId.length <= 512;
  const failedMessageValid =
    journal.status !== "failed" ||
    (journal.failureMessage.length > 0 && journal.failureMessage.length <= 4096);
  if (!callIdValid || !failedMessageValid) {
    throw new Error(JOURNAL_MALFORMED);
  }
};

export const assertCanonicalFreshBootstrapJournal = (journal: FreshBootstrapJournal): void => {
  assertJournalEnvelope(journal);
  const proposal = proposalFromFreshBootstrapJournal(journal);
  const proposalKeys = Object.keys(canonicalProposal(proposal));
  const lineageKeys = [
    ...(journal.recoveryOfDigest === undefined ? [] : ["recoveryOfDigest"]),
    ...(journal.previousLeaseMarkerDigest === undefined ? [] : ["previousLeaseMarkerDigest"]),
  ];
  const common = [
    ...proposalKeys,
    "proposalDigest",
    "status",
    "publishedByCallId",
    "leaseMarkerDigest",
    ...lineageKeys,
    "digest",
  ];
  let expectedKeys: string[];
  if (journal.status === "pending") {
    expectedKeys = [...common, "layout", "stageCreated", "destinationPublished"];
  } else if (journal.status === "failed") {
    expectedKeys = [
      ...common,
      "reason",
      "failureMessage",
      "layout",
      "stageCreated",
      "destinationPublished",
      "recoveryRequired",
    ];
  } else if (journal.status === "succeeded") {
    expectedKeys = [
      ...common,
      "destinationIdentity",
      "gitDirectoryIdentity",
      ...(journal.swappedOldIdentity === undefined ? [] : ["swappedOldIdentity"]),
      "headReference",
      "headCommit",
      "headTree",
      "commitCount",
      "remoteDigest",
      "worktreeDigest",
      "recoveryRequired",
    ];
  } else {
    expectedKeys = [];
  }
  const { digest, ...unsigned } = journal;
  if (
    !hasExactKeys(journal, expectedKeys) ||
    !/^[0-9a-f]{64}$/u.test(journal.leaseMarkerDigest) ||
    (journal.recoveryOfDigest === undefined) !==
      (journal.previousLeaseMarkerDigest === undefined) ||
    (journal.recoveryOfDigest !== undefined &&
      (!/^[0-9a-f]{64}$/u.test(journal.recoveryOfDigest) ||
        !/^[0-9a-f]{64}$/u.test(journal.previousLeaseMarkerDigest ?? ""))) ||
    ((journal.status === "pending" || journal.status === "failed") &&
      (journal.stageCreated !== (journal.layout.phase !== "intent") ||
        journal.destinationPublished !== (journal.layout.phase === "published"))) ||
    (journal.status === "failed" && !journal.recoveryRequired) ||
    (journal.status === "succeeded" &&
      (journal.recoveryRequired ||
        journal.commitCount !== 1 ||
        (journal.destinationPrestate.kind === "empty-directory") !==
          (journal.swappedOldIdentity !== undefined))) ||
    digest !== freshBootstrapJournalDigest(unsigned) ||
    journal.proposalDigest !== proposal.digest
  ) {
    throw new Error("The fresh-bootstrap journal is malformed.");
  }
  if (journal.status === "pending" || journal.status === "failed") {
    assertExactFreshBootstrapLayout(journal.layout);
  }
  if (journal.status === "succeeded") {
    assertExactPathIdentity(journal.destinationIdentity, "destination");
    assertExactPathIdentity(journal.gitDirectoryIdentity, "Git directory");
    if (journal.swappedOldIdentity !== undefined) {
      assertExactPathIdentity(journal.swappedOldIdentity, "swapped-old");
    }
    if (
      journal.headReference !== `refs/heads/${journal.repositoryIdentity.initialBranch}` ||
      journal.headCommit !== journal.expectedInitialCommit ||
      journal.headTree !== journal.expectedGitTree ||
      !/^[0-9a-f]{64}$/u.test(journal.remoteDigest) ||
      !/^[0-9a-f]{64}$/u.test(journal.worktreeDigest)
    ) {
      throw new Error("The fresh-bootstrap success receipt is malformed.");
    }
  }
  assertExactFreshBootstrapProposal(proposal);
};

export const exactFreshBootstrapProposalMatch = (
  left: FreshBootstrapProposal,
  right: FreshBootstrapProposal,
): boolean =>
  left.digest === right.digest &&
  JSON.stringify(canonicalProposal(left)) === JSON.stringify(canonicalProposal(right));
