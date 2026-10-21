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

const mocks = vi.hoisted(() => ({
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
  prepare: vi.fn(),
  publish: vi.fn(),
  review: vi.fn(),
  runtime: vi.fn(),
  state: { current: {} as Record<string, unknown>, update: vi.fn() },
}));

vi.mock("./compiled-operator-artifacts", () => ({
  publishCompiledOperatorArtifactsForSession: mocks.publish,
}));
vi.mock(import("../repository/app-description"), async (importOriginal) => ({
  ...(await importOriginal()),
  describeSelectedApp: mocks.describe,
}));
vi.mock("../../agent/tools/run-app-browser-tests", () => ({ runAppBrowserTests: mocks.browser }));
vi.mock("./review-applied-product-source", () => ({ reviewAppliedProductSource: mocks.review }));
vi.mock("../../agent/tools/prepare-app-local-preview", () => ({
  prepareValidationLocalData: mocks.prepare,
}));
vi.mock("./prepared-runtime-execution", () => ({ resolvePreparedRuntimeExecution: mocks.runtime }));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 1,
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
vi.mock("./product-behavior-state", () => ({
  currentProductBehaviorEvidence: () => [],
  invalidateProductBehaviorEvidence: mocks.clear,
}));
vi.mock("../repository/target-validation", () => ({
  createTargetValidationAttempt: mocks.attempt,
  executeProposalBoundValidation: mocks.execute,
  fixtureValidationCommandExecutor: vi.fn(),
  sandboxValidationCommandExecutor: vi.fn(),
}));
vi.mock("../testing/test-capability", () => ({ hasTestCapability: () => false }));
vi.mock("@/lib/mcp/hosted-route", () => ({ openHostedPostgresDatabase: vi.fn(() => ({})) }));
vi.mock("@/lib/repository/postgres-validation-log-store", () => ({
  createPostgresValidationLogStore: vi.fn(() => mocks.logStore),
}));

const workflow = (phase: "validated" | "reviewed") => ({
  appSpec: { appId: "app", content: "## Acceptance walkthrough\n\nSave draft.", digest: "a" },
  applyReceipt: { applyRoot: "/workspace/repository", digest: "apply" },
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
    mocks.attempt.mockReturnValue({ digest: "attempt" });
    mocks.prepare.mockResolvedValue(null);
    mocks.runtime.mockResolvedValue(null);
    mocks.publish.mockResolvedValue({ status: "published" });
    mocks.describe.mockResolvedValue({ backend: { kind: "static" } });
    mocks.browser.mockResolvedValue({ status: "passed" });
    vi.stubEnv("DATABASE_URL", "postgres://builder-test.invalid/test");
    mocks.state.update.mockImplementation((change) => {
      mocks.state.current = change(mocks.state.current);
    });
    mocks.execute.mockResolvedValue({ ok: true, receipt: { commands: [] } });
    mocks.review.mockResolvedValue({ findings: [], reviewCompleted: true, status: "failed" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("correlates the previously silent boundaries with finite outcomes and preserves operation order", async () => {
    mocks.state.current = workflow("validated");
    mocks.describe.mockResolvedValue({
      backend: { kind: "generated-postgres" },
      validation: { browser: { task: "test-e2e" } },
    });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await validateAppCreation.execute({ implementationFiles: [] }, {
        callId: "validate_phases",
        getSandbox: () => Promise.resolve({ id: "private-sandbox" }),
        session: { auth: { credential: "private-credential" }, id: "private-session" },
      } as never);
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
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate_static",
      getSandbox: () => Promise.resolve({ id: "private-sandbox" }),
      session: { auth: {}, id: "private-session" },
    } as never);
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
          validateAppCreation.execute({ implementationFiles: [] }, {
            callId: "validate_failure",
            getSandbox: () => Promise.resolve({ id: "private-sandbox" }),
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
        getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
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
      getSandbox: () => Promise.resolve(sandbox),
      session: { auth: { owned: "auth" }, id: "adapter" },
    };
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
  it("captures technical validation before a protected runtime error blocks browser behavior", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    mocks.describe.mockResolvedValue({
      backend: { kind: "generated-postgres" },
      validation: { browser: { task: "test-e2e" } },
    });
    mocks.prepare.mockImplementation((input: { execution?: unknown }) =>
      input.execution === undefined
        ? Promise.resolve(null)
        : Promise.reject(new Error("auth_identity_required")),
    );
    mocks.runtime.mockRejectedValue(new Error("auth_identity_required"));
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate_before_auth",
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
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
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
      session: { auth: {}, id: "adapter" },
    };
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const failed = await validateAppCreation.execute({ implementationFiles: [] }, context as never);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])) as unknown).toEqual({
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
    await validateAppCreation.execute({ implementationFiles: [] }, context as never);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
  });
  it("defers independent source assessment after successful technical validation", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
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
    await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("runs current technical validation and defers source assessment without claiming runtime success", async () => {
    mocks.state.current = workflow("validated");
    mocks.review.mockResolvedValue({ findings: [], reviewCompleted: true, status: "passed" });
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
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
      const result = await validateAppCreation.execute({ implementationFiles: [] }, {
        callId: "validate_current",
        getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
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
      const result = await validateAppCreation.execute({ implementationFiles: [] }, {
        callId: "validate",
        getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
        session: { auth: {}, id: "session" },
      } as never);
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
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
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
      const result = await validateAppCreation.execute({ implementationFiles }, {
        callId: "repair",
        getSandbox: () => Promise.resolve({ id: "validation-sandbox", writeTextFile }),
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
      validateAppCreation.execute({ implementationFiles }, {
        callId: "repair",
        getSandbox: () => Promise.resolve({ id: "validation-sandbox", writeTextFile }),
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
        {
          callId: "repair",
          getSandbox: () => Promise.resolve({ id: "validation-sandbox", writeTextFile }),
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
      const context = {
        callId: "repair",
        getSandbox: () => Promise.resolve({ id: "validation-sandbox", writeTextFile }),
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
      expect(mocks.state.current.phase).toBe("validation_pending");
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
      const result = await validateAppCreation.execute({ implementationFiles: [] }, {
        callId: "repair_dependencies",
        getSandbox: () => Promise.resolve(sandbox),
        session: { auth: {}, id: "session" },
      } as never);
      expect(sandbox.setNetworkPolicy).toHaveBeenCalledExactlyOnceWith("allow-all");
      expect(sandbox.setNetworkPolicy).toHaveBeenCalledBefore(sandbox.spawn);
      expect(sandbox.spawn).toHaveBeenCalledExactlyOnceWith({
        command: "bun install",
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
    const context = (sandbox: ReturnType<typeof dependencySandbox>) =>
      ({
        callId: "retry_dependencies",
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
