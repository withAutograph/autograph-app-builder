/* oxlint-disable sonarjs/expression-complexity -- Keep exact frozen app, proposal, source and workspace authority comparisons visible together. */
import { PRIVATE_COMPUTE_CHECK_TASK } from "../sandbox/private-compute-profile";
import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import type { ImplementationFile } from "./apply-implementation-files";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { assertApprovedPrivateApplySession } from "./private-apply-authority";
import { applyPrivateComputeCheckPolicy } from "../repository/private-compute-check-policy";

type AppliedState = Pick<
  Extract<AppBuilderWorkflowState, { phase: "applied" }>,
  "appSpec" | "workspace" | "proposal" | "applyReceipt" | "sourceReceipt"
>;

/** Trusted source-owned guidance, created only after exact retained approval verification. */
export class ReviewedCheckRecipeRequiredError extends Error {
  readonly code = "reviewed-check-recipe-required";
  readonly implementationFile: { path: string; operation: "upsert"; content: string };
  constructor(taskPath: string) {
    super(
      "The supplied check task is not an exact reviewed recipe; no implementation files were written. Submit the provided canonical task through the same normal validation repair.",
    );
    this.name = "ReviewedCheckRecipeRequiredError";
    this.implementationFile = {
      content: PRIVATE_COMPUTE_CHECK_TASK,
      operation: "upsert",
      path: taskPath,
    };
  }
}

/** Validate authority before source writes; reassert only a task explicitly supplied by this repair. */
export const prepareValidationPrivateComputeRepair = (
  input: {
    state: AppliedState;
    files: readonly ImplementationFile[];
    sessionId: string;
    signal?: AbortSignal;
  },
  installPolicy: typeof applyPrivateComputeCheckPolicy = applyPrivateComputeCheckPolicy,
):
  | { assertAuthorized: () => void; applyPolicy: (sandbox: SandboxSession) => Promise<void> }
  | undefined => {
  const { state } = input;
  const profile = state.proposal.target.privateCompute;
  if (
    profile === undefined ||
    !input.files.some(
      (file) => file.operation !== "delete" && file.path === profile.checkPolicy.path,
    )
  ) {
    return undefined;
  }
  input.signal?.throwIfAborted();
  const supplied = input.files.find(
    (file) => file.operation !== "delete" && file.path === profile.checkPolicy.path,
  );
  if (supplied === undefined || supplied.operation === "delete") {
    return undefined;
  }
  const { appId } = state.appSpec;
  if (
    profile.checkPolicy.path !== `apps/${appId}/.config/mise/tasks/check` ||
    state.proposal.target.contract.appId !== appId ||
    state.proposal.target.contract.appSpec.sha256 !== state.appSpec.digest ||
    state.applyReceipt.appSpecDigest !== state.appSpec.digest ||
    state.applyReceipt.proposalDigest !== state.proposal.digest ||
    state.applyReceipt.workspaceDigest !== state.workspace.workspaceDigest ||
    state.applyReceipt.sourceReceiptDigest !== state.sourceReceipt.digest ||
    state.applyReceipt.applyRoot !== state.workspace.workspacePath
  ) {
    throw new Error(
      "The reviewed check task repair belongs to another app, proposal or workspace.",
    );
  }
  const assertAuthorized = () => {
    assertApprovedPrivateApplySession({
      appId,
      appSpecDigest: state.appSpec.digest,
      proposalDigest: state.proposal.digest,
      sessionId: input.sessionId,
      workspaceId: state.workspace.workspaceId,
    });
  };
  assertAuthorized();
  const canonicalDigest = createHash("sha256").update(PRIVATE_COMPUTE_CHECK_TASK).digest("hex");
  if (profile.checkPolicy.afterSha256 !== canonicalDigest) {
    throw new Error(
      "The reviewed check policy differs from the installed canonical recipe; no implementation files were written.",
    );
  }
  const suppliedDigest = createHash("sha256").update(supplied.content).digest("hex");
  if (
    ![profile.checkPolicy.beforeSha256, profile.checkPolicy.afterSha256].includes(suppliedDigest)
  ) {
    throw new ReviewedCheckRecipeRequiredError(profile.checkPolicy.path);
  }
  return {
    applyPolicy: async (sandbox) => {
      input.signal?.throwIfAborted();
      assertAuthorized();
      await installPolicy({
        abortSignal: input.signal,
        applyRoot: state.applyReceipt.applyRoot,
        profile,
        sandbox,
      });
      input.signal?.throwIfAborted();
      assertAuthorized();
    },
    assertAuthorized,
  };
};
