import { createHash } from "node:crypto";

import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import {
  assertExactReviewedChangeSet,
  stableDigest,
} from "./local-publication";
import type { SourceReceipt } from "./source-receipt";
import { safeSourcePath } from "./source-path";

export const FRESH_BOOTSTRAP_VERSION = 3 as const;

export type PathIdentity = {
  path: string;
  device: string;
  inode: string;
  uid: string;
  mode: string;
  nlink: string;
};

export type ExecutableIdentity = PathIdentity & { sha256: string };

export type FreshBootstrapCapability = {
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
};

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

export type FreshBootstrapIdentity = {
  initialBranch: string;
  authorName: string;
  authorEmail: string;
  commitMessage: string;
  commitTimestamp: string;
};

export type FreshBootstrapFile = {
  path: string;
  mode: "100644" | "100755";
  blob: string;
};

export type FreshBootstrapProposal = {
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
};

type TerminalBase = Omit<FreshBootstrapProposal, "digest"> & {
  proposalDigest: string;
  publishedByCallId: string;
  leaseMarkerDigest: string;
  recoveryOfDigest?: string;
  previousLeaseMarkerDigest?: string;
};

export type FreshBootstrapPendingReceipt = Omit<
  FreshBootstrapProposal,
  "digest"
> & {
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

export type FreshBootstrapFailureReceipt = TerminalBase & {
  status: "failed";
  reason:
    | "precondition-failed"
    | "collision"
    | "materialization-partial"
    | "publication-partial"
    | "capability-disabled"
    | "recovery-conflict";
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

const sha1Object = (kind: "blob" | "tree" | "commit", bytes: Uint8Array) =>
  createHash("sha1")
    .update(Buffer.from(`${kind} ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");

type Tree = { files: FreshBootstrapFile[]; directories: Map<string, Tree> };

export function gitTreeId(files: readonly FreshBootstrapFile[]): string {
  const root: Tree = { files: [], directories: new Map() };
  const paths = new Set<string>();
  for (const file of files) {
    const components = file.path.split("/");
    if (
      !safeSourcePath(file.path) ||
      !/^[0-9a-f]{40}$/u.test(file.blob) ||
      paths.has(file.path) ||
      components.some((component) =>
        [".git", ".repository-bootstrap-claim"].includes(
          component.toLowerCase(),
        ),
      ) ||
      components.some((_, index) =>
        paths.has(components.slice(0, index + 1).join("/")),
      ) ||
      [...paths].some((path) => path.startsWith(`${file.path}/`))
    )
      throw new Error("The fresh-bootstrap tree contains an unsafe entry.");
    paths.add(file.path);
    const segments = components;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = node.directories.get(segment) ?? {
        files: [],
        directories: new Map(),
      };
      node.directories.set(segment, next);
      node = next;
    }
    node.files.push({ ...file, path: segments.at(-1)! });
  }
  const walk = (node: Tree): string => {
    const entries = [
      ...node.files.map((file) => ({
        name: file.path,
        sort: file.path,
        mode: file.mode,
        oid: file.blob,
      })),
      ...[...node.directories].map(([name, child]) => ({
        name,
        sort: `${name}/`,
        mode: "40000" as const,
        oid: walk(child),
      })),
    ].toSorted((left, right) =>
      Buffer.from(left.sort).compare(Buffer.from(right.sort)),
    );
    return sha1Object(
      "tree",
      Buffer.concat(
        entries.map(({ mode, name, oid }) =>
          Buffer.concat([
            Buffer.from(`${mode} ${name}\0`),
            Buffer.from(oid, "hex"),
          ]),
        ),
      ),
    );
  };
  return walk(root);
}

function commitActor(identity: FreshBootstrapIdentity): string {
  if (
    !/^(?![.-])[A-Za-z0-9._/-]+$/u.test(identity.initialBranch) ||
    identity.initialBranch.includes("..") ||
    identity.initialBranch.includes("@{") ||
    identity.initialBranch.includes("//") ||
    identity.initialBranch.endsWith("/") ||
    identity.authorName.trim() !== identity.authorName ||
    identity.authorName.length === 0 ||
    /[\n\r<>]/u.test(identity.authorName) ||
    !/^[^\s<>@]+@[^\s<>@]+$/u.test(identity.authorEmail) ||
    /[\0\r]/u.test(identity.commitMessage) ||
    identity.commitMessage.trim().length === 0
  )
    throw new Error("The fresh-bootstrap Git identity is invalid.");
  const milliseconds = Date.parse(identity.commitTimestamp);
  const offset = /([+-])(\d{2}):(\d{2})$/u.exec(identity.commitTimestamp);
  if (!Number.isFinite(milliseconds) || offset === null)
    throw new Error("The fresh-bootstrap commit timestamp is invalid.");
  return `${identity.authorName} <${identity.authorEmail}> ${Math.floor(milliseconds / 1000)} ${offset[1]}${offset[2]}${offset[3]}`;
}

export function initialCommitId(input: {
  tree: string;
  identity: FreshBootstrapIdentity;
}): string {
  const actor = commitActor(input.identity);
  const message = input.identity.commitMessage.endsWith("\n")
    ? input.identity.commitMessage
    : `${input.identity.commitMessage}\n`;
  return sha1Object(
    "commit",
    Buffer.from(
      `tree ${input.tree}\nauthor ${actor}\ncommitter ${actor}\n\n${message}`,
    ),
  );
}

function exactCapability(
  capability: FreshBootstrapCapability,
): FreshBootstrapProposal["capability"] {
  if (
    capability.authority !== "configured-production" &&
    capability.authority !== "structural-test-injection"
  )
    throw new Error("Fresh local bootstrap capability is not authorized.");
  return {
    stateRoot: capability.stateRoot,
    allowedRoot: capability.allowedRoot,
    systemGit: capability.systemGit,
    systemPython: capability.systemPython,
    systemGitIdentity: capability.systemGitIdentity,
    systemPythonIdentity: capability.systemPythonIdentity,
    systemNode: capability.systemNode,
    systemNodeIdentity: capability.systemNodeIdentity,
    lockStrategy: capability.lockStrategy,
    lockHelper: capability.lockHelper,
    lockHelperIdentity: capability.lockHelperIdentity,
  };
}

export function createFreshBootstrapProposal(input: {
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
}): FreshBootstrapProposal {
  assertExactReviewedChangeSet(input.review);
  if (input.sourceReceipt.sourceKind !== "fresh-template")
    throw new Error("Fresh bootstrap requires a fresh-template source.");
  if (
    input.review.sourceSha !== input.sourceReceipt.sourceSha ||
    input.review.repositoryContractDigest !== input.sourceReceipt.contractDigest
  )
    throw new Error("The fresh-bootstrap source and review bindings differ.");
  const capability = exactCapability(input.capability);
  const destinationLockDigest = stableDigest({
    allowedRoot: capability.allowedRoot,
    destinationPath: input.destinationPath,
  });
  const expectedGitTree = gitTreeId(input.exactTree);
  const publicationIdentityDigest = stableDigest({
    destinationPath: input.destinationPath,
    destinationPrestate: input.destinationPrestate,
    stateRoot: capability.stateRoot,
    allowedRoot: capability.allowedRoot,
    sourceReceiptDigest: input.sourceReceipt.digest,
    reviewDigest: input.review.digest,
    expectedGitTree,
    repositoryIdentity: input.repositoryIdentity,
  });
  const unsigned = {
    version: FRESH_BOOTSTRAP_VERSION,
    capability,
    destinationPath: input.destinationPath,
    stagingPath: input.stagingPath,
    journalPath: input.journalPath,
    lockPath: input.lockPath,
    destinationLockDigest,
    claimMarkerName: ".repository-bootstrap-claim" as const,
    atomicAdapterDigest: input.atomicAdapterDigest,
    materializeAdapterDigest: input.materializeAdapterDigest,
    destinationPrestate: input.destinationPrestate,
    sourceReceiptDigest: input.sourceReceipt.digest,
    sourceSha: input.sourceReceipt.sourceSha,
    sourceTree: input.sourceReceipt.sourceTree,
    contractDigest: input.sourceReceipt.contractDigest,
    reviewDigest: input.review.digest,
    changeSetDigest: input.review.changeSetDigest,
    appSpecDigest: input.review.appSpecDigest,
    appSpecPath: input.review.appSpecPath,
    applyDigest: input.review.applyDigest,
    validationDigest: input.review.validationDigest,
    repositoryIdentity: input.repositoryIdentity,
    exactTree: input.exactTree,
    exactTreeDigest: stableDigest(input.exactTree),
    expectedGitTree,
    expectedInitialCommit: initialCommitId({
      tree: expectedGitTree,
      identity: input.repositoryIdentity,
    }),
    publicationIdentityDigest,
    intendedOutcome: "bootstrap-fresh-local-repository" as const,
    githubOutcome: "unavailable" as const,
    releaseEnabled: false as const,
  };
  return { ...unsigned, digest: stableDigest(unsigned) };
}

function canonicalProposal(proposal: FreshBootstrapProposal) {
  const unsigned = { ...proposal } as Record<string, unknown>;
  delete unsigned.digest;
  return unsigned;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const observed = Object.keys(value).toSorted();
  return JSON.stringify(observed) === JSON.stringify([...keys].toSorted());
}

const pathIdentityKeys = [
  "path",
  "device",
  "inode",
  "uid",
  "mode",
  "nlink",
] as const;
const executableIdentityKeys = [...pathIdentityKeys, "sha256"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathIdentity(value: unknown): value is PathIdentity {
  if (!isRecord(value) || !hasExactKeys(value, pathIdentityKeys)) return false;
  return (
    typeof value.path === "string" &&
    value.path.startsWith("/") &&
    typeof value.device === "string" &&
    /^\d+$/u.test(value.device) &&
    typeof value.inode === "string" &&
    /^\d+$/u.test(value.inode) &&
    typeof value.uid === "string" &&
    /^\d+$/u.test(value.uid) &&
    typeof value.mode === "string" &&
    /^[0-7]+$/u.test(value.mode) &&
    typeof value.nlink === "string" &&
    /^\d+$/u.test(value.nlink)
  );
}

function isExecutableIdentity(value: unknown): value is ExecutableIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, executableIdentityKeys) &&
    isPathIdentity(
      Object.fromEntries(pathIdentityKeys.map((key) => [key, value[key]])),
    ) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256)
  );
}

export function assertExactFreshBootstrapProposal(
  proposal: FreshBootstrapProposal,
): void {
  if (
    !isRecord(proposal) ||
    !isRecord(proposal.capability) ||
    !isRecord(proposal.destinationPrestate) ||
    !isRecord(proposal.repositoryIdentity) ||
    !Array.isArray(proposal.exactTree) ||
    !isPathIdentity(proposal.capability.stateRoot) ||
    !isPathIdentity(proposal.capability.allowedRoot) ||
    !isPathIdentity(proposal.destinationPrestate.parent) ||
    (proposal.destinationPrestate.kind === "empty-directory" &&
      !isPathIdentity(proposal.destinationPrestate.destination)) ||
    (proposal.destinationPrestate.kind !== "empty-directory" &&
      proposal.destinationPrestate.kind !== "absent") ||
    !isExecutableIdentity(proposal.capability.systemGitIdentity) ||
    !isExecutableIdentity(proposal.capability.systemPythonIdentity) ||
    !isExecutableIdentity(proposal.capability.systemNodeIdentity) ||
    !isExecutableIdentity(proposal.capability.lockHelperIdentity) ||
    (proposal.capability.lockStrategy !== "flock" &&
      proposal.capability.lockStrategy !== "lockf")
  )
    throw new Error("The fresh-bootstrap proposal is not canonical V3.");
  if (
    !hasExactKeys(proposal, [
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
    ]) ||
    !hasExactKeys(proposal.capability, [
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
    ]) ||
    ![
      proposal.capability.stateRoot,
      proposal.capability.allowedRoot,
      proposal.destinationPrestate.parent,
      ...(proposal.destinationPrestate.kind === "empty-directory"
        ? [proposal.destinationPrestate.destination]
        : []),
    ].every((value) => hasExactKeys(value, pathIdentityKeys)) ||
    ![
      proposal.capability.systemGitIdentity,
      proposal.capability.systemPythonIdentity,
      proposal.capability.systemNodeIdentity,
      proposal.capability.lockHelperIdentity,
    ].every((value) => hasExactKeys(value, executableIdentityKeys)) ||
    !hasExactKeys(
      proposal.destinationPrestate,
      proposal.destinationPrestate.kind === "absent"
        ? ["kind", "destinationPath", "parent"]
        : ["kind", "destination", "parent"],
    ) ||
    !hasExactKeys(proposal.repositoryIdentity, [
      "initialBranch",
      "authorName",
      "authorEmail",
      "commitMessage",
      "commitTimestamp",
    ]) ||
    !proposal.exactTree.every((file) =>
      hasExactKeys(file, ["path", "mode", "blob"]),
    ) ||
    proposal.version !== FRESH_BOOTSTRAP_VERSION ||
    proposal.githubOutcome !== "unavailable" ||
    proposal.releaseEnabled !== false ||
    !/^[0-9a-f]{64}$/u.test(proposal.atomicAdapterDigest) ||
    !/^[0-9a-f]{64}$/u.test(proposal.materializeAdapterDigest) ||
    proposal.destinationLockDigest !==
      stableDigest({
        allowedRoot: proposal.capability.allowedRoot,
        destinationPath: proposal.destinationPath,
      }) ||
    proposal.lockPath !==
      `${proposal.capability.stateRoot.path}/locks/${proposal.destinationLockDigest}.lock` ||
    dirnameForComparison(proposal.stagingPath) !==
      dirnameForComparison(proposal.destinationPath) ||
    proposal.exactTreeDigest !== stableDigest(proposal.exactTree) ||
    proposal.expectedGitTree !== gitTreeId(proposal.exactTree) ||
    proposal.expectedInitialCommit !==
      initialCommitId({
        tree: proposal.expectedGitTree,
        identity: proposal.repositoryIdentity,
      }) ||
    proposal.digest !== stableDigest(canonicalProposal(proposal))
  )
    throw new Error("The fresh-bootstrap proposal is not canonical V3.");
}

function dirnameForComparison(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

export const freshBootstrapJournalDigest = (value: unknown) =>
  stableDigest(value);

export function proposalFromFreshBootstrapJournal(
  journal: FreshBootstrapJournal,
): FreshBootstrapProposal {
  const candidate = { ...journal } as Record<string, unknown>;
  const digest = journal.proposalDigest;
  for (const key of [
    "proposalDigest",
    "publishedByCallId",
    "leaseMarkerDigest",
    "recoveryOfDigest",
    "previousLeaseMarkerDigest",
    "status",
    "stageCreated",
    "destinationPublished",
    "reason",
    "failureMessage",
    "layout",
    "destinationIdentity",
    "gitDirectoryIdentity",
    "swappedOldIdentity",
    "headReference",
    "headCommit",
    "headTree",
    "commitCount",
    "remoteDigest",
    "worktreeDigest",
    "recoveryRequired",
    "digest",
  ])
    delete candidate[key];
  return { ...(candidate as Omit<FreshBootstrapProposal, "digest">), digest };
}

export function assertCanonicalFreshBootstrapJournal(
  journal: FreshBootstrapJournal,
): void {
  if (
    !isRecord(journal) ||
    (journal.status !== "pending" &&
      journal.status !== "failed" &&
      journal.status !== "succeeded") ||
    typeof journal.publishedByCallId !== "string" ||
    journal.publishedByCallId.length === 0 ||
    journal.publishedByCallId.length > 512 ||
    typeof journal.leaseMarkerDigest !== "string" ||
    (journal.recoveryOfDigest !== undefined &&
      typeof journal.recoveryOfDigest !== "string") ||
    (journal.previousLeaseMarkerDigest !== undefined &&
      typeof journal.previousLeaseMarkerDigest !== "string") ||
    ((journal.status === "pending" || journal.status === "failed") &&
      (typeof journal.stageCreated !== "boolean" ||
        typeof journal.destinationPublished !== "boolean")) ||
    (journal.status === "failed" &&
      (![
        "precondition-failed",
        "collision",
        "materialization-partial",
        "publication-partial",
        "capability-disabled",
        "recovery-conflict",
      ].includes(journal.reason) ||
        typeof journal.failureMessage !== "string" ||
        journal.failureMessage.length === 0 ||
        journal.failureMessage.length > 4_096)) ||
    (journal.status === "succeeded" &&
      (typeof journal.headReference !== "string" ||
        typeof journal.headCommit !== "string" ||
        typeof journal.headTree !== "string" ||
        typeof journal.remoteDigest !== "string" ||
        typeof journal.worktreeDigest !== "string"))
  )
    throw new Error("The fresh-bootstrap journal is malformed.");
  const proposal = proposalFromFreshBootstrapJournal(journal);
  const proposalKeys = Object.keys(canonicalProposal(proposal));
  const lineageKeys = [
    ...(journal.recoveryOfDigest === undefined ? [] : ["recoveryOfDigest"]),
    ...(journal.previousLeaseMarkerDigest === undefined
      ? []
      : ["previousLeaseMarkerDigest"]),
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
  const expectedKeys =
    journal.status === "pending"
      ? [...common, "layout", "stageCreated", "destinationPublished"]
      : journal.status === "failed"
        ? [
            ...common,
            "reason",
            "failureMessage",
            "layout",
            "stageCreated",
            "destinationPublished",
            "recoveryRequired",
          ]
        : journal.status === "succeeded"
          ? [
              ...common,
              "destinationIdentity",
              "gitDirectoryIdentity",
              ...(journal.swappedOldIdentity === undefined
                ? []
                : ["swappedOldIdentity"]),
              "headReference",
              "headCommit",
              "headTree",
              "commitCount",
              "remoteDigest",
              "worktreeDigest",
              "recoveryRequired",
            ]
          : [];
  const { digest, ...unsigned } = journal;
  if (
    !hasExactKeys(journal, expectedKeys) ||
    !/^[0-9a-f]{64}$/u.test(journal.leaseMarkerDigest) ||
    (journal.recoveryOfDigest === undefined) !==
      (journal.previousLeaseMarkerDigest === undefined) ||
    (journal.recoveryOfDigest !== undefined &&
      (!/^[0-9a-f]{64}$/u.test(journal.recoveryOfDigest) ||
        !/^[0-9a-f]{64}$/u.test(journal.previousLeaseMarkerDigest!))) ||
    ((journal.status === "pending" || journal.status === "failed") &&
      (journal.stageCreated !== (journal.layout.phase !== "intent") ||
        journal.destinationPublished !==
          (journal.layout.phase === "published"))) ||
    (journal.status === "failed" && journal.recoveryRequired !== true) ||
    (journal.status === "succeeded" &&
      (journal.recoveryRequired !== false ||
        journal.commitCount !== 1 ||
        (journal.destinationPrestate.kind === "empty-directory") !==
          (journal.swappedOldIdentity !== undefined))) ||
    digest !== freshBootstrapJournalDigest(unsigned) ||
    journal.proposalDigest !== proposal.digest
  )
    throw new Error("The fresh-bootstrap journal is malformed.");
  if (journal.status === "pending" || journal.status === "failed")
    assertExactFreshBootstrapLayout(journal.layout);
  if (journal.status === "succeeded") {
    assertExactPathIdentity(journal.destinationIdentity, "destination");
    assertExactPathIdentity(journal.gitDirectoryIdentity, "Git directory");
    if (journal.swappedOldIdentity !== undefined)
      assertExactPathIdentity(journal.swappedOldIdentity, "swapped-old");
    if (
      journal.headReference !==
        `refs/heads/${journal.repositoryIdentity.initialBranch}` ||
      journal.headCommit !== journal.expectedInitialCommit ||
      journal.headTree !== journal.expectedGitTree ||
      !/^[0-9a-f]{64}$/u.test(journal.remoteDigest) ||
      !/^[0-9a-f]{64}$/u.test(journal.worktreeDigest)
    )
      throw new Error("The fresh-bootstrap success receipt is malformed.");
  }
  assertExactFreshBootstrapProposal(proposal);
}

function assertExactFreshBootstrapLayout(layout: FreshBootstrapLayout): void {
  const keys =
    layout.phase === "intent"
      ? ["phase"]
      : layout.phase === "stage-owned" || layout.phase === "stage-ready"
        ? ["phase", "stageIdentity"]
        : layout.phase === "published"
          ? [
              "phase",
              "destinationIdentity",
              ...(layout.swappedOldIdentity === undefined
                ? []
                : ["swappedOldIdentity"]),
            ]
          : [];
  if (!hasExactKeys(layout, keys))
    throw new Error("The fresh-bootstrap layout receipt is malformed.");
  for (const value of [
    ...(layout.phase === "stage-owned" || layout.phase === "stage-ready"
      ? [layout.stageIdentity]
      : []),
    ...(layout.phase === "published" ? [layout.destinationIdentity] : []),
    ...(layout.phase === "published" && layout.swappedOldIdentity !== undefined
      ? [layout.swappedOldIdentity]
      : []),
  ])
    assertExactPathIdentity(value, "layout");
}

function assertExactPathIdentity(value: PathIdentity, label: string): void {
  if (!isPathIdentity(value))
    throw new Error(`The fresh-bootstrap ${label} identity is malformed.`);
}

export function exactFreshBootstrapProposalMatch(
  left: FreshBootstrapProposal,
  right: FreshBootstrapProposal,
): boolean {
  return (
    left.digest === right.digest &&
    JSON.stringify(canonicalProposal(left)) ===
      JSON.stringify(canonicalProposal(right))
  );
}
