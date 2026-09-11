import { z } from "zod";

export const freshBootstrapDigest = z.string().regex(/^[0-9a-f]{64}$/u);
const sha1 = z.string().regex(/^[0-9a-f]{40}$/u);
const pathIdentity = z.strictObject({
  device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^\d+$/u),
  mode: z.string().regex(/^[0-7]{3,4}$/u),
  nlink: z.string().regex(/^\d+$/u),
  path: z.string().startsWith("/"),
  uid: z.string().regex(/^\d+$/u),
});
const executableIdentity = pathIdentity.extend({
  sha256: freshBootstrapDigest,
});
const capability = z.strictObject({
  allowedRoot: pathIdentity,
  lockHelper: z.string().startsWith("/"),
  lockHelperIdentity: executableIdentity,
  lockStrategy: z.enum(["flock", "lockf"]),
  stateRoot: pathIdentity,
  systemGit: z.string().startsWith("/"),
  systemGitIdentity: executableIdentity,
  systemNode: z.string().startsWith("/"),
  systemNodeIdentity: executableIdentity,
  systemPython: z.string().startsWith("/"),
  systemPythonIdentity: executableIdentity,
});
const prestate = z.discriminatedUnion("kind", [
  z.strictObject({
    destinationPath: z.string().startsWith("/"),
    kind: z.literal("absent"),
    parent: pathIdentity,
  }),
  z.strictObject({
    destination: pathIdentity,
    kind: z.literal("empty-directory"),
    parent: pathIdentity,
  }),
]);

export const freshBootstrapProposalSchema = z.strictObject({
  appSpecDigest: freshBootstrapDigest,
  appSpecPath: z.string().min(1),
  applyDigest: freshBootstrapDigest,
  atomicAdapterDigest: freshBootstrapDigest,
  capability,
  changeSetDigest: freshBootstrapDigest,
  claimMarkerName: z.literal(".repository-bootstrap-claim"),
  contractDigest: freshBootstrapDigest,
  destinationLockDigest: freshBootstrapDigest,
  destinationPath: z.string().startsWith("/"),
  destinationPrestate: prestate,
  digest: freshBootstrapDigest,
  exactTree: z.array(
    z.strictObject({
      path: z.string().min(1),
      mode: z.enum(["100644", "100755"]),
      blob: sha1,
    })
  ),
  exactTreeDigest: freshBootstrapDigest,
  expectedGitTree: sha1,
  expectedInitialCommit: sha1,
  githubOutcome: z.literal("unavailable"),
  intendedOutcome: z.literal("bootstrap-fresh-local-repository"),
  journalPath: z.string().startsWith("/"),
  lockPath: z.string().startsWith("/"),
  materializeAdapterDigest: freshBootstrapDigest,
  publicationIdentityDigest: freshBootstrapDigest,
  releaseEnabled: z.literal(false),
  repositoryIdentity: z.strictObject({
    initialBranch: z.string().min(1),
    authorName: z.string().min(1),
    // Keep the transport schema within the JSON Schema subset accepted by
    // AI Gateway providers. The stricter Git identity check runs when the
    // proposal is executed (commitActor), rather than relying on a provider
    // to interpret an email regex with lookaround.
    authorEmail: z.string().min(3).max(320),
    commitMessage: z.string().min(1),
    commitTimestamp: z.string().datetime({ offset: true }),
  }),
  reviewDigest: freshBootstrapDigest,
  sourceReceiptDigest: freshBootstrapDigest,
  sourceSha: sha1,
  sourceTree: sha1,
  stagingPath: z.string().startsWith("/"),
  validationDigest: freshBootstrapDigest,
  version: z.literal(3),
});

export const freshBootstrapIdentitySchema = z.strictObject({
  initialBranch: z.string().min(1),
  authorName: z.string().min(1),
  // Provider-compatible shape; commitActor performs the authoritative check.
  authorEmail: z.string().min(3).max(320),
  commitMessage: z.string().min(1),
  commitTimestamp: z.string().datetime({ offset: true }),
});
