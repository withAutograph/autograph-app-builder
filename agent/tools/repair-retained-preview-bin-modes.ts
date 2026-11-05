import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { isDeepStrictEqual } from "node:util";
import { resolvePriorValidatedPrivateArtifact } from "@/lib/agent/prior-validated-private-artifact";
import { retainedBinModeRepairInput } from "@/lib/agent/retained-bin-mode-repair-input";
import type { retainedBinModeRepairExecution } from "@/lib/agent/retained-bin-mode-repair-input";
import { workingPreviewAttemptState, workingPreviewState } from "@/lib/agent/working-preview-state";
import { appBuilderWorkflowState, sha256 } from "@/lib/agent/workflow-state";
import {
  retainedBinModeRepairResult,
  retainedBinModeRepairCommand,
} from "@/lib/repository/retained-bin-mode-repair";
import type { retainedBinModeObservation } from "@/lib/repository/retained-bin-mode-repair";
import { inspectApplyOverlay } from "@/lib/repository/target-apply";
import type { z } from "zod";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";

interface RepairPlan {
  sessionId: string;
  workspaceId: string;
  workspaceDigest: string;
  appSpecDigest: string;
  sourceReceiptDigest: string;
  denialEvidenceDigest: string;
  appId: string;
  currentProposalDigest: string;
  applyDigest: string;
  validationDigest: string;
  expectedDigest: string;
  observation: z.infer<typeof retainedBinModeObservation>;
}
interface RepairState {
  plan: RepairPlan;
  approvalCallId?: string;
  dispatchedCallId?: string;
  verified?: true;
}

const repairState = defineState<RepairState | null>(
  "autograph-app-builder.retained-preview-bin-repair.v1",
  () => null,
);
const replaceRepairState = (expected: RepairState | null, next: RepairState) => {
  repairState.update((current) => {
    if (!isDeepStrictEqual(current, expected)) {
      throw new Error("The executable mode repair changed concurrently.");
    }
    return next;
  });
};

const planDigest = (plan: RepairPlan) => sha256(JSON.stringify(plan));
const paths = (plan: RepairPlan) => plan.observation.targets.map(({ path }) => path);
const matchesRequest = (
  saved: RepairState,
  input: z.infer<typeof retainedBinModeRepairExecution>,
) =>
  planDigest(saved.plan) === input.planDigest && isDeepStrictEqual(paths(saved.plan), input.files);

const assertIdlePreview = () => {
  const preview = workingPreviewState.get();
  if (
    workingPreviewAttemptState.get() !== null ||
    (preview !== null && Date.parse(preview.receipt.expiresAt) > Date.now())
  ) {
    throw new Error(
      "Wait for the private preview and any startup attempt to settle before repairing its checkout.",
    );
  }
};

export default defineTool({
  inputSchema: retainedBinModeRepairInput,
  description:
    "Inspect or restore the exact executable permissions of unchanged repository-owned workspace commands in the prior validated private checkout. Inspect first, then request fresh approval with the returned plan digest and exact file list. This repairs only Bun's 0777-to-0755 mode drift and does not change file contents, run the denied app plan, or publish anything. After an uncertain outcome, inspect only.",
  approval(ctx) {
    const input = ctx.toolInput;
    if (input?.operation === "inspect") {
      return "not-applicable";
    }
    const saved = repairState.get();
    if (
      input?.operation !== "repair" ||
      saved === null ||
      saved.plan.sessionId !== ctx.session.id
    ) {
      return {
        type: "denied",
        reason: "The exact current executable mode repair plan is unavailable.",
      };
    }
    const otherApproval = saved.approvalCallId !== undefined && saved.approvalCallId !== ctx.callId;
    if (saved.dispatchedCallId !== undefined || otherApproval || !matchesRequest(saved, input)) {
      return { type: "denied", reason: "The approved files do not match this repair plan." };
    }
    replaceRepairState(saved, { ...saved, approvalCallId: ctx.callId });
    return "user-approval";
  },
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    assertIdlePreview();
    await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
    const sandbox = await ctx.getSandbox();
    const prior = resolvePriorValidatedPrivateArtifact({
      state,
      sandbox,
      sessionId: ctx.session.id,
      signal: ctx.abortSignal,
    });
    const assertCurrent = () => {
      prior.assertCurrent();
      assertIdlePreview();
    };
    const saved = repairState.get();
    const scope = {
      sessionId: ctx.session.id,
      workspaceId: prior.workspaceId,
      workspaceDigest: prior.workspaceDigest,
      appSpecDigest: prior.appSpecDigest,
      sourceReceiptDigest: prior.sourceReceiptDigest,
      denialEvidenceDigest: prior.denialEvidenceDigest,
      appId: prior.appId,
      currentProposalDigest: prior.currentProposalDigest,
      applyDigest: prior.apply.digest,
      validationDigest: prior.validationDigest,
      expectedDigest: prior.apply.postTreeDigest,
    };
    const run = async (approved?: RepairPlan["observation"]) => {
      assertCurrent();
      const result = await sandbox.run({
        command: retainedBinModeRepairCommand({
          root: prior.root,
          expectedDigest: scope.expectedDigest,
          approved,
        }),
        workingDirectory: prior.root,
        abortSignal: ctx.abortSignal,
      });
      assertCurrent();
      if (result.exitCode !== 0) {
        throw new Error(
          "The exact executable mode repair could not be verified. No automatic retry is permitted.",
        );
      }
      return retainedBinModeRepairResult.parse(JSON.parse(result.stdout));
    };
    if (input.operation === "inspect") {
      if (saved?.dispatchedCallId !== undefined) {
        if (!isDeepStrictEqual({ ...scope, observation: saved.plan.observation }, saved.plan)) {
          throw new Error(
            "The retained executable mode repair belongs to a different saved artifact.",
          );
        }
        assertCurrent();
        const observed = await inspectApplyOverlay(
          { run: (command) => sandbox.run({ ...command, abortSignal: ctx.abortSignal }) },
          prior.root,
          "/workspace/repository",
        );
        assertCurrent();
        if (observed.treeDigest !== scope.expectedDigest) {
          return { status: "reconciliation-required" as const };
        }
        replaceRepairState(saved, { ...saved, verified: true });
        return { status: "restored" as const, files: paths(saved.plan) };
      }
      const observation = await run();
      if ("status" in observation) {
        return observation;
      }
      const plan = { ...scope, observation };
      if (saved?.approvalCallId !== undefined) {
        throw new Error(
          "The current executable mode repair already has a review decision in progress.",
        );
      }
      replaceRepairState(saved, { plan });
      return {
        status: "approval-required" as const,
        planDigest: planDigest(plan),
        files: paths(plan),
      };
    }
    if (
      saved === null ||
      saved.approvalCallId !== ctx.callId ||
      saved.dispatchedCallId !== undefined ||
      !matchesRequest(saved, input)
    ) {
      throw new Error("A fresh approval for this exact executable mode repair is required.");
    }
    if (!isDeepStrictEqual({ ...scope, observation: saved.plan.observation }, saved.plan)) {
      throw new Error("The prior validated artifact changed after this repair was planned.");
    }
    assertCurrent();
    const dispatched = { ...saved, dispatchedCallId: ctx.callId };
    replaceRepairState(saved, dispatched);
    await run(saved.plan.observation);
    replaceRepairState(dispatched, { ...dispatched, verified: true });
    return { status: "restored" as const, files: paths(saved.plan) };
  },
});
