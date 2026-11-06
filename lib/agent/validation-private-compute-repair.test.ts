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
    applyReceipt: {
      appSpecDigest: scope.appSpecDigest,
      applyRoot: "/workspace/repository",
      proposalDigest: scope.proposalDigest,
      sourceReceiptDigest: "source",
      workspaceDigest: "workspace-digest",
    },
    proposal: {
      digest: scope.proposalDigest,
      target: {
        contract: { appId: scope.appId, appSpec: { sha256: scope.appSpecDigest } },
        privateCompute: {
          checkPolicy: { afterSha256: afterDigest, beforeSha256: recipeDigest, path: task },
        },
      },
    },
    sourceReceipt: { digest: "source" },
    workspace: {
      workspaceDigest: "workspace-digest",
      workspaceId: scope.workspaceId,
      workspacePath: "/workspace/repository",
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
          files: [{ content: recipe, path: task }],
          sessionId: scope.sessionId,
          state,
        },
        installPolicy,
      );
      expect(installPolicy).not.toHaveBeenCalled();
      // SAFETY: The mocked installer only checks identity and cannot invoke Sandbox methods.
      const sandbox = {} as SandboxSession;
      await repair?.applyPolicy(sandbox);
      expect(installPolicy).toHaveBeenCalledWith({
        abortSignal: undefined,
        applyRoot: state.applyReceipt.applyRoot,
        profile: state.proposal.target.privateCompute,
        sandbox,
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
          prepareValidationPrivateComputeRepair({ files, sessionId: "foreign", state: fixture() }),
        ).toBeUndefined();
      }
      const state = fixture();
      delete state.proposal.target.privateCompute;
      expect(
        prepareValidationPrivateComputeRepair({
          files: [{ content: recipe, path: task }],
          sessionId: "foreign",
          state,
        }),
      ).toBeUndefined();
    });
  });
  it("rejects custom supplied content and cancellation before any source writes", () => {
    contextStorage.run(new ContextContainer(), () => {
      approve();
      expect(() =>
        prepareValidationPrivateComputeRepair({
          files: [{ content: "custom task", path: task }],
          sessionId: scope.sessionId,
          state: fixture(),
        }),
      ).toThrow("not an exact reviewed recipe");
      const controller = new AbortController();
      controller.abort();
      expect(() =>
        prepareValidationPrivateComputeRepair({
          files: [{ content: recipe, path: task }],
          sessionId: scope.sessionId,
          signal: controller.signal,
          state: fixture(),
        }),
      ).toThrow();
    });
  });
  it("rechecks approval and cancellation after asynchronous file writes", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      approve();
      const prepared = prepareValidationPrivateComputeRepair({
        files: [{ content: recipe, path: task }],
        sessionId: scope.sessionId,
        state: fixture(),
      });
      const different = { ...scope, proposalDigest: "new-proposal" };
      requestPrivateApplyApproval(different, "new-approval");
      recordApprovedPrivateApply(different, "new-approval");
      // SAFETY: Approval rejects before any mocked Sandbox method can run.
      await expect(prepared?.applyPolicy({} as SandboxSession)).rejects.toThrow();
      approve();
      const controller = new AbortController();
      const cancelled = prepareValidationPrivateComputeRepair({
        files: [{ content: recipe, path: task }],
        sessionId: scope.sessionId,
        signal: controller.signal,
        state: fixture(),
      });
      controller.abort();
      // SAFETY: Cancellation rejects before any mocked Sandbox method can run.
      await expect(cancelled?.applyPolicy({} as SandboxSession)).rejects.toThrow();
    });
  });
  it("returns the exact canonical recipe only for an approved matching repair", () => {
    contextStorage.run(new ContextContainer(), () => {
      const input = {
        files: [{ content: "guessed task", path: task }],
        sessionId: scope.sessionId,
        state: fixture(),
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
        files: [{ content: recipe, path: task }],
        sessionId: scope.sessionId,
        state: fixture(),
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
            files: [{ content: recipe, path }],
            sessionId: scope.sessionId,
            state,
          }),
        ).toThrow("another app");
      });
    },
  );
});
