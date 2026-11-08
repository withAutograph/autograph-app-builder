import {
  LEGACY_PRIVATE_COMPUTE_CHECK_TASK,
  PRIVATE_COMPUTE_CHECK_TASK,
} from "../sandbox/private-compute-profile";
import { createHash } from "node:crypto";
/* oxlint-disable typescript/no-unsafe-type-assertion -- The fixture supplies the exact frozen workflow fields consumed by the repair guard; actual approval is installed Eve state. */
/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the installed Eve context only in tests. */
import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { requestPrivateApplyApproval, recordApprovedPrivateApply } from "./private-apply-authority";
import {
  ReviewedCheckRecipeRequiredError,
  prepareValidationPrivateComputeRepair,
} from "./validation-private-compute-repair";
import type { applyPrivateComputeCheckPolicy } from "../repository/private-compute-check-policy";

const unexpectedSandboxOperation = (): never => {
  throw new Error("Unexpected sandbox operation in test fixture");
};
const createSandbox = (): SandboxSession => ({
  readBinaryFile: unexpectedSandboxOperation,
  readFile: unexpectedSandboxOperation,
  readTextFile: unexpectedSandboxOperation,
  removePath: unexpectedSandboxOperation,
  resolvePath: unexpectedSandboxOperation,
  run: unexpectedSandboxOperation,
  spawn: unexpectedSandboxOperation,
  writeBinaryFile: unexpectedSandboxOperation,
  writeFile: unexpectedSandboxOperation,
  writeTextFile: unexpectedSandboxOperation,
});

const installPolicy = vi.fn<typeof applyPrivateComputeCheckPolicy>(async () => {
  await Promise.resolve();
});
const recipe = LEGACY_PRIVATE_COMPUTE_CHECK_TASK;
const afterDigest = createHash("sha256").update(PRIVATE_COMPUTE_CHECK_TASK).digest("hex");
const recipeDigest = createHash("sha256").update(recipe).digest("hex");
const task = "apps/example/.config/mise/tasks/check";
const scope = {
  appId: "example",
  appSpecDigest: "spec",
  proposalDigest: "proposal",
  sessionId: "session",
  workspaceId: "workspace",
};
// SAFETY: Only the explicitly consumed immutable workflow fields are modeled; no runtime authority is fabricated.
const fixture = () =>
  ({
    appSpec: { appId: scope.appId, digest: scope.appSpecDigest },
    sourceReceipt: { digest: "source" },
    workspace: {
      workspaceId: scope.workspaceId,
      workspaceDigest: "workspace-digest",
      workspacePath: "/workspace/repository",
    },
    proposal: {
      digest: scope.proposalDigest,
      target: {
        contract: { appId: scope.appId, appSpec: { sha256: scope.appSpecDigest } },
        privateCompute: {
          checkPolicy: { path: task, beforeSha256: recipeDigest, afterSha256: afterDigest },
        },
      },
    },
    applyReceipt: {
      appSpecDigest: scope.appSpecDigest,
      proposalDigest: scope.proposalDigest,
      workspaceDigest: "workspace-digest",
      sourceReceiptDigest: "source",
      applyRoot: "/workspace/repository",
    },
  }) as Parameters<typeof prepareValidationPrivateComputeRepair>[0]["state"];
