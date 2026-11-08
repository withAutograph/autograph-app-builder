/* oxlint-disable typescript/no-non-null-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Controlled test inputs supply exact consumed receipt/context fields; real state, authority, file operations and execution remain exercised. */
/* oxlint-disable eslint/require-await -- The local filesystem/process adapter implements SandboxSession's asynchronous external execution boundary. */
/* oxlint-disable sonarjs/no-internal-api-use -- Exercise installed Eve state and serialization only in this regression fixture. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeSandboxSession, SandboxEnvironment, SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  deserializeContext,
  serializeContext,
} from "../../node_modules/eve/dist/src/context/serialize.js";
import validateCreation from "../../agent/tools/validate_app_creation";
import editCandidate from "../../agent/tools/edit_github_draft_pr_candidate";
import sealCandidate from "../../agent/tools/seal_github_draft_pr_reconciliation";
import { appBuilderWorkflowState, APP_BUILDER_WORKFLOW_VERSION } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  draftReconciliationState,
  candidateValidationAttemptHistory,
} from "./draft-reconciliation-state";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import type { DraftReviewedWorkflow } from "./draft-reviewed-lineage";
import {
  createReviewedChangeSetReceipt,
  deriveNormalizedChangeSet,
} from "../repository/reviewed-change-set";
import { validationBinding } from "../repository/target-validation";
import { repositoryDeliveryBuildCommand } from "../repository/supported-template";
import type { TargetApplyReceipt } from "../repository/target-apply";
import { repositoryAccessReceiptState } from "./repository-access-state";
import { recordApprovedPrivateApply, requestPrivateApplyApproval } from "./private-apply-authority";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy only on the external artifact storage boundary while retaining the real validation composition.
import * as artifacts from "./compiled-operator-artifacts";
import { inspectDraftReconciliation } from "../repository/sandbox-draft-reconciliation";

const unexpectedSandboxOperation = (): never => {
  throw new Error("Unexpected sandbox operation in test fixture");
};
const sandboxDefaults = {
  delete: unexpectedSandboxOperation,
  readBinaryFile: unexpectedSandboxOperation,
  readFile: unexpectedSandboxOperation,
  readTextFile: unexpectedSandboxOperation,
  removePath: unexpectedSandboxOperation,
  resolvePath: unexpectedSandboxOperation,
  run: unexpectedSandboxOperation,
  spawn: unexpectedSandboxOperation,
  stop: unexpectedSandboxOperation,
  writeBinaryFile: unexpectedSandboxOperation,
  writeFile: unexpectedSandboxOperation,
  writeTextFile: unexpectedSandboxOperation,
} satisfies RuntimeSandboxSession;
const createSandbox = <T extends Partial<SandboxSession>>(
  overrides: T,
): RuntimeSandboxSession & T => ({
  ...sandboxDefaults,
  ...overrides,
});

const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const appPath = "apps/orchard/value.js";
const original = 'export const value = "original-native";\n';
const edited = 'export const value = "managed-public-keys";\n';
const install = "mise exec --no-deps -- bun install --frozen-lockfile";
const check = repositoryDeliveryBuildCommand("orchard", true);
const test = "mise run --no-deps --skip-deps --skip-tools app:test orchard 1/1";
const git = (cwd: string, ...args: string[]) =>
  // oxlint-disable-next-line sonarjs/no-os-command-from-path -- Fixed Git executable operates only in this owned temporary fixture.
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "builder-reviewed-lineage-")));
  roots.push(root);
  const repository = path.join(root, "repository");
  const candidateRoot = path.join(root, "candidate");
  mkdirSync(path.join(repository, "apps/orchard"), { recursive: true });
  writeFileSync(path.join(repository, appPath), original);
  writeFileSync(
    path.join(repository, "package.json"),
    JSON.stringify({ private: true, workspaces: ["apps/*"] }),
  );
  writeFileSync(
    path.join(repository, "apps/orchard/package.json"),
    JSON.stringify({ name: "orchard", scripts: { test: "vitest run" } }),
  );
  git(repository, "init", "--initial-branch=main");
  git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "add",
    ".",
  );
  git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "controlled original app",
  );
  git(root, "clone", repository, candidateRoot);
  const sha = git(repository, "rev-parse", "HEAD");
  const tree = git(repository, "rev-parse", "HEAD^{tree}");
  const stateRoot = path.join(root, "state");
  const runs = path.join(stateRoot, "runs");
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(runs, { mode: 0o700 });
  for (const [key, value] of Object.entries({
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    EVE_HOSTED_ADAPTER: "0",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    APP_BUILDER_DEV_RUNS_ROOT: runs,
  })) {
    vi.stubEnv(key, value);
  }
  const commands: { root: string; command: string }[] = [];
  let failure: "none" | "startup" | "interrupted" = "none";
  const sandbox = createSandbox({
    id: "owned-physical-session",
    async readTextFile(input: { path: string; abortSignal?: AbortSignal }) {
      input.abortSignal?.throwIfAborted();
      return readFileSync(
        path.isAbsolute(input.path) ? input.path : path.join(root, input.path),
        "utf-8",
      );
    },
    async writeTextFile(input: { path: string; content: string }) {
      writeFileSync(path.join(root, input.path), input.content);
    },
    async run(input: {
      command: string;
      workingDirectory?: string;
      env?: Record<string, string>;
      abortSignal?: AbortSignal;
    }) {
      input.abortSignal?.throwIfAborted();
      const cwd = input.workingDirectory === "/workspace" ? root : (input.workingDirectory ?? root);
      if (input.command.includes(" app:describe ")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            version: 1,
            app: { id: "orchard", workspacePath: "apps/orchard", routes: [] },
            backend: { kind: "static" },
            validation: {
              browser: null,
              check: { task: "check" },
              test: { task: "test", shards: 1 },
            },
          }),
        };
      }
      const technical =
        input.command.includes(check) || input.command.includes(" app:test orchard ");
      if (technical) {
        commands.push({ command: input.command, root: cwd });
        if (failure === "interrupted") {
          throw new Error("controlled external transport interruption");
        }
        if (failure === "startup") {
          return { exitCode: 134, stdout: "controlled linter failed before analysis", stderr: "" };
        }
        const result = spawnSync(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');const expected=process.argv[1];if(fs.readFileSync('apps/orchard/value.js','utf8')!==expected)throw Error('Wrong source tree validated');console.log('actual candidate bytes verified')",
            edited,
          ],
          { cwd, encoding: "utf-8" },
        );
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      }
      const result = spawnSync("/bin/sh", ["-c", input.command], {
        cwd,
        encoding: "utf-8",
        env: {
          ...process.env,
          ...input.env,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  });
  // SAFETY: Consumed apply fields are complete; unused preparation contracts are controlled fixture identities.
  const apply = {
    appSpecDigest: hash("orchard-spec"),
    appSpecPath: "prototype/orchard/spec.md",
    appliedByCallId: "original-apply",
    applyRoot: repository,
    artifactRevision: "original-revision",
    changedContentDigest: hash(original),
    changes: [],
    command: { exitCode: 0, name: "create-app", stderrDigest: hash(""), stdoutDigest: hash("") },
    dependencyCacheContentDigest: hash("dependencies"),
    dependencyCacheDigest: hash("cache"),
    dependencyReceiptDigest: hash("dependency"),
    digest: hash("apply"),
    eligibilityDigest: hash("eligibility"),
    identityDigest: hash("identity"),
    imageDigest: hash("image"),
    planningTreeDigest: tree,
    postTree: [],
    postTreeDigest: tree,
    preTree: [],
    preTreeDigest: tree,
    preparedTreeDigest: tree,
    proposalDigest: hash("proposal"),
    sourceReceiptDigest: hash("source"),
    sourceSha: sha,
    sourceTree: tree,
    status: "applied",
    version: 2,
    workspaceDigest: hash("workspace"),
    targetReceipt: {
      appId: "orchard",
      mutations: ["apps/orchard"],
      omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
      recovered: false,
      topology: {
        newDigest: hash("topology"),
        oldDigest: hash("topology"),
        path: "microfrontends.json",
      },
      version: 1,
      workspacePath: "apps/orchard",
    },
  } as unknown as TargetApplyReceipt;
  const validation = {
    ...validationBinding(apply),
    attemptDigest: hash("original-attempt"),
    commands: [],
    digest: hash("original-validation"),
    status: "passed" as const,
    validatedByCallId: "original-validation",
    version: 3 as const,
  };
  const review = createReviewedChangeSetReceipt(
    deriveNormalizedChangeSet(apply, validation, hash("contract")),
    "original-review",
  );
  const observation = {
    defaultBranch: "main",
    headSha: sha,
    headTree: tree,
    name: "repository",
    owner: "fixture",
    repositoryId: "17",
  };
  // SAFETY: Reviewed app/source/apply bindings are explicit; unrelated preparation receipts are opaque fixture identities.
  const reviewed = {
    version: APP_BUILDER_WORKFLOW_VERSION,
    phase: "reviewed",
    appSpec: {
      appId: "orchard",
      digest: apply.appSpecDigest,
      content: "Read and write records",
      artifactPath: apply.appSpecPath,
      artifactRevision: apply.artifactRevision,
      acceptedByCallId: "original-spec",
    },
    applyReceipt: apply,
    validationReceipt: validation,
    reviewReceipt: review,
    artifacts: [],
    dependencyReceipt: { dependencyLayout: {} },
    identityReceipt: { digest: apply.identityDigest },
    preparedByCallId: "prepare",
    proposal: {
      digest: apply.proposalDigest,
      target: {
        operation: "iterate-existing-app",
        plan: { source: { workspacePath: "apps/orchard" } },
      },
    },
    sourceReceipt: { digest: apply.sourceReceiptDigest, sourceKind: "existing-repository" },
    githubSource: {
      version: 1,
      repository: observation,
      resolvedRef: "refs/heads/main",
      resolvedSha: sha,
      resolvedTree: tree,
      installationIdentityDigest: hash("installation"),
      resolvedByCallId: "resolve",
      digest: hash("github-source"),
    },
    workspace: {
      workspaceId: "owned-workspace",
      workspaceDigest: apply.workspaceDigest,
      workspacePath: repository,
    },
  } as unknown as DraftReviewedWorkflow;
  appBuilderWorkflowState.update(() => reviewed);
  repositoryAccessReceiptState.update(() => ({
    confirmedByCallId: "access",
    digest: hash("access"),
    providerAccessDigest: hash("provider-access"),
    repository: observation,
    scope: { accountLogin: "fixture", accountType: "Organization", installationId: "7" },
    sessionId: "owner-session",
    version: 1,
  }));
  const scope = {
    appId: "orchard",
    appSpecDigest: apply.appSpecDigest,
    proposalDigest: apply.proposalDigest,
    sessionId: "owner-session",
    workspaceId: "owned-workspace",
  };
  expect(requestPrivateApplyApproval(scope, "original-approved-call")).toBe("user-approval");
  recordApprovedPrivateApply(scope, "original-approved-call");
  const candidate: DraftReconciliationCandidate = {
    version: 1,
    appId: "orchard",
    githubSourceDigest: reviewed.githubSource!.digest,
    originalReviewDigest: review.digest,
    repositoryId: "17",
    pullRequestNumber: 11,
    root: candidateRoot,
    workspaceRoot: root,
    headSha: sha,
    headTree: tree,
    baseSha: sha,
    baseTree: tree,
    conflicts: [],
    reviewedLineage: structuredClone(reviewed),
  };
  draftReconciliationState.update(() => candidate);
  const context = (
    signal = new AbortController().signal,
    sessionId = "owner-session",
  ): ToolContext => ({
    abortSignal: signal,
    callId: "candidate-check",
    getSandbox: async (environment?: SandboxEnvironment<object | undefined>) => {
      if (environment !== undefined) {
        throw new Error("Unexpected sandbox environment in test fixture");
      }
      return sandbox;
    },
    getToken: unexpectedSandboxOperation,
    requireAuth: unexpectedSandboxOperation,
    session: {
      auth: { current: null, initiator: null },
      id: sessionId,
      turn: { id: "fixture-turn", sequence: 0 },
    },
    toolName: "validate_app_creation",
  });
  vi.spyOn(artifacts, "publishCompiledOperatorArtifactsForSession").mockResolvedValue({
    compilation: {
      context: {
        authority: { kind: "local", ownerUid: process.getuid!(), stateRoot },
        target: { appId: "orchard", sessionId: "owner-session" },
      },
      release: { status: "not-required" },
    },
  } as Awaited<ReturnType<typeof artifacts.publishCompiledOperatorArtifactsForSession>>);
  return {
    root,
    repository,
    sandbox,
    reviewed,
    candidate,
    commands,
    context,
    setFailure: (value: typeof failure) => {
      failure = value;
    },
  };
};

const prepareEdited = async (f: ReturnType<typeof fixture>) => {
  await editCandidate.execute(
    {
      kind: "replace",
      path: appPath,
      expectedDigest: hash(original),
      oldText: "original-native",
      newText: "managed-public-keys",
    },
    f.context(),
  );
  const candidate = draftReconciliationState.get();
  if (candidate === null) {
    throw new Error("Fixture candidate disappeared");
  }
  const observed = await inspectDraftReconciliation({ prepared: candidate, sandbox: f.sandbox });
  draftReconciliationState.update(() => ({
    ...candidate,
    validationRun: {
      commands: [{ command: install, exitCode: 0 }],
      nextIndex: 1,
      resolvedTree: observed.resolvedTree,
      schemaTaskCompleted: true,
      steps: [
        { kind: "install", command: install },
        { kind: "check", command: check },
        { kind: "check", command: test },
        { kind: "capture", command: "Capture selected checked app release" },
      ],
    },
  }));
};

describe("same-session draft review lineage with real shared state and draft bytes", () => {
  it("routes ordinary validation to edited candidate bytes without consuming the original app review", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const f = fixture();
      await prepareEdited(f);
      await expect(
        validateCreation.execute({ implementationFiles: [] }, f.context()),
      ).resolves.toMatchObject({ status: "validated" });
      expect(f.commands.length).toBeGreaterThan(0);
      expect(f.commands.every((entry) => entry.root === f.candidate.root)).toBe(true);
      expect(readFileSync(path.join(f.repository, appPath), "utf-8")).toBe(original);
      expect(appBuilderWorkflowState.get()).toEqual(f.reviewed);
      expect(draftReconciliationState.get()?.validation?.resolvedTree).not.toBe(
        f.candidate.headTree,
      );
      expect(draftReconciliationState.get()?.review).toBeUndefined();
      await expect(
        sealCandidate.execute(
          { expectedReviewDigest: f.reviewed.reviewReceipt.digest },
          f.context(),
        ),
      ).rejects.toThrow();
    });
  });

  it.each(["startup", "interrupted"] as const)(
    "retains original lineage and edited bytes through a %s command failure and a serialized turn",
    async (failure) => {
      let f!: ReturnType<typeof fixture>;
      const originalContext = new ContextContainer();
      await contextStorage.run(originalContext, async () => {
        f = fixture();
        await prepareEdited(f);
        f.setFailure(failure);
        const pending = validateCreation.execute({ implementationFiles: [] }, f.context());
        await (failure === "startup"
          ? expect(pending).resolves.toMatchObject({ exitCode: 134, status: "needs_repair" })
          : expect(pending).rejects.toThrow("controlled external transport interruption"));
        expect(appBuilderWorkflowState.get()).toEqual(f.reviewed);
        expect(candidateValidationAttemptHistory.get().some((entry) => entry.exitCode !== 0)).toBe(
          true,
        );
      });
      const resumed = await deserializeContext(serializeContext(originalContext));
      await contextStorage.run(resumed, async () => {
        f.setFailure("none");
        await expect(
          validateCreation.execute({ implementationFiles: [] }, f.context()),
        ).resolves.toMatchObject({ status: "validated" });
        const read = await editCandidate.execute({ kind: "read", path: appPath }, f.context());
        expect(z.object({ content: z.string() }).parse(read).content).toBe(edited);
        expect(
          resolveDraftReviewedWorkflow(
            appBuilderWorkflowState.get(),
            draftReconciliationState.get(),
          )?.reviewReceipt.digest,
        ).toBe(f.reviewed.reviewReceipt.digest);
      });
    },
  );

  it.each(["applied", "validation_pending", "validation_failed", "validated"] as const)(
    "recovers retained lineage after the legacy creation validator left phase %s",
    async (phase) => {
      await contextStorage.run(new ContextContainer(), async () => {
        const f = fixture();
        await prepareEdited(f);
        const unreviewed = { ...f.reviewed, reviewReceipt: undefined };
        // SAFETY: This deliberately models the legacy lost-review state; phase-specific evidence is not consumed by the resolver or candidate validator.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the real binding fields while varying only the saved workflow phase.
        appBuilderWorkflowState.update(() => ({ ...unreviewed, phase }) as AppBuilderWorkflowState);
        await expect(
          validateCreation.execute({ implementationFiles: [] }, f.context()),
        ).resolves.toMatchObject({ status: "validated" });
        expect(
          z
            .object({ content: z.string() })
            .parse(await editCandidate.execute({ kind: "read", path: appPath }, f.context()))
            .content,
        ).toBe(edited);
        expect(appBuilderWorkflowState.get().phase).toBe(phase);
        expect(draftReconciliationState.get()?.review).toBeUndefined();
      });
    },
  );

  it("rejects foreign sessions and cancellation before reading or executing the retained candidate", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const f = fixture();
      await prepareEdited(f);
      await expect(
        editCandidate.execute(
          { kind: "read", path: appPath },
          f.context(undefined, "foreign-session"),
        ),
      ).rejects.toThrow("another session");
      const controller = new AbortController();
      controller.abort(new Error("owner cancelled"));
      await expect(
        validateCreation.execute({ implementationFiles: [] }, f.context(controller.signal)),
      ).rejects.toThrow("owner cancelled");
      expect(f.commands).toEqual([]);
      expect(readFileSync(path.join(f.candidate.root, appPath), "utf-8")).toBe(edited);
    });
  });

  it.each(["app", "source", "apply", "review"] as const)(
    "does not recover lineage over a changed %s binding",
    async (changed) => {
      await contextStorage.run(new ContextContainer(), async () => {
        const f = fixture();
        const state = { ...f.reviewed, phase: "validated" as const };
        const variants = {
          app: () => ({ ...state, appSpec: { ...state.appSpec, appId: "foreign" } }),
          apply: () => ({
            ...state,
            applyReceipt: { ...state.applyReceipt, digest: hash("different-apply") },
          }),
          review: () => ({
            ...f.reviewed,
            reviewReceipt: {
              ...f.reviewed.reviewReceipt,
              digest: hash("different-current-review"),
            },
          }),
          source: () => ({
            ...state,
            githubSource: { ...state.githubSource!, digest: hash("foreign-source") },
          }),
        };
        const changedState = variants[changed]();
        appBuilderWorkflowState.update(() => changedState);
        if (changed === "review") {
          expect(
            resolveDraftReviewedWorkflow(changedState, f.candidate)?.reviewReceipt.digest,
          ).toBe(hash("different-current-review"));
        } else {
          expect(resolveDraftReviewedWorkflow(changedState, f.candidate)).toBeUndefined();
        }
        await expect(
          editCandidate.execute({ kind: "read", path: appPath }, f.context()),
        ).rejects.toThrow("no longer matches");
        expect(f.commands).toEqual([]);
      });
    },
  );
});
