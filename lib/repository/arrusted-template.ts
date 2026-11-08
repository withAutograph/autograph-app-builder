import { z } from "zod";
import {
  getBuilderSandboxId,
  materializeBuilderSandboxGitSource,
} from "../sandbox/builder-sandbox";
import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";

import { canAutoSelectDevelopmentSource } from "./development-source";

import {
  ARRUSTED_TEMPLATE_REF,
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectCanonicalTemplateSnapshotReceipt,
  parseSourceReceipt,
  SOURCE_RECEIPT_VERSION,
} from "./source-receipt";
import type { SourceReceipt } from "./source-receipt";
import {
  inspectPreparedSandboxWorkspace,
  readPreparedSandboxWorkspaceRecord,
  recordPreparedSandboxWorkspace,
  samePreparedWorkspaceSourceContext,
} from "./supported-template";
import type { PreparedSandboxWorkspace } from "./supported-template";
import { deploymentArrustedTemplateReader } from "./arrusted-template-reader";
import type { ArrustedTemplateReader } from "./arrusted-template-reader";
import {
  inspectGitHubSourceSandboxWorkspace,
  readSandboxGitHubSourceSnapshot,
} from "./sandbox-github-source";
import type { ImmutableGitHubSourceReceipt } from "./github-publication";
import { configureVercelSessionGitSource } from "../sandbox/vercel-session-source";

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SANDBOX_WORKSPACE = "/workspace/repository";

export { ARRUSTED_TEMPLATE_REF, ARRUSTED_TEMPLATE_REPOSITORY } from "./source-receipt";

type ClonedTemplateReceipt = Extract<SourceReceipt, { version: 4 }>;

type TemplateAcquisitionFailureStage = "reader" | "sandbox_clone" | "workspace_record";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function acquisitionStage<T>(
  stage: TemplateAcquisitionFailureStage,
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "autograph.template-acquisition.failed",
        stage,
      }),
    );
    throw error;
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function receiptReadinessDigest(
  input: Pick<
    Awaited<ReturnType<typeof readSandboxGitHubSourceSnapshot>>,
    "sourceSha" | "sourceTree"
  >,
) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** New acquisitions only: independently bind the actual checkout to its cloned canonical main ref. */
export const canonicalMainAcquisitionProofProgram = (root = SANDBOX_WORKSPACE) => `
/* canonical-main-acquisition-proof-v1 */
const {execFileSync}=require('node:child_process');
try {
 const root=${JSON.stringify(root)};
 const read=(args)=>execFileSync('git',['--no-replace-objects','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const sourceSha=read(['rev-parse','--verify','HEAD']);
 const sourceTree=read(['rev-parse','--verify','HEAD^{tree}']);
 const mainSha=read(['rev-parse','--verify','refs/remotes/origin/main']);
 const mainTree=read(['rev-parse','--verify','refs/remotes/origin/main^{tree}']);
 const origin=new URL(read(['remote','get-url','origin']));
 const expected=new URL(${JSON.stringify(ARRUSTED_TEMPLATE_REPOSITORY)});
 const originMatches=origin.origin===expected.origin && origin.pathname.replace(/\\.git$/,'')===expected.pathname.replace(/\\.git$/,'') && origin.username==='' && origin.password==='' && origin.search==='' && origin.hash==='';
 if(!originMatches || !/^[0-9a-f]{40}$/.test(sourceSha) || !/^[0-9a-f]{40}$/.test(sourceTree) || sourceSha!==mainSha || sourceTree!==mainTree) process.exit(2);
 process.stdout.write(JSON.stringify({sourceSha,sourceTree,mainSha,mainTree,originMatches}));
} catch { process.exit(2); }
`;
const quoteAcquisitionProgram = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const fail = () =>
  new Error(
    "Fresh canonical source must match the observed origin/main commit and tree. Preserve this checkout and select a new source acquisition; no saved receipt was changed.",
  );