const approve = () => {
  requestPrivateApplyApproval(scope, "approve");
  recordApprovedPrivateApply(scope, "approve");
};
describe("explicit reviewed compute task validation repair", () => {
  it("reasserts the exact retained policy only after an explicit supplied task upsert", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      approve();
      const state = fixture();
      const repair = prepareValidationPrivateComputeRepair(
        {
          state,
          files: [{ content: recipe, path: task }],
          sessionId: scope.sessionId,
        },
        installPolicy,
      );
      expect(installPolicy).not.toHaveBeenCalled();
      const sandbox = createSandbox();
      await repair?.applyPolicy(sandbox);
      expect(installPolicy).toHaveBeenCalledWith({
        sandbox,
        profile: state.proposal.target.privateCompute,
        applyRoot: state.applyReceipt.applyRoot,
        abortSignal: undefined,
      });
    });
  });
  it("does not authorize no-files validation, deletion, another task or an unselected profile", () => {
    contextStorage.run(new ContextContainer(), () => {
      for (const files of [
        [],
        [{ operation: "delete" as const, path: task }],
        [{ content: "page", path: "apps/example/app/page.tsx" }],
      ]) {
        expect(
          prepareValidationPrivateComputeRepair({ state: fixture(), files, sessionId: "foreign" }),
        ).toBeUndefined();
      }
      const state = fixture();
      delete state.proposal.target.privateCompute;
      expect(
        prepareValidationPrivateComputeRepair({
          state,
          files: [{ content: recipe, path: task }],
          sessionId: "foreign",
        }),
      ).toBeUndefined();
    });
  });
  it("rejects custom supplied content and cancellation before any source writes", () => {
    contextStorage.run(new ContextContainer(), () => {
      approve();
      expect(() =>
        prepareValidationPrivateComputeRepair({
          state: fixture(),
          files: [{ content: "custom task", path: task }],
          sessionId: scope.sessionId,
        }),
      ).toThrow("not an exact reviewed recipe");
      const controller = new AbortController();
      controller.abort();
      expect(() =>
        prepareValidationPrivateComputeRepair({
          state: fixture(),
          files: [{ content: recipe, path: task }],
          sessionId: scope.sessionId,
          signal: controller.signal,
        }),
      ).toThrow();
    });
  });
  it("rechecks approval and cancellation after asynchronous file writes", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      approve();
      const installer = vi.fn<typeof applyPrivateComputeCheckPolicy>().mockResolvedValue();
      const prepared = prepareValidationPrivateComputeRepair(
        {
          state: fixture(),
          files: [{ content: recipe, path: task }],
          sessionId: scope.sessionId,
        },
        installer,
      );
      const different = { ...scope, proposalDigest: "new-proposal" };
      requestPrivateApplyApproval(different, "new-approval");
      recordApprovedPrivateApply(different, "new-approval");
      await expect(prepared?.applyPolicy(createSandbox())).rejects.toThrow(
        "Private artifact capture no longer belongs to this approved build session.",
      );
      expect(installer).not.toHaveBeenCalled();
      approve();
      const controller = new AbortController();
      const cancelled = prepareValidationPrivateComputeRepair(
        {
          state: fixture(),
          files: [{ content: recipe, path: task }],
          sessionId: scope.sessionId,
          signal: controller.signal,
        },
        installer,
      );
      controller.abort();
      await expect(cancelled?.applyPolicy(createSandbox())).rejects.toBe(controller.signal.reason);
      expect(installer).not.toHaveBeenCalled();
    });
  });
  it("returns the exact canonical recipe only for an approved matching repair", () => {
    contextStorage.run(new ContextContainer(), () => {
      const input = {
        state: fixture(),
        files: [{ content: "guessed task", path: task }],
        sessionId: scope.sessionId,
      };
      let denied: unknown;
      try {
        prepareValidationPrivateComputeRepair(input);
      } catch (error) {
        denied = error;
      }
      expect(denied).not.toBeInstanceOf(ReviewedCheckRecipeRequiredError);
      expect(JSON.stringify(denied)).not.toContain(PRIVATE_COMPUTE_CHECK_TASK);
      approve();
      let guidance: unknown;
      try {
        prepareValidationPrivateComputeRepair(input);
      } catch (error) {
        guidance = error;
      }
      expect(guidance).toBeInstanceOf(ReviewedCheckRecipeRequiredError);
      if (!(guidance instanceof ReviewedCheckRecipeRequiredError)) {
        throw new Error("Expected trusted recipe guidance");
      }
      expect(guidance.implementationFile).toEqual({
        content: PRIVATE_COMPUTE_CHECK_TASK,
        operation: "upsert",
        path: task,
      });
      const profile = input.state.proposal.target.privateCompute;
      if (profile === undefined) {
        throw new Error("Expected selected profile");
      }
      profile.checkPolicy.afterSha256 = "foreign-after-hash";
      expect(() => prepareValidationPrivateComputeRepair(input)).toThrow(
        "differs from the installed canonical recipe",
      );
    });
  });
  it("requires retained approval for this exact session and current workspace", () => {
    contextStorage.run(new ContextContainer(), () => {
      const input = {
        state: fixture(),
        files: [{ content: recipe, path: task }],
        sessionId: scope.sessionId,
      };
      expect(() => prepareValidationPrivateComputeRepair(input)).toThrow();
      approve();
      expect(() =>
        prepareValidationPrivateComputeRepair({ ...input, sessionId: "foreign" }),
      ).toThrow();
      input.state.workspace.workspaceId = "another-workspace";
      expect(() => prepareValidationPrivateComputeRepair(input)).toThrow();
    });
  });
  it.each(["app", "spec", "proposal", "workspace", "source", "root", "policy"])(
    "rejects changed %s bindings before any task mutation",
    (change) => {
      contextStorage.run(new ContextContainer(), () => {
        approve();
        const state = fixture();
        if (change === "app") {
          state.proposal.target.contract.appId = "other";
        }
        if (change === "spec") {
          state.applyReceipt.appSpecDigest = "other";
        }
        if (change === "proposal") {
          state.applyReceipt.proposalDigest = "other";
        }
        if (change === "workspace") {
          state.applyReceipt.workspaceDigest = "other";
        }
        if (change === "source") {
          state.applyReceipt.sourceReceiptDigest = "other";
        }
        if (change === "root") {
          state.applyReceipt.applyRoot = "/workspace/other";
        }
        if (change === "policy" && state.proposal.target.privateCompute) {
          state.proposal.target.privateCompute.checkPolicy.path =
            "apps/other/.config/mise/tasks/check";
        }
        const path = state.proposal.target.privateCompute?.checkPolicy.path ?? task;
        expect(() =>
          prepareValidationPrivateComputeRepair({
            state,
            files: [{ content: recipe, path }],
            sessionId: scope.sessionId,
          }),
        ).toThrow("another app");
      });
    },
  );
});
