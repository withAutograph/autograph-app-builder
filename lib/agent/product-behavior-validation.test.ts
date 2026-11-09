import { workspaceBinInstallCommand } from "../repository/workspace-bin-install";
import { createHash } from "node:crypto";
import { PRIVATE_COMPUTE_CHECK_TASK } from "../sandbox/private-compute-profile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// oxlint-disable-next-line sonarjs/no-internal-api-use -- This focused profile fixture uses actual Eve context only in tests.
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { requestPrivateApplyApproval, recordApprovedPrivateApply } from "./private-apply-authority";
import { ValidationLogWriter } from "../repository/validation-log";
import type { ValidationLogReference } from "../repository/validation-log";
import { validationLogStoreForSession } from "./validation-log-store-for-session";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import validationToolDefinition from "../../agent/tools/validate_app_creation";

const validateAppCreation = {
  ...validationToolDefinition,
  async execute(...args: Parameters<typeof validationToolDefinition.execute>) {
    return await contextStorage.run(
      contextStorage.getStore() ?? new ContextContainer(),
      async () => await validationToolDefinition.execute(...args),
    );
  },
};

interface CapturedValidationLog {
  reference?: ValidationLogReference;
}

const mocks = vi.hoisted(() => {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  const current: Record<string, unknown> = {};
  return {
    attempt: vi.fn(),
    logStore: {
      getChunk: vi.fn(),
      getReference: vi.fn(),
      publish: vi.fn(),
      putChunk: vi.fn(),
      removeStaged: vi.fn(),
    },
    browser: vi.fn(),
    clear: vi.fn(),
    describe: vi.fn(),
    execute: vi.fn(),
    canReadHostSource: vi.fn(() => false),
    hostSource: vi.fn(),
    prepare: vi.fn(),
    publish: vi.fn(),
    review: vi.fn(),
    runtime: vi.fn(),
    state: { current, update: vi.fn() },
  };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../repository/development-source dependency used by this test.
vi.mock(import("../repository/development-source"), async (importOriginal) => ({
  ...(await importOriginal()),
  canAutoSelectDevelopmentSource: mocks.canReadHostSource,
  developmentSourceReceipt: mocks.hostSource,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./compiled-operator-artifacts dependency used by this test.
vi.mock("./compiled-operator-artifacts", () => ({
  publishCompiledOperatorArtifactsForSession: mocks.publish,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../repository/app-description dependency used by this test.
vi.mock(import("../repository/app-description"), async (importOriginal) => ({
  ...(await importOriginal()),
  describeSelectedApp: mocks.describe,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../../agent/tools/run-app-browser-tests dependency used by this test.
vi.mock("../../agent/tools/run-app-browser-tests", () => ({ runAppBrowserTests: mocks.browser }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./review-applied-product-source dependency used by this test.
vi.mock("./review-applied-product-source", () => ({ reviewAppliedProductSource: mocks.review }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../../agent/tools/prepare-app-local-preview dependency used by this test.
vi.mock("../../agent/tools/prepare-app-local-preview", () => ({
  prepareValidationLocalData: mocks.prepare,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./prepared-runtime-execution dependency used by this test.
vi.mock("./prepared-runtime-execution", () => ({ resolvePreparedRuntimeExecution: mocks.runtime }));
// oxlint-disable-next-line anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- Keep the controlled eve/tools dependency used by this test. Preserve the existing unknown input contract.
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./workflow-state dependency used by this test.
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 1,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  assertExactWorkflowState: (latest: unknown, expected: unknown) => {
    if (JSON.stringify(latest) !== JSON.stringify(expected)) {
      throw new Error("Workflow changed concurrently");
    }
  },
  appBuilderWorkflowState: {
    get: () => mocks.state.current,
    update: mocks.state.update,
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./product-behavior-state dependency used by this test.
vi.mock("./product-behavior-state", () => ({
  currentProductBehaviorEvidence: () => [],
  invalidateProductBehaviorEvidence: mocks.clear,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../repository/target-validation dependency used by this test.
vi.mock("../repository/target-validation", () => ({
  createTargetValidationAttempt: mocks.attempt,
  executeProposalBoundValidation: mocks.execute,
  fixtureValidationCommandExecutor: vi.fn(),
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous validation shard fixture.
  readTargetValidationTestShards: async () => [],
  sandboxValidationCommandExecutor: vi.fn(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../testing/test-capability dependency used by this test.
vi.mock("../testing/test-capability", () => ({ hasTestCapability: () => false }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @/lib/mcp/hosted-route dependency used by this test.
vi.mock("@/lib/mcp/hosted-route", () => ({ openHostedPostgresDatabase: vi.fn(() => ({})) }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled @/lib/repository/postgres-validation-log-store dependency used by this test.
vi.mock("@/lib/repository/postgres-validation-log-store", () => ({
  createPostgresValidationLogStore: vi.fn(() => mocks.logStore),
}));

const workflow = (phase: "validated" | "reviewed") => ({
  appSpec: { appId: "app", content: "## Acceptance walkthrough\n\nSave draft.", digest: "a" },
  applyReceipt: {
    applyRoot: "/workspace/repository",
    digest: "apply",
    targetReceipt: { workspacePath: "apps/app" },
  },
  artifacts: [],
  dependencyReceipt: { dependencyLayout: {} },
  identityReceipt: {},
  phase,
  preparedByCallId: "prepare",
  proposal: {
    target: {
      operation: "iterate-existing-app",
      plan: { source: { workspacePath: "apps/app" } },
    },
  },
  sourceReceipt: {},
  validationReceipt: { commands: [] },
  version: 1,
  workspace: {},
});
const implementationFiles = [{ content: "updated", path: "apps/app/page.tsx" }];

describe("behavior evidence invalidation during validation repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canReadHostSource.mockReset().mockReturnValue(false);
    mocks.hostSource.mockReset();
    mocks.attempt.mockReturnValue({ digest: "attempt" });
    mocks.prepare.mockResolvedValue(null);
    mocks.runtime.mockResolvedValue(null);
    mocks.publish.mockResolvedValue({ status: "published" });
    mocks.describe.mockResolvedValue({ backend: { kind: "static" } });
    mocks.browser.mockResolvedValue({ status: "passed" });
    vi.stubEnv("DATABASE_URL", "postgres://builder-test.invalid/test");
    mocks.state.update.mockImplementation(
      (change: (state: typeof mocks.state.current) => typeof mocks.state.current) => {
        mocks.state.current = change(mocks.state.current);
      },
    );
    mocks.execute.mockResolvedValue({ ok: true, receipt: { commands: [] } });
    mocks.review.mockResolvedValue({ findings: [], reviewCompleted: true, status: "failed" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("runs validation on the retained applied checkout independently of local planning source", async () => {
    mocks.state.current = workflow("validated");
    mocks.canReadHostSource.mockReturnValueOnce(true);
    mocks.hostSource.mockRejectedValueOnce(
      new Error("The separate local planning source is unavailable."),
    );
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate-retained-application",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "owned-applied-sandbox" }),
      session: { id: "session" },
    } as never);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.hostSource).not.toHaveBeenCalled();
  });

  it("writes an approved app repair without starting repository validation", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const current = workflow("validated");
      const scope = {
        appId: "app",
        appSpecDigest: "a",
        proposalDigest: "approved-proposal",
        sessionId: "session",
        workspaceId: "workspace",
      };
      mocks.state.current = {
        ...current,
        proposal: { ...current.proposal, digest: scope.proposalDigest },
        workspace: { workspaceId: scope.workspaceId },
      };
      const writeTextFile = vi.fn().mockResolvedValue(null);
      const getSandbox = vi.fn().mockResolvedValue({ writeTextFile });
      // SAFETY: The repair branch reads only the call identity and Sandbox file writer.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This scenario supplies a partial tool context fixture.
      const context = { callId: "repair-preview", getSandbox, session: { id: "session" } } as never;
      const input = { implementationFiles, repairOnly: true };
      await expect(validateAppCreation.execute(input, context)).rejects.toThrow("approved build");
      expect(getSandbox).not.toHaveBeenCalled();

      requestPrivateApplyApproval(scope, "original-build");
      recordApprovedPrivateApply(scope, "original-build");
      await expect(validateAppCreation.execute(input, context)).resolves.toEqual({
        status: "repair_applied",
      });
      expect(writeTextFile).toHaveBeenCalledWith({
        content: "updated",
        path: "repository/apps/app/page.tsx",
      });
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.state.current).toMatchObject({ phase: "applied" });
    });
  });

  it("rejects deletion of an approved profile check before sandbox resolution or source writes", async () => {
    const current = workflow("validated");
    mocks.state.current = {
      ...current,
      proposal: {
        ...current.proposal,
        target: {
          ...current.proposal.target,
          privateCompute: { checkPolicy: { path: "apps/app/.config/mise/tasks/check" } },
        },
      },
    };
    const getSandbox = vi.fn();
    const result = await validateAppCreation.execute(
      { implementationFiles: [{ operation: "delete", path: "apps/app/.config/mise/tasks/check" }] },
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      {
        callId: "delete-frozen-check",
        getSandbox,
        session: { id: "session" },
      } as never,
    );
    expect(result).toMatchObject({
      failureClass: "private-compute-check-policy",
      reason: "validation-tooling-prerequisite",
      status: "needs_repair",
    });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(mocks.state.update).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("correlates the previously silent boundaries with finite outcomes and preserves operation order", async () => {
    mocks.state.current = workflow("validated");
    mocks.describe.mockResolvedValue({
      backend: { kind: "generated-postgres" },
      validation: { browser: { task: "test-e2e" } },
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      await validateAppCreation.execute({ implementationFiles: [], runBrowserTests: true }, {
        callId: "validate_phases",
        // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
        getSandbox: async () => ({ id: "private-sandbox" }),
        session: { auth: { credential: "private-credential" }, id: "private-session" },
      } as never);
      // SAFETY: JSON.parse returns any; unknown makes no claim about the parsed shape.
      const records = log.mock.calls.map(([record]) => JSON.parse(String(record)) as unknown);
      const boundaryPhases = [
        "describing_validation_app",
        "validation_app_described",
        "capturing_validated_release",
        "validated_release_capture_finished",
        "validating_persistent_backend",
        "persistent_backend_validation_finished",
      ];
      const boundaryRecords = records.filter((record) =>
        boundaryPhases.some((phase) => JSON.stringify(record).includes(`"phase":"${phase}"`)),
      );
      expect(boundaryRecords).toEqual([
        {
          callId: "validate_phases",
          event: "app_builder.validation_phase",
          phase: "describing_validation_app",
        },
        {
          callId: "validate_phases",
          detail: true,
          event: "app_builder.validation_phase",
          phase: "validation_app_described",
        },
        {
          callId: "validate_phases",
          event: "app_builder.validation_phase",
          phase: "capturing_validated_release",
        },
        {
          callId: "validate_phases",
          detail: "no_repair_required",
          event: "app_builder.validation_phase",
          phase: "validated_release_capture_finished",
        },
        {
          callId: "validate_phases",
          event: "app_builder.validation_phase",
          phase: "validating_persistent_backend",
        },
        {
          callId: "validate_phases",
          detail: "passed",
          event: "app_builder.validation_phase",
          phase: "persistent_backend_validation_finished",
        },
      ]);
      expect(JSON.stringify(records)).not.toContain("private-");
      expect(mocks.describe).toHaveBeenCalledOnce();
      expect(mocks.publish).toHaveBeenCalledOnce();
      expect(mocks.browser).toHaveBeenCalledOnce();
      expect(mocks.execute).toHaveBeenCalledBefore(mocks.describe);
      expect(mocks.describe).toHaveBeenCalledBefore(mocks.publish);
      expect(mocks.publish).toHaveBeenCalledBefore(mocks.runtime);
      expect(mocks.runtime).toHaveBeenCalledBefore(mocks.browser);
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.runtime).toHaveBeenCalledOnce();
      expect(mocks.review).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("reports skipped persistent validation as unassessed and capture as requiring no repair", async () => {
    mocks.state.current = workflow("validated");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate_static",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "private-sandbox" }),
      session: { auth: {}, id: "private-session" },
    } as never);
    // SAFETY: JSON.parse returns any; unknown makes no claim about the parsed shape.
    const records = log.mock.calls.map(([record]) => JSON.parse(String(record)) as unknown);
    expect(records).toContainEqual({
      callId: "validate_static",
      detail: "unassessed",
      event: "app_builder.validation_phase",
      phase: "persistent_backend_validation_finished",
    });
    expect(records).toContainEqual({
      callId: "validate_static",
      detail: "no_repair_required",
      event: "app_builder.validation_phase",
      phase: "validated_release_capture_finished",
    });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.browser).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      backendValidation: { status: "unassessed" },
      status: "validated",
    });
  });

  it.each([
    ["describe", "describing_validation_app"],
    ["browser", "validating_persistent_backend"],
  ] as const)(
    "retains the original %s rejection and last finite phase",
    async (boundary, phase) => {
      mocks.state.current = workflow("validated");
      mocks.describe.mockResolvedValue({
        backend: { kind: "generated-postgres" },
        validation: { browser: { task: "test-e2e" } },
      });
      const failure = new Error("private failure payload");
      mocks[boundary].mockRejectedValueOnce(failure);
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        await expect(
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
          validateAppCreation.execute({ implementationFiles: [], runBrowserTests: true }, {
            callId: "validate_failure",
            // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
            getSandbox: async () => ({ id: "private-sandbox" }),
            session: { auth: {}, id: "private-session" },
          } as never),
        ).rejects.toBe(failure);
        expect(log.mock.calls.at(-1)).toEqual([
          JSON.stringify({
            callId: "validate_failure",
            event: "app_builder.validation_phase",
            phase,
          }),
        ]);
        expect(JSON.stringify(log.mock.calls)).not.toContain("private");
        expect(mocks.review).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it("default non-fixture developer validation writes actual durable logs without DATABASE_URL", async () => {
    const stateRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "developer-validation-callsite-")),
    );
    try {
      const runsRoot = path.join(stateRoot, "runs");
      await mkdir(runsRoot, { mode: 0o700 });
      for (const [name, value] of Object.entries({
        APP_BUILDER_DEV_RUNS_ROOT: runsRoot,
        APP_BUILDER_EXECUTION_BUNDLE: "local-development",
        APP_BUILDER_EXECUTION_MODE: "development",
        APP_BUILDER_LOCAL_ADAPTER: "1",
        APP_BUILDER_SANDBOX_PROVIDER: "vercel",
        DATABASE_URL: "",
        EVE_HOSTED_ADAPTER: "0",
      })) {
        vi.stubEnv(name, value);
      }
      mocks.state.current = {
        ...workflow("validated"),
        phase: "applied",
        proposal: { ...workflow("validated").proposal, digest: "approved-proposal" },
        workspace: { workspaceId: "private-workspace" },
      };
      const attemptDigest = "c".repeat(64);
      mocks.attempt.mockReturnValue({ digest: attemptDigest });
      const captured: CapturedValidationLog = {};
      mocks.execute.mockImplementation(
        async (input: {
          attempt: { digest: string };
          logStore: ConstructorParameters<typeof ValidationLogWriter>[0];
          sessionId: string;
        }) => {
          const stdout = new ValidationLogWriter(input.logStore, {
            attemptDigest: input.attempt.digest,
            channel: "stdout",
            command: "check-build",
            sessionId: input.sessionId,
          });
          const stderr = new ValidationLogWriter(input.logStore, {
            attemptDigest: input.attempt.digest,
            channel: "stderr",
            command: "check-build",
            sessionId: input.sessionId,
          });
          await stdout.append("apps/app checks: token=local-private-fixture\n");
          const out = await stdout.finish("complete");
          captured.reference = out.reference;
          const err = await stderr.finish("complete");
          return {
            ok: true,
            receipt: {
              attemptDigest,
              commands: [
                { logs: { stderr: err.reference, stdout: out.reference }, name: "check-build" },
              ],
            },
          };
        },
      );
      const context = {
        callId: "validate_local",
        // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
        getSandbox: async () => ({ id: "validation-sandbox" }),
        session: { auth: null, id: "actual-local-session" },
      };
      await contextStorage.run(new ContextContainer(), async () => {
        const scope = {
          appId: "app",
          appSpecDigest: "a",
          proposalDigest: "approved-proposal",
          sessionId: context.session.id,
          workspaceId: "private-workspace",
        };
        requestPrivateApplyApproval(scope, "approve");
        recordApprovedPrivateApply(scope, "approve");
        const result = await validateAppCreation.execute(
          { implementationFiles: [] },
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
          context as never,
        );
        expect(result).toMatchObject({ technicalStatus: "passed" });
        const { reference } = captured;
        if (reference === undefined) {
          throw new Error("Expected a durable local log reference.");
        }
        const store = await validationLogStoreForSession({
          sessionAuth: null,
          sessionId: context.session.id,
        });
        const key = {
          attemptDigest,
          channel: "stdout" as const,
          command: "check-build",
          logId: reference.logId,
          sessionId: context.session.id,
        };
        expect(await store.getReference(key)).toEqual(reference);
        const chunk = await store.getChunk(key, 0);
        expect(chunk?.content).toContain("[REDACTED]");
        expect(chunk?.content).not.toContain("local-private-fixture");
        expect(result).toMatchObject({ logs: [{ logs: { stdout: reference } }] });
        expect(mocks.execute).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: context.session.id }),
        );
      });
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
    }
  });
  it("first-pass generated apps capture the selected release without a separate compile tool call", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    mocks.describe.mockResolvedValue({
      backend: { kind: "generated-postgres" },
      validation: { browser: null },
    });
    const sandbox = {};
    const context = {
      callId: "validate_capture",
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      getSandbox: () => Promise.resolve(sandbox),
      session: { auth: { owned: "auth" }, id: "adapter" },
    };
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    const result = await validateAppCreation.execute({ implementationFiles: [] }, context as never);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.prepare.mock.calls[0]?.[0]).not.toHaveProperty("execution");
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledBefore(mocks.publish);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.browser).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.state.current.phase).toBe("validated");
    expect(result).toMatchObject({
      backendValidation: { status: "unassessed" },
      productAcceptance: { productStatus: "unassessed" },
      productBehaviorEvidence: [],
      sourceAssessment: { reviewCompleted: false, status: "unassessed" },
      status: "validated",
      technicalStatus: "passed",
    });
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterSessionId: "adapter",
        appId: "app",
        appSpecDigest: "a",
        root: "/workspace/repository",
        sandbox,
        sessionAuth: context.session.auth,
      }),
    );
  });
  it("leaves a declared browser task unassessed during ordinary build validation", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    mocks.describe.mockResolvedValue({
      backend: { kind: "generated-postgres" },
      validation: { browser: { task: "test-e2e" } },
    });
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate_build",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.browser).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      backendValidation: { status: "unassessed" },
      status: "validated",
      technicalStatus: "passed",
    });
  });

  it("captures technical validation before a protected runtime error blocks browser behavior", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    mocks.describe.mockResolvedValue({
      backend: { kind: "generated-postgres" },
      validation: { browser: { task: "test-e2e" } },
    });
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    mocks.prepare.mockImplementation((input: { execution?: unknown }) =>
      input.execution === undefined
        ? Promise.resolve(null)
        : Promise.reject(new Error("auth_identity_required")),
    );
    mocks.runtime.mockRejectedValue(new Error("auth_identity_required"));
    const result = await validateAppCreation.execute(
      { implementationFiles: [], runBrowserTests: true },
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      {
        callId: "validate_before_auth",
        // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
        getSandbox: async () => ({ id: "validation-sandbox" }),
        session: { auth: {}, id: "session" },
      } as never,
    );
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.prepare.mock.calls[0]?.[0]).not.toHaveProperty("execution");
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledBefore(mocks.publish);
    expect(mocks.publish).toHaveBeenCalledBefore(mocks.runtime);
    expect(mocks.runtime).toHaveBeenCalledOnce();
    expect(mocks.browser).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.state.current.phase).toBe("validated");
    expect(result).toMatchObject({
      backendValidation: {
        problem: "auth_identity_required",
        reason: "authenticated-runtime-preparation",
        status: "blocked",
      },
      productAcceptance: { productStatus: "unassessed" },
      productBehaviorEvidence: [],
      sourceAssessment: { reviewCompleted: false, status: "unassessed" },
      status: "needs_repair",
      technicalStatus: "passed",
    });
  });

  it("validated generated apps rerun current commands when retrying failed capture", async () => {
    mocks.state.current = workflow("validated");
    mocks.describe.mockResolvedValue({
      backend: { kind: "generated-postgres" },
      validation: { browser: null },
    });
    mocks.publish.mockRejectedValueOnce(new Error("private storage failure"));
    const context = {
      callId: "validate_retry",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "validation-sandbox" }),
      session: { auth: {}, id: "adapter" },
    };
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    const failed = await validateAppCreation.execute({ implementationFiles: [] }, context as never);
    const lastRecord: unknown = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(lastRecord).toEqual({
      callId: context.callId,
      detail: "needs_repair",
      event: "app_builder.validation_phase",
      phase: "validated_release_capture_finished",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private storage failure");
    expect(mocks.browser).not.toHaveBeenCalled();
    log.mockRestore();
    expect(failed).toMatchObject({
      reason: "compiled-artifact-publication",
      status: "needs_repair",
      technicalStatus: "passed",
    });
    expect(mocks.state.current.phase).toBe("validated");
    expect(JSON.stringify(failed)).not.toContain("private storage failure");
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    await validateAppCreation.execute({ implementationFiles: [] }, context as never);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
  });
  it("defers independent source assessment after successful technical validation", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.state.current.phase).toBe("validated");
    expect(result).toMatchObject({
      productAcceptance: { productStatus: "unassessed" },
      sourceAssessment: { reviewCompleted: false, status: "unassessed" },
      technicalStatus: "passed",
    });
  });
  it("does not invoke the source judge when repository commands fail", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    mocks.execute.mockResolvedValue({
      ok: false,
      receipt: { commands: [], reason: "command failed" },
    });
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("runs current technical validation and defers source assessment without claiming runtime success", async () => {
    mocks.state.current = workflow("validated");
    mocks.review.mockResolvedValue({ findings: [], reviewCompleted: true, status: "passed" });
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      productAcceptance: { productStatus: "unassessed" },
      reused: false,
      sourceAssessment: { reviewCompleted: false, status: "unassessed" },
      technicalStatus: "passed",
    });
  });

  it.each(["validated", "reviewed"] as const)(
    "rejects old validation receipts when current commands fail in %s phase without repair files",
    async (phase) => {
      mocks.state.current = workflow(phase);
      const receipt = {
        commands: [{ exitCode: 1, name: "check-build" }],
        reason: "current check/build failed",
      };
      mocks.execute.mockResolvedValue({ ok: false, receipt });
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      const result = await validateAppCreation.execute({ implementationFiles: [] }, {
        callId: "validate_current",
        // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
        getSandbox: async () => ({ id: "validation-sandbox" }),
        session: { auth: {}, id: "session" },
      } as never);
      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(mocks.attempt).toHaveBeenCalledOnce();
      expect(mocks.state.current.phase).toBe("validation_failed");
      expect(mocks.state.current).not.toHaveProperty("validationReceipt");
      expect(mocks.review).not.toHaveBeenCalled();
      expect(mocks.browser).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(result).toMatchObject({ reused: false, status: "needs_repair" });
      expect(result).not.toMatchObject({ technicalStatus: "passed" });
    },
  );

  it.each(["failed", "blocked"] as const)(
    "refreshes persistent authorization evidence and reports %s browser validation",
    async (status) => {
      mocks.state.current = workflow("validated");
      mocks.describe.mockResolvedValue({
        backend: { kind: "generated-postgres" },
        validation: { browser: { task: "test-e2e" } },
      });
      mocks.browser.mockResolvedValue({ problem: "Assignment revoked", status });
      const result = await validateAppCreation.execute(
        { implementationFiles: [], runBrowserTests: true },
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
        {
          callId: "validate",
          // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
          getSandbox: async () => ({ id: "validation-sandbox" }),
          session: { auth: {}, id: "session" },
        } as never,
      );
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.prepare.mock.calls[0]?.[0]).not.toHaveProperty("execution");
      expect(mocks.runtime).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session" }));
      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(mocks.browser).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        backendValidation: { status },
        reused: false,
        status: "needs_repair",
        technicalStatus: "passed",
      });
    },
  );

  it("keeps preparation failure repairable before compilation", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    mocks.prepare.mockRejectedValueOnce(new Error("Checked release differs from CUE"));
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.state.current.phase).toBe("applied");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reason: "authenticated-runtime-preparation",
      status: "needs_repair",
    });
  });

  it.each(["validated", "reviewed"] as const)(
    "does not ignore repair files in %s phase",
    async (phase) => {
      mocks.state.current = workflow(phase);
      const writeTextFile = vi.fn();
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      const result = await validateAppCreation.execute({ implementationFiles }, {
        callId: "repair",
        // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
        getSandbox: async () => ({ id: "validation-sandbox", writeTextFile }),
        session: { auth: {}, id: "session" },
      } as never);
      expect(mocks.clear).toHaveBeenCalledBefore(writeTextFile);
      expect(writeTextFile).toHaveBeenCalledOnce();
      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ reused: false, status: "validated" });
    },
  );

  it("invalidates evidence before a failed repair write", async () => {
    mocks.state.current = workflow("validated");
    const writeTextFile = vi.fn().mockRejectedValue(new Error("write failed"));
    await expect(
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      validateAppCreation.execute({ implementationFiles }, {
        callId: "repair",
        // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
        getSandbox: async () => ({ id: "validation-sandbox", writeTextFile }),
        session: { auth: {}, id: "session" },
      } as never),
    ).rejects.toThrow("write failed");
    expect(mocks.clear).toHaveBeenCalledBefore(writeTextFile);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("rejects a platform-owned repair before changing validation state or files", async () => {
    mocks.state.current = workflow("validated");
    const writeTextFile = vi.fn();
    await expect(
      validateAppCreation.execute(
        {
          implementationFiles: [
            { content: "out of scope", path: "packages/platform/src/change.ts" },
          ],
        },
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
        {
          callId: "repair",
          // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
          getSandbox: async () => ({ id: "validation-sandbox", writeTextFile }),
          session: { auth: {}, id: "session" },
        } as never,
      ),
    ).rejects.toThrow("Existing-app implementation files must stay inside the app workspace.");
    expect(mocks.state.current.phase).toBe("validated");
    expect(mocks.state.update).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
  it.each(["validated", "reviewed"] as const)(
    "keeps failed partial repair pending from %s and reruns validation",
    async (phase) => {
      mocks.state.current = workflow(phase);
      const writeTextFile = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("second write failed"));
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      const context = {
        callId: "repair",
        // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
        getSandbox: async () => ({ id: "validation-sandbox", writeTextFile }),
        session: { auth: {}, id: "session" },
      } as never;
      await expect(
        validateAppCreation.execute(
          {
            implementationFiles: [
              { content: "changed", path: "apps/app/page.tsx" },
              { content: "next", path: "apps/app/actions.ts" },
            ],
          },
          context,
        ),
      ).rejects.toThrow("second write failed");
      expect(mocks.state.current.phase).toBe("applied");
      expect(mocks.state.current).not.toHaveProperty("validationReceipt");
      expect(mocks.state.current).not.toHaveProperty("validationFailure");
      expect(mocks.state.update).toHaveBeenCalledBefore(writeTextFile);
      expect(mocks.clear).toHaveBeenCalledBefore(writeTextFile);
      expect(mocks.execute).not.toHaveBeenCalled();
      const result = await validateAppCreation.execute({ implementationFiles: [] }, context);
      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ reused: false, status: "validated" });
    },
  );
  it.each(["missing-app-task", "native-tool-panic"])(
    "runs explicit validation against the current checkout after a retained %s failure",
    async (failureClass) => {
      const saved = {
        ...workflow("validated"),
        phase: "validation_failed",
        validationFailure: {
          reason: "tooling-prerequisite",
          attemptDigest: "saved-attempt",
          commandFailure: {
            name: "check-build",
            exitCode: 1,
            failureClass,
            hint: "Restore the retained task prerequisite.",
          },
        },
      };
      mocks.state.current = saved;
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      const getSandbox = vi.fn(async () => ({ id: "validation-sandbox" }));
      // SAFETY: The existing faithful validation ports own all effects in this product-tool regression.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This scenario supplies a partial tool context fixture.
      const result = await validateAppCreation.execute({ implementationFiles: [] }, {
        callId: "retry-after-tooling-repair",
        getSandbox,
        session: { id: "session", auth: {} },
      } as never);
      expect(getSandbox).toHaveBeenCalledOnce();
      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ reused: false, status: "validated" });
      expect(mocks.state.current).not.toHaveProperty("validationFailure");
    },
  );
  it("allows explicit ordinary app repair after a retained tooling prerequisite", async () => {
    mocks.state.current = {
      ...workflow("validated"),
      phase: "validation_failed",
      validationFailure: {
        reason: "tooling-prerequisite",
        attemptDigest: "saved-attempt",
        commandFailure: { name: "check-build", exitCode: 1, failureClass: "missing-app-task" },
      },
    };
    const writeTextFile = vi.fn();
    // SAFETY: The existing faithful validation ports own all effects in this product-tool regression.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This scenario supplies a partial tool context fixture.
    const result = await validateAppCreation.execute({ implementationFiles }, {
      callId: "explicit-repair",
      // oxlint-disable-next-line eslint/require-await -- Return a fresh sandbox fixture through the async port.
      getSandbox: async () => ({ id: "validation-sandbox", writeTextFile }),
      session: { id: "session", auth: {} },
    } as never);
    expect(writeTextFile).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ reused: false, status: "validated" });
  });
  it("returns exact reviewed task guidance only to the bound approved repair without source effects", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const taskPath = "apps/app/.config/mise/tasks/check";
      const scope = {
        appId: "app",
        appSpecDigest: "a",
        proposalDigest: "proposal",
        workspaceId: "workspace",
        sessionId: "session",
      };
      const current = {
        ...workflow("validated"),
        workspace: {
          workspaceId: scope.workspaceId,
          workspaceDigest: "workspace-digest",
          workspacePath: "/workspace/repository",
        },
        sourceReceipt: { digest: "source-digest" },
        proposal: {
          digest: scope.proposalDigest,
          target: {
            contract: { appId: "app", appSpec: { sha256: "a" } },
            privateCompute: {
              checkPolicy: {
                path: taskPath,
                beforeSha256: "old-hash",
                afterSha256: createHash("sha256").update(PRIVATE_COMPUTE_CHECK_TASK).digest("hex"),
              },
            },
          },
        },
        applyReceipt: {
          ...workflow("validated").applyReceipt,
          appSpecDigest: "a",
          proposalDigest: scope.proposalDigest,
          workspaceDigest: "workspace-digest",
          sourceReceiptDigest: "source-digest",
        },
      };
      mocks.state.current = current;
      const getSandbox = vi.fn();
      const writeTextFile = vi.fn();
      // SAFETY: Scope rejection and trusted guidance both finish before any Sandbox operation.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This scenario supplies a partial tool context fixture.
      const context = {
        callId: "reviewed-recipe",
        getSandbox,
        session: { id: scope.sessionId, auth: {} },
      } as never;
      const input = { implementationFiles: [{ path: taskPath, content: "guessed recipe" }] };
      await expect(validateAppCreation.execute(input, context)).rejects.toThrow();
      requestPrivateApplyApproval(scope, "approve");
      recordApprovedPrivateApply(scope, "approve");
      expect(await validateAppCreation.execute(input, context)).toMatchObject({
        implementationFiles: [
          { content: PRIVATE_COMPUTE_CHECK_TASK, operation: "upsert", path: taskPath },
        ],
        reason: "reviewed-check-recipe-required",
        status: "needs_repair",
      });
      expect(getSandbox).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(mocks.state.update).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.state.current).toBe(current);
    });
  });
  const missingDependencyFailure = {
    attemptDigest: "saved-attempt",
    commandFailure: { exitCode: 1, name: "check-build" },
    commands: [],
    digest: "saved-failure",
    output: {
      stderr: 'Cannot find package "@workspace/next-config"',
      stdout: "",
      truncated: false,
    },
    reason: "command-failed",
    status: "failed",
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep fixture helpers scoped to their test or fixture instance.
  const dependencySandbox = (exitCode = 0) => ({
    id: "retained-sandbox",
    setNetworkPolicy: vi.fn().mockResolvedValue(null),
    spawn: vi.fn().mockResolvedValue({
      kill: vi.fn().mockResolvedValue(null),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      wait: vi.fn().mockResolvedValue({ exitCode }),
    }),
  });

  it.each(["validated", "validation_failed", "local-data-failed"])(
    "repairs the saved dependency failure before local setup and preserves its provenance through %s",
    async (outcome) => {
      mocks.state.current = {
        ...workflow("validated"),
        phase: "validation_failed",
        validationFailure: missingDependencyFailure,
      };
      const sandbox = dependencySandbox();
      if (outcome === "validation_failed") {
        mocks.execute.mockResolvedValueOnce({
          ok: false,
          receipt: {
            ...missingDependencyFailure,
            digest: "new-failure",
            attemptDigest: "new-attempt",
          },
        });
      }
      if (outcome === "local-data-failed") {
        mocks.prepare.mockRejectedValueOnce(new Error("local setup failed"));
      }
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      const result = await validateAppCreation.execute({ implementationFiles: [] }, {
        callId: "repair_dependencies",
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
        getSandbox: () => Promise.resolve(sandbox),
        session: { auth: {}, id: "session" },
      } as never);
      expect(sandbox.setNetworkPolicy).toHaveBeenCalledExactlyOnceWith("allow-all");
      expect(sandbox.setNetworkPolicy).toHaveBeenCalledBefore(sandbox.spawn);
      expect(sandbox.spawn).toHaveBeenCalledExactlyOnceWith({
        command: workspaceBinInstallCommand("/workspace/repository", false),
        workingDirectory: "/workspace/repository",
      });
      expect(sandbox.spawn).toHaveBeenCalledBefore(mocks.prepare);
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.execute).toHaveBeenCalledTimes(outcome === "local-data-failed" ? 0 : 1);
      expect(mocks.state.current.checkoutDependencyAttempts).toEqual([
        expect.objectContaining({
          completion: "complete",
          exitCode: 0,
          recoveryOfValidationFailure: missingDependencyFailure,
        }),
      ]);
      expect(result).toMatchObject({
        status: outcome === "validated" ? "validated" : "needs_repair",
      });
    },
  );

  it("retains the original validation failure after install failure and repairs on the next ordinary invocation", async () => {
    mocks.state.current = {
      ...workflow("validated"),
      phase: "validation_failed",
      validationFailure: missingDependencyFailure,
    };
    const failed = dependencySandbox(1);
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep fixture helpers scoped to their test or fixture instance.
    const context = (sandbox: ReturnType<typeof dependencySandbox>) =>
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.; This scenario supplies a partial tool context fixture.
      ({
        callId: "retry_dependencies",
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
        getSandbox: () => Promise.resolve(sandbox),
        session: { auth: {}, id: "session" },
      }) as never;
    const result = await validateAppCreation.execute({ implementationFiles: [] }, context(failed));
    expect(result).toMatchObject({ reason: "dependency-recovery", status: "needs_repair" });
    expect(mocks.state.current.validationFailure).toBe(missingDependencyFailure);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    const restored = dependencySandbox();
    await validateAppCreation.execute({ implementationFiles: [] }, context(restored));
    expect(restored.spawn).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.state.current.checkoutDependencyAttempts).toEqual([
      expect.objectContaining({
        completion: "complete",
        exitCode: 1,
        recoveryOfValidationFailure: missingDependencyFailure,
      }),
      expect.objectContaining({
        completion: "complete",
        exitCode: 0,
        recoveryOfValidationFailure: missingDependencyFailure,
      }),
    ]);
  });
});
