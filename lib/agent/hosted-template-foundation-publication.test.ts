/* oxlint-disable sonarjs/no-internal-api-use -- The real Eve state container retains the same Build grant and recovery history. */
/* oxlint-disable eslint/require-await -- Filesystem-backed Sandbox ports preserve their asynchronous production signatures. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeSandboxSession } from "eve/sandbox";
import { describe, expect, it, vi } from "vitest";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy only on fixture capability selection while retaining the actual current-source observation and content pipeline.
import * as testCapability from "../testing/test-capability";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { observeNormalizedChangeSet } from "../../agent/tools/change_set_status";
import { initialDraftCandidatePaths } from "../../agent/tools/prepare_github_draft_review";
import { planningSourceReconciliationProgram } from "../repository/planning-source-reconciliation";
import { inspectCanonicalTemplateSnapshotReceipt } from "../repository/source-receipt";
import type { SourceReceipt } from "../repository/source-receipt";
import {
  inspectApplyOverlay,
  overlayChanges,
  targetApplyCommandReceiptSchema,
} from "../repository/target-apply";
import type { TargetApplyReceipt } from "../repository/target-apply";
import {
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  validationBinding,
} from "../repository/target-validation";
import type { TargetValidationReceipt } from "../repository/target-validation";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import { targetCreationProposalSchema, targetIdentitySchema } from "../repository/target-planning";
import {
  createReviewedChangeSetReceipt,
  deriveNormalizedChangeSet,
} from "../repository/reviewed-change-set";
import {
  createDraftPullRequestProposal,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  readExactGitHubPublicationContent,
} from "../repository/github-publication";
import { createGitHubDestinationReviewBinding } from "../repository/github-destination-review";
import { recoverHostedTemplateFoundation } from "./hosted-template-foundation-recovery";
import { resolveHostedTemplateFoundationBinding } from "./hosted-template-foundation-binding";
import { assertProposalExecutionBindings } from "./target-execution";
import {
  assertApprovedPrivateApplySession,
  readPrivateApplyAuthority,
  recordApprovedPrivateApply,
  requestPrivateApplyApproval,
} from "./private-apply-authority";
import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "./source-state";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState, DependencyPreparationReceipt } from "./workflow-state";
import { publicationContentSourceForReviewedWorkflow } from "./github-publication-content-source";

const appId = "notebook";
const sessionId = "same-notebook-session";
const virtualRoot = "/workspace/repository";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const signed = <T extends object>(value: T) => ({ ...value, digest: hash(JSON.stringify(value)) });
const digest = hash("controlled-platform-fixture");
const specPath = ".config/app-specs/notebook.cue";
const appPath = "apps/notebook/app/page.tsx";
const registryPath = "microfrontends.json";
interface FixtureApplications {
  baseline: { path: string };
  notebook?: { path: string };
}
const registry = (framework: string, includeApp: boolean) => {
  const applications: FixtureApplications = {
    baseline: { path: "/baseline" },
  };
  if (includeApp) {
    applications.notebook = { path: "/notebook" };
  }
  return `${JSON.stringify(
    {
      framework: { revision: framework },
      padding: { one: true, two: true, three: true },
      applications,
    },
    null,
    2,
  )}\n`;
};
const unavailable = (): never => {
  throw new Error("Unexpected publication fixture operation");
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const installation = (operation: "resolve-existing-source" | "publish-draft-pull-request") =>
  createGitHubInstallationIdentity({
    accountId: "20",
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId: "10",
    operation,
    repositorySelection: "selected",
    selectedRepositoryIds: ["100"],
  });
const repository = (authority: ReturnType<typeof installation>, source: SourceReceipt) =>
  createRepositoryObservation({
    defaultBranch: "main",
    headSha: source.sourceSha,
    headTree: source.sourceTree,
    installationIdentityDigest: authority.digest,
    name: "arrusted-development",
    owner: "withAutograph",
    releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
    repositoryId: "100",
    visibility: "private",
  });

const fixture = async () => {
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "foundation-publication-")));
  const root = path.join(temporary, "repository");
  mkdirSync(root);
  const environment = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_ENV: "test",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  } satisfies NodeJS.ProcessEnv;
  const git = (...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      { encoding: "utf-8", env: environment },
    ).trim();
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const source = () =>
    inspectCanonicalTemplateSnapshotReceipt({
      readinessDigest: digest,
      snapshot: {
        sourcePath: virtualRoot,
        sourceSha: git("rev-parse", "HEAD"),
        sourceTree: git("rev-parse", "HEAD^{tree}"),
        contents: {},
        contract: [],
        dirtyPaths: [],
      },
    });
  const translate = (file: string) =>
    path.join(root, file.replace(/^\/workspace\/repository\/?|^repository\//u, ""));
  const read = (file: string) => {
    try {
      return readFileSync(translate(file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };
  const sandbox: RuntimeSandboxSession = {
    delete: unavailable,
    stop: unavailable,
    run: async (input) => {
      // Repository snapshots use portable Node APIs. Execute their actual
      // program with this fixture's pinned Node rather than ambient Bun.
      const command = input.command.replace(/^bun(?= )/u, quote(process.execPath));
      const result = spawnSync("/bin/sh", ["-c", command], {
        cwd: translate(input.workingDirectory ?? virtualRoot),
        encoding: "utf-8",
        env: environment,
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    readBinaryFile: async ({ path: file }) => read(file),
    readTextFile: async ({ path: file }) => read(file)?.toString("utf-8") ?? null,
    resolvePath: translate,
    readFile: unavailable,
    removePath: unavailable,
    spawn: unavailable,
    writeBinaryFile: unavailable,
    writeFile: unavailable,
    writeTextFile: unavailable,
  };
  git("init", "--quiet");
  git("config", "user.name", "Publication Fixture");
  git("config", "user.email", "fixture@example.test");
  write(registryPath, registry("original", false));
  git("add", ".");
  git("commit", "--quiet", "-m", "original shared registry");
  const originalSource = source();
  const before = await inspectApplyOverlay(sandbox, virtualRoot);
  write(registryPath, registry("current", false));
  git("add", ".");
  git("commit", "--quiet", "-m", "independent canonical registry edit");
  const currentSource = source();
  git("checkout", "--quiet", "--detach", originalSource.sourceSha);
  write(registryPath, registry("original", true));
  write(appPath, 'export default "same accepted notebook";\n');
  write(specPath, 'app: "notebook"\n');
  const applied = await inspectApplyOverlay(sandbox, virtualRoot);
  const workspace = (receipt: SourceReceipt): PreparedSandboxWorkspace => ({
    adapter: receipt.adapter,
    eligibilityDigest: receipt.eligibilityDigest,
    sourcePath: virtualRoot,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    workspaceDigest: hash(
      JSON.stringify({ sourceSha: receipt.sourceSha, sourceTree: receipt.sourceTree }),
    ),
    workspaceId: "same-notebook-workspace",
    workspacePath: virtualRoot,
  });
  return {
    sandbox,
    originalSource,
    currentSource,
    before,
    applied,
    workspace,
    read: (file: string) => readFileSync(path.join(root, file), "utf-8"),
    checkCurrent: () => {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const registry = JSON.parse(fs.readFileSync("microfrontends.json", "utf8"));
        assert.equal(registry.framework.revision, "current");
        assert.equal(registry.applications.notebook.path, "/notebook");
        assert.equal(fs.readFileSync("apps/notebook/app/page.tsx", "utf8"), 'export default "same accepted notebook";\\n');
      `,
        ],
        { cwd: root, encoding: "utf-8", env: environment },
      );
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    reconcile: async () => {
      const checkpointRef = `refs/app-builder/source-checkpoints/${hash(sessionId)}`;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          planningSourceReconciliationProgram,
          JSON.stringify({
            root,
            stateRoot: path.join(temporary, "transition"),
            sessionId,
            appId,
            targetSha: currentSource.sourceSha,
            checkpointRef,
            fetchRemote: false,
          }),
        ],
        { cwd: root, encoding: "utf-8", env: environment },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr);
      }
      return {
        changed: true,
        sourceReceipt: currentSource,
        workspace: workspace(currentSource),
        provenance: {
          previousSourceReceiptDigest: originalSource.digest,
          previousWorkspaceDigest: workspace(originalSource).workspaceDigest,
          previousSourceSha: originalSource.sourceSha,
          sourceSha: currentSource.sourceSha,
          sourceTree: currentSource.sourceTree,
          sourceSnapshotTree: currentSource.sourceTree,
          checkpointRef,
        },
      };
    },
    dispose: () => {
      rmSync(temporary, { force: true, recursive: true });
    },
  };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
const originalWorkflow = (f: Fixture) => {
  const workspace = f.workspace(f.originalSource);
  const execution = {
    sourceSha: f.originalSource.sourceSha,
    sourceTree: f.originalSource.sourceTree,
    sourceReceiptDigest: f.originalSource.digest,
    eligibilityDigest: workspace.eligibilityDigest,
    workspaceDigest: workspace.workspaceDigest,
    imageDigest: digest,
    dependencyCacheDigest: digest,
    appSpecDigest: hash('app: "notebook"\n'),
    artifactRevision: "accepted-notebook",
  };
  const identity = targetIdentitySchema.parse({
    appId,
    appSpecPath: specPath,
    appSpecSourcePath: specPath,
    baseRoutes: ["/notebook"],
    cueSourcePath: specPath,
    packageName: "@fixture/notebook",
    projectName: appId,
    schemaCuePath: "apps/notebook/schema/index.cue",
    title: "Notebook",
    workspacePath: "apps/notebook",
  });
  const identityReceipt = signed({
    ...execution,
    version: 1 as const,
    identity,
    resolvedByCallId: "identity",
  });
  const dependencyLayout: DependencyPreparationReceipt["dependencyLayout"] = {
    kind: "fixture",
    roots: [],
    workspaceLinks: [],
    version: 1,
  };
  const dependencyReceipt = signed({
    ...execution,
    version: 2 as const,
    targetSha: execution.sourceSha,
    targetTree: execution.sourceTree,
    cacheManifestDigest: digest,
    cacheContentDigest: digest,
    dependencyLayout,
    preparedByCallId: "dependencies",
  });
  const proposal = signed({
    ...execution,
    version: 1 as const,
    contractDigest: f.originalSource.contractDigest,
    identityDigest: identityReceipt.digest,
    plannedByCallId: "original-plan",
    target: targetCreationProposalSchema.parse({
      blockers: [],
      mutations: [],
      contract: { appId, appSpec: { path: specPath, sha256: execution.appSpecDigest }, version: 1 },
      plan: {
        product: { appSpec: { path: specPath, sha256: execution.appSpecDigest } },
        source: {
          packageName: "@fixture/notebook",
          runtime: "nextjs",
          schema: { kind: "none" },
          workspacePath: "apps/notebook",
        },
        topology: {
          configPath: registryPath,
          packageName: "@fixture/notebook",
          projectName: appId,
          routes: ["/notebook"],
        },
      },
    }),
  });
  const changes = overlayChanges(f.before, f.applied);
  const applyReceipt: TargetApplyReceipt = signed({
    ...execution,
    version: 2 as const,
    status: "applied" as const,
    appSpecPath: specPath,
    dependencyReceiptDigest: dependencyReceipt.digest,
    identityDigest: identityReceipt.digest,
    dependencyCacheContentDigest: digest,
    proposalDigest: proposal.digest,
    applyRoot: virtualRoot,
    appliedByCallId: "original-apply",
    planningTreeDigest: digest,
    preparedTreeDigest: digest,
    preTree: f.before.files,
    preTreeDigest: f.before.treeDigest,
    postTree: f.applied.files,
    postTreeDigest: f.applied.treeDigest,
    changes,
    changedContentDigest: hash(JSON.stringify(changes)),
    command: {
      name: "create-app" as const,
      exitCode: 0,
      stdoutDigest: digest,
      stderrDigest: digest,
    },
    targetReceipt: targetApplyCommandReceiptSchema.parse({
      version: 1,
      appId,
      workspacePath: "apps/notebook",
      mutations: ["apps/notebook", registryPath],
      omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
      recovered: false,
      topology: {
        path: registryPath,
        oldDigest: hash(registry("original", false)),
        newDigest: hash(registry("original", true)),
      },
    }),
  });
  const validationReceipt: TargetValidationReceipt = signed({
    ...validationBinding(applyReceipt),
    version: 3 as const,
    status: "passed" as const,
    attemptDigest: digest,
    validatedByCallId: "original-validation",
    commands: [],
  });
  const reviewReceipt = createReviewedChangeSetReceipt(
    deriveNormalizedChangeSet(applyReceipt, validationReceipt, proposal.contractDigest),
    "original-review",
  );
  const authority = installation("publish-draft-pull-request");
  const oldSeal = createDraftPullRequestProposal({
    installation: authority,
    repository: repository(authority, f.originalSource),
    review: reviewReceipt,
    changedPathsSinceBase: [],
    title: "Original notebook draft",
  });
  const state = {
    version: APP_BUILDER_WORKFLOW_VERSION,
    phase: "reviewed" as const,
    appSpec: {
      appId,
      digest: execution.appSpecDigest,
      artifactPath: specPath,
      artifactRevision: execution.artifactRevision,
      acceptedByCallId: "accept-product",
    },
    sourceReceipt: f.originalSource,
    workspace,
    dependencyReceipt,
    identityReceipt,
    proposal,
    applyReceipt,
    validationReceipt,
    reviewReceipt,
    githubDraftProposal: {
      proposal: oldSeal,
      sourceReceiptDigest: f.originalSource.digest,
      destinationReviewDigest: digest,
    },
    artifacts: [],
    preparedByCallId: "prepare",
  } satisfies Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
  return { state, oldSeal };
};

describe("publication after retained template foundation recovery", () => {
  it("reviews and captures combined canonical registration and the original app under a new approval subject", async () => {
    const f = await fixture();
    const simulated = vi.spyOn(testCapability, "hasTestCapability").mockReturnValue(false);
    try {
      await contextStorage.run(new ContextContainer(), async () => {
        const { state: original, oldSeal } = originalWorkflow(f);
        appBuilderWorkflowState.update(() => original);
        sourceWorkflowState.update(() => ({
          version: APP_BUILDER_SOURCE_VERSION,
          phase: "reviewed",
          receipt: original.sourceReceipt,
        }));
        const scope = {
          appId,
          appSpecDigest: original.appSpec.digest,
          proposalDigest: original.proposal.digest,
          workspaceId: original.workspace.workspaceId,
          sessionId,
        };
        requestPrivateApplyApproval(scope, "original-build");
        recordApprovedPrivateApply(scope, "original-build");
        const grant = readPrivateApplyAuthority();
        expect(
          await recoverHostedTemplateFoundation(
            {
              callId: "recover-local-failure",
              session: { id: sessionId },
              getSandbox: async () => f.sandbox,
            },
            { appId, root: virtualRoot },
            f.reconcile,
          ),
        ).toBe(true);
        const recovered = appBuilderWorkflowState.get();
        if (recovered.phase !== "applied") {
          throw new Error("Expected the original applied app after recovery");
        }
        expect(f.read(registryPath)).toBe(registry("current", true));
        expect(f.read(appPath)).toBe('export default "same accepted notebook";\n');
        expect(recovered.proposal).toEqual(original.proposal);
        expect(recovered.applyReceipt).toEqual(original.applyReceipt);
        expect(readPrivateApplyAuthority()).toEqual(grant);
        assertApprovedPrivateApplySession(scope);
        expect(recovered).not.toHaveProperty("githubDraftProposal");

        assertProposalExecutionBindings(recovered, sessionId);
        const foundation = resolveHostedTemplateFoundationBinding(recovered, sessionId);
        if (foundation === undefined) {
          throw new Error("Expected completed owned recovery provenance");
        }
        const attempt = createTargetValidationAttempt(
          recovered.applyReceipt,
          "after-foundation-validation",
          ["1/1"],
          foundation.executionFoundation,
        );
        const validation = await executeProposalBoundValidation({
          appId,
          apply: recovered.applyReceipt,
          attempt,
          sandbox: f.sandbox,
          executor: async () => f.checkCurrent(),
        });
        if (!validation.ok) {
          throw new Error("The recovered registration and app must pass their controlled commands");
        }
        const validationReceipt = validation.receipt;
        let validated: Extract<AppBuilderWorkflowState, { phase: "validated" }> = {
          ...recovered,
          phase: "validated",
          validationReceipt,
        };
        appBuilderWorkflowState.update(() => validated);
        const initial = await observeNormalizedChangeSet({ state: validated, sandbox: f.sandbox });
        const paths = await initialDraftCandidatePaths(
          {
            state: validated,
            sandbox: f.sandbox,
            ...initial,
            reviewedPaths: initial.changeSet.approvedPaths,
          },
          async () =>
            f.before.files.map(({ path: file, digest: sha256, mode }) => ({
              path: file,
              sha256: file === registryPath ? hash(registry("current", false)) : sha256,
              mode: mode === "755" ? ("100755" as const) : ("100644" as const),
              objectId: "a".repeat(40),
            })),
        );
        const readAuthority = installation("resolve-existing-source");
        const canonicalRegistration = {
          path: registryPath,
          mode: "644",
          digest: hash(registry("current", false)),
        };
        const destination = createGitHubDestinationReviewBinding({
          applyDigest: original.applyReceipt.digest,
          validationDigest: validationReceipt.digest,
          postTreeDigest: initial.changeSet.postTreeDigest,
          candidatePaths: paths.candidatePaths,
          preTree: [canonicalRegistration],
          installation: readAuthority,
          repository: repository(readAuthority, f.currentSource),
        });
        validated = { ...validated, githubDestinationReview: destination };
        const { changeSet } = await observeNormalizedChangeSet({
          state: validated,
          sandbox: f.sandbox,
        });
        const review = createReviewedChangeSetReceipt(changeSet, "review-current-registration");
        expect(review.sourceReceiptDigest).toBe(f.currentSource.digest);
        expect(review.sourceSha).toBe(f.currentSource.sourceSha);
        expect(review.workspaceDigest).toBe(recovered.workspace.workspaceDigest);
        const publicationAuthority = installation("publish-draft-pull-request");
        const proposal = createDraftPullRequestProposal({
          installation: publicationAuthority,
          repository: repository(publicationAuthority, f.currentSource),
          review,
          changedPathsSinceBase: [],
          title: "Notebook on the recovered foundation",
        });
        const reviewed = {
          ...validated,
          phase: "reviewed" as const,
          reviewReceipt: review,
          githubDraftProposal: {
            proposal,
            destinationReviewDigest: destination.digest,
            sourceReceiptDigest: recovered.sourceReceipt.digest,
          },
        };
        const content = await readExactGitHubPublicationContent({
          proposal,
          review,
          source: publicationContentSourceForReviewedWorkflow({
            state: reviewed,
            sandbox: f.sandbox,
          }),
        });
        const captured = content.changes.find(({ path: file }) => file === registryPath);
        if (captured?.kind !== "modified") {
          throw new Error("The app registration must be reviewed against current canonical bytes");
        }
        expect(captured.before.digest).toBe(hash(registry("current", false)));
        expect(captured.after.digest).toBe(hash(registry("current", true)));
        expect(Buffer.from(captured.after.bytes).toString("utf-8")).toBe(registry("current", true));
        const app = content.changes.find(({ path: file }) => file === appPath);
        if (app?.kind !== "added") {
          throw new Error("The original accepted app must remain publishable");
        }
        expect(Buffer.from(app.after.bytes).toString("utf-8")).toBe(f.read(appPath));
        expect(proposal.digest).not.toBe(oldSeal.digest);
        await expect(
          readExactGitHubPublicationContent({
            proposal: oldSeal,
            review,
            source: publicationContentSourceForReviewedWorkflow({
              state: reviewed,
              sandbox: f.sandbox,
            }),
          }),
        ).rejects.toThrow();
        expect(original.applyReceipt.targetReceipt.topology.newDigest).toBe(
          hash(registry("original", true)),
        );
        expect(recovered.applyReceipt).toEqual(original.applyReceipt);
        expect(readPrivateApplyAuthority()).toEqual(grant);
      });
    } finally {
      simulated.mockRestore();
      f.dispose();
    }
  });
});