const assertNewCanonicalMain = async (
  sandbox: SandboxSession,
  snapshot: { sourceSha: string; sourceTree: string },
) => {
  const result = await sandbox.run({
    command: `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/dev/null XDG_CONFIG_HOME=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 node -e ${quoteAcquisitionProgram(canonicalMainAcquisitionProofProgram())}`,
    workingDirectory: "/workspace",
  });
  if (result.exitCode !== 0) throw fail();
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw fail();
  }
  const proof = z
    .strictObject({
      sourceSha: z.string().regex(SHA),
      sourceTree: z.string().regex(SHA),
      mainSha: z.string().regex(SHA),
      mainTree: z.string().regex(SHA),
      originMatches: z.literal(true),
    })
    .safeParse(raw);
  if (!proof.success) throw fail();
  if (
    proof.data.sourceSha !== snapshot.sourceSha ||
    proof.data.sourceTree !== snapshot.sourceTree ||
    proof.data.sourceSha !== proof.data.mainSha ||
    proof.data.sourceTree !== proof.data.mainTree
  )
    throw fail();
};

/**
 * The fresh-template transport: exactly one detached clone, directly in the
 * session workspace. Its closed inspection snapshot produces the V4 receipt
 * and the same checkout is sealed for later target commands.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function acquireCanonicalArrustedTemplate(input: {
  sandbox: SandboxSession | (() => Promise<SandboxSession>);
  sessionId?: string;
  callId: string;
  reader?: ArrustedTemplateReader;
}): Promise<SourceReceipt> {
  const reader = input.reader ?? deploymentArrustedTemplateReader();
  const access = await acquisitionStage("reader", () => reader.acquire());
  if (typeof input.sandbox === "function") {
    if (input.sessionId === undefined) {
      throw new Error("The App Builder session is unavailable.");
    }
    configureVercelSessionGitSource({
      sessionId: input.sessionId,
      source: { token: access.token, url: ARRUSTED_TEMPLATE_REPOSITORY, revision: "main" },
    });
  }
  const sandbox = typeof input.sandbox === "function" ? await input.sandbox() : input.sandbox;
  const snapshot = await acquisitionStage("sandbox_clone", () =>
    readSandboxGitHubSourceSnapshot(sandbox, { repository: ARRUSTED_TEMPLATE_REPOSITORY }, () =>
      materializeBuilderSandboxGitSource(sandbox, {
        token: access.token,
        url: ARRUSTED_TEMPLATE_REPOSITORY,
        revision: "main",
      }),
    ),
  );
  await acquisitionStage("sandbox_clone", () => assertNewCanonicalMain(sandbox, snapshot));
  const workspaceDigest = receiptReadinessDigest({
    sourceSha: snapshot.sourceSha,
    sourceTree: snapshot.sourceTree,
  });
  const receipt = inspectCanonicalTemplateSnapshotReceipt({
    readinessDigest: workspaceDigest,
    snapshot,
  });
  await acquisitionStage("workspace_record", () =>
    recordPreparedSandboxWorkspace({
      callId: input.callId,
      eligibilityDigest: receipt.eligibilityDigest,
      sandbox,
      sourcePath: SANDBOX_WORKSPACE,
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      workspaceDigest,
    }),
  );
  return receipt;
}

/** Re-inspect the already-cloned workspace without fetching or cloning. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function inspectCanonicalArrustedSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: ClonedTemplateReceipt;
}) {
  let receipt: ClonedTemplateReceipt;
  try {
    const parsed = parseSourceReceipt(input.receipt);
    if (parsed.version !== 4) {
      throw new Error("not a cloned receipt");
    }
    receipt = parsed;
  } catch (error) {
    throw new Error("Canonical Arrusted clone receipt is invalid.", {
      cause: error,
    });
  }
  const invalidSourceIdentity =
    receipt.sourcePath !== SANDBOX_WORKSPACE ||
    receipt.provenance.repository !== ARRUSTED_TEMPLATE_REPOSITORY ||
    receipt.provenance.ref !== ARRUSTED_TEMPLATE_REF;
  const invalidSourceCommit =
    !invalidSourceIdentity && (!SHA.test(receipt.sourceSha) || !SHA.test(receipt.sourceTree));
  if (
    invalidSourceIdentity ||
    invalidSourceCommit ||
    !DIGEST.test(receipt.eligibilityDigest) ||
    !DIGEST.test(receipt.provenance.readinessDigest)
  ) {
    throw new Error("Canonical Arrusted clone receipt is invalid.");
  }
  const observed = await readPreparedSandboxWorkspaceRecord(input.sandbox);
  if (observed === undefined) {
    throw new Error("The canonical Arrusted workspace is missing.");
  }
  const workspaceMismatch =
    observed.workspaceId !== getBuilderSandboxId(input.sandbox) ||
    observed.sourcePath !== SANDBOX_WORKSPACE;
  if (
    workspaceMismatch ||
    observed.sourceSha !== receipt.sourceSha ||
    observed.sourceTree !== receipt.sourceTree ||
    observed.eligibilityDigest !== receipt.eligibilityDigest
  ) {
    throw new Error("The canonical Arrusted workspace drifted.");
  }
  return observed;
}

/**
 * Re-inspect the active source workspace. Development uses the writable live
 * workspace as current planning input; hosted release adapters retain their
 * closed receipt checks until the moving-source policy reaches those paths.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function inspectSourceBoundSandboxWorkspace(input: {
  sandbox: SandboxSession;
  receipt: SourceReceipt;
  expectedWorkspace?: PreparedSandboxWorkspace;
  githubSource?: ImmutableGitHubSourceReceipt;
}): Promise<PreparedSandboxWorkspace> {
  if (canAutoSelectDevelopmentSource()) {
    const status = await inspectPreparedSandboxWorkspace(input.sandbox, "development-live");
    if (status.state !== "prepared") {
      throw new Error("The prepared development workspace is missing.");
    }
    const observed = status.workspace;
    if (observed.workspaceId !== getBuilderSandboxId(input.sandbox)) {
      throw new Error("The prepared development workspace does not match the active workflow.");
    }
    return observed;
  }
  if (input.githubSource !== undefined) {
    // The selected repository stays bound to this session, while its checkout
    // is normal writable planning input. Re-observe that checkout on every
    // call instead of comparing it with the source-selection snapshot.
    return await inspectGitHubSourceSandboxWorkspace({
      githubSource: input.githubSource,
      sandbox: input.sandbox,
    });
  }
  const receipt = parseSourceReceipt(input.receipt);
  let observed: PreparedSandboxWorkspace;
  if (receipt.version === SOURCE_RECEIPT_VERSION) {
    observed = await inspectCanonicalArrustedSandboxWorkspace({
      receipt,
      sandbox: input.sandbox,
    });
  } else {
    const status = await inspectPreparedSandboxWorkspace(input.sandbox, "legacy-live");
    if (status.state !== "prepared") {
      throw new Error("The prepared source workspace is missing.");
    }
    observed = status.workspace;
    const sourceMismatch =
      observed.workspaceId !== getBuilderSandboxId(input.sandbox) ||
      observed.sourcePath !== receipt.sourcePath ||
      observed.sourceSha !== receipt.sourceSha;
    if (
      sourceMismatch ||
      observed.sourceTree !== receipt.sourceTree ||
      (input.expectedWorkspace !== undefined &&
        !samePreparedWorkspaceSourceContext(observed, input.expectedWorkspace))
    ) {
      throw new Error("The prepared workspace no longer matches its durable source receipt.");
    }
    return observed;
  }
  const sourceMismatch =
    observed.workspaceId !== getBuilderSandboxId(input.sandbox) ||
    observed.sourcePath !== receipt.sourcePath ||
    observed.sourceSha !== receipt.sourceSha;
  const invalidSource =
    sourceMismatch ||
    observed.sourceTree !== receipt.sourceTree ||
    observed.eligibilityDigest !== receipt.eligibilityDigest;
  if (
    invalidSource ||
    (input.expectedWorkspace !== undefined &&
      JSON.stringify(observed) !== JSON.stringify(input.expectedWorkspace))
  ) {
    throw new Error("The prepared workspace no longer matches its durable source receipt.");
  }
  return observed;
}
