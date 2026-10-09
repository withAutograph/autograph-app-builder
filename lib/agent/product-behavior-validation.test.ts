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
import validateAppCreation from "../../agent/tools/validate_app_creation";

interface CapturedValidationLog {
  reference?: ValidationLogReference;
}

const mocks = vi.hoisted(() => ({
  attempt: vi.fn(),
  browser: vi.fn(),
  clear: vi.fn(),
  describe: vi.fn(),
  execute: vi.fn(),
  prepare: vi.fn(),
  publish: vi.fn(),
  review: vi.fn(),
  state: { current: {} as Record<string, unknown>, update: vi.fn() },
}));

vi.mock("./compiled-operator-artifacts", () => ({
  publishCompiledOperatorArtifactsForSession: mocks.publish,
}));
vi.mock("../repository/app-description", () => ({ describeSelectedApp: mocks.describe }));
vi.mock("../../agent/tools/run-app-browser-tests", () => ({ runAppBrowserTests: mocks.browser }));
vi.mock("./review-applied-product-source", () => ({ reviewAppliedProductSource: mocks.review }));
vi.mock("../../agent/tools/prepare-app-local-preview", () => ({
  prepareValidationLocalData: mocks.prepare,
}));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 1,
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
  createPostgresValidationLogStore: vi.fn(() => ({})),
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
    vi.unstubAllEnvs();
  });

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
    const sandbox = { id: "validation-sandbox" };
    const context = {
      callId: "validate_capture",
      getSandbox: () => Promise.resolve(sandbox),
      session: { auth: { owned: "auth" }, id: "adapter" },
    };
    await validateAppCreation.execute({ implementationFiles: [] }, context as never);
    expect(mocks.execute).toHaveBeenCalledBefore(mocks.publish);
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
    const failed = await validateAppCreation.execute({ implementationFiles: [] }, context as never);
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
  it("automatically returns source findings after technical validation without a review-tool call", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.execute).toHaveBeenCalledBefore(mocks.review);
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(mocks.state.current.phase).toBe("validated");
    expect(result).toMatchObject({
      productAcceptance: { productStatus: "failed" },
      sourceAssessment: { status: "failed" },
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
  it("runs current technical validation before assessing source without claiming runtime success", async () => {
    mocks.state.current = workflow("validated");
    mocks.review.mockResolvedValue({ findings: [], reviewCompleted: true, status: "passed" });
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledBefore(mocks.review);
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      productAcceptance: { productStatus: "unassessed" },
      reused: false,
      sourceAssessment: { status: "passed" },
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

  it("refreshes persistent authorization evidence and reports failed browser validation", async () => {
    mocks.state.current = workflow("validated");
    mocks.describe.mockResolvedValue({
      backend: { kind: "generated-postgres" },
      validation: { browser: { task: "test-e2e" } },
    });
    mocks.browser.mockResolvedValue({ problem: "Assignment revoked", status: "failed" });
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({ id: "validation-sandbox" }),
      session: { auth: {}, id: "session" },
    } as never);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.browser).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      backendValidation: { status: "failed" },
      reused: false,
      status: "needs_repair",
      technicalStatus: "passed",
    });
  });

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
});
