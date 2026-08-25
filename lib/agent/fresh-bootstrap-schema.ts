import { z } from "zod";

export const freshBootstrapDigest = z.string().regex(/^[0-9a-f]{64}$/u);
const sha1 = z.string().regex(/^[0-9a-f]{40}$/u);
const pathIdentity = z.strictObject({
  path: z.string().startsWith("/"),
  device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^\d+$/u),
  uid: z.string().regex(/^\d+$/u),
  mode: z.string().regex(/^[0-7]{3,4}$/u),
  nlink: z.string().regex(/^\d+$/u),
});
const executableIdentity = pathIdentity.extend({
  sha256: freshBootstrapDigest,
});
const capability = z.strictObject({
  stateRoot: pathIdentity,
  allowedRoot: pathIdentity,
  systemGit: z.string().startsWith("/"),
  systemPython: z.string().startsWith("/"),
  systemGitIdentity: executableIdentity,
  systemPythonIdentity: executableIdentity,
  systemNode: z.string().startsWith("/"),
  systemNodeIdentity: executableIdentity,
  lockStrategy: z.enum(["flock", "lockf"]),
  lockHelper: z.string().startsWith("/"),
  lockHelperIdentity: executableIdentity,
});
const prestate = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("absent"),
    destinationPath: z.string().startsWith("/"),
    parent: pathIdentity,
  }),
  z.strictObject({
    kind: z.literal("empty-directory"),
    destination: pathIdentity,
    parent: pathIdentity,
  }),
]);

export const freshBootstrapProposalSchema = z.strictObject({
  version: z.literal(3),
  capability,
  destinationPath: z.string().startsWith("/"),
  stagingPath: z.string().startsWith("/"),
  journalPath: z.string().startsWith("/"),
  lockPath: z.string().startsWith("/"),
  destinationLockDigest: freshBootstrapDigest,
  claimMarkerName: z.literal(".repository-bootstrap-claim"),
  atomicAdapterDigest: freshBootstrapDigest,
  materializeAdapterDigest: freshBootstrapDigest,
  destinationPrestate: prestate,
  sourceReceiptDigest: freshBootstrapDigest,
  sourceSha: sha1,
  sourceTree: sha1,
  contractDigest: freshBootstrapDigest,
  reviewDigest: freshBootstrapDigest,
  changeSetDigest: freshBootstrapDigest,
  appSpecDigest: freshBootstrapDigest,
  appSpecPath: z.string().min(1),
  applyDigest: freshBootstrapDigest,
  validationDigest: freshBootstrapDigest,
  repositoryIdentity: z.strictObject({
    initialBranch: z.string().min(1),
    authorName: z.string().min(1),
    authorEmail: z.string().email(),
    commitMessage: z.string().min(1),
    commitTimestamp: z.string().datetime({ offset: true }),
  }),
  exactTree: z.array(
    z.strictObject({
      path: z.string().min(1),
      mode: z.enum(["100644", "100755"]),
      blob: sha1,
    }),
  ),
  exactTreeDigest: freshBootstrapDigest,
  expectedGitTree: sha1,
  expectedInitialCommit: sha1,
  publicationIdentityDigest: freshBootstrapDigest,
  intendedOutcome: z.literal("bootstrap-fresh-local-repository"),
  githubOutcome: z.literal("unavailable"),
  releaseEnabled: z.literal(false),
  digest: freshBootstrapDigest,
});

export const freshBootstrapIdentitySchema = z.strictObject({
  initialBranch: z.string().min(1),
  authorName: z.string().min(1),
  authorEmail: z.string().email(),
  commitMessage: z.string().min(1),
  commitTimestamp: z.string().datetime({ offset: true }),
});
