import type { HostedRuntimeApprovalReadOptions } from "./hosted-runtime-prior-approval";
import type {
  reportRuntimePreparationFailure,
  reportRuntimePreparationStarted,
  RuntimePreparationStage,
} from "../provisioning/hosted-operator-consent-diagnostic";
import type { WorkflowStepToolContext } from "eve/tools";
import type {
  HostedOperatorError as HostedOperatorErrorType,
  HostedOperatorPlan,
  OperatorSelection,
  OperatorPublicResult,
} from "../../lib/provisioning/hosted-operator-contract";
import type { PreparedRuntimeSelection } from "../../lib/agent/prepared-runtime-selection";
import type { hostedOperatorClientForSession } from "../../lib/provisioning/hosted-operator-client";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface HostedRuntimeApprovalEnvelope {
  appId: string;
  branch: string;
  environment: "preview";
  operationRef: string;
  plan: Record<string, JsonValue>;
  planDigest: string;
  projectId: string;
}

interface HostedRuntimeInput extends HostedRuntimeApprovalEnvelope {
  plan: HostedOperatorPlan;
}

type HostedRuntimeContext = Pick<WorkflowStepToolContext, "abortSignal" | "callId"> & {
  session: { id: string };
};
type HostedOperatorClient = Pick<
  Awaited<ReturnType<typeof hostedOperatorClientForSession>>,
  "authIdentityInput" | "request" | "sessionId"
>;

interface HostedRuntimeContract {
  createResourceMismatch: () => Error;
  digest: (plan: HostedOperatorPlan) => string;
  isOperatorError: (error: unknown) => error is HostedOperatorErrorType;
  sameSelection: (left: OperatorSelection, right: OperatorSelection) => boolean;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught exceptions are classified by the injected closed diagnostic boundary.
  onFailure?: (stage: RuntimePreparationStage, error: unknown) => void;
}

type HostedOperatorErrorClassifier = (value: unknown) => value is HostedOperatorErrorType;
const noHostedOperatorError: HostedOperatorErrorClassifier = (
  _value: unknown,
): _value is HostedOperatorErrorType => false;

const reportCaughtPreparationFailure = (
  contract: HostedRuntimeContract,
  stage: RuntimePreparationStage,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only the injected reporter classifies caught exceptions into closed metadata.
  error: unknown,
) => {
  try {
    contract.onFailure?.(stage, error);
  } catch {
    /* Diagnostics cannot change the original blocked result. */
  }
};

const preparationPlanningAction = (input: HostedRuntimeInput, reason: string) => ({
  tool: "plan-app-hosted-runtime" as const,
  input: {
    appId: input.appId,
    branch: input.branch,
    environment: input.environment,
    operation: "prepare" as const,
    projectId: input.projectId,
    ...(input.plan.normalActorProgram === undefined
      ? {}
      : { normalActorProgram: input.plan.normalActorProgram }),
    ...(input.plan.authSignupPolicy === undefined
      ? {}
      : {
          authSignupPolicy: {
            version: input.plan.authSignupPolicy.version,
            organizationId: input.plan.authSignupPolicy.organizationId,
            eligibility: input.plan.authSignupPolicy.eligibility,
            ...(input.plan.authSignupPolicy.allowedEmails === undefined
              ? {}
              : { allowedEmails: input.plan.authSignupPolicy.allowedEmails }),
            membershipRole: input.plan.authSignupPolicy.membershipRole,
            appRoles: input.plan.authSignupPolicy.appRoles,
            appPath: input.plan.authSignupPolicy.appPath,
          },
        }),
  },
  approval: "normal-plan-approval" as const,
  reason,
});

const preparationResult = (
  result: OperatorPublicResult,
  input: HostedRuntimeInput,
  inputValidated: boolean,
) => {
  if (result.code === "gateway_delivery_failed") {
    return {
      ...result,
      nextAction: preparationPlanningAction(
        input,
        "The native Gateway build failed. Plan again in this session using the current trusted source. Prepare the returned plan through the existing approval flow: an identical operation retains its durable approval, while a changed plan requires ordinary approval. Keep the existing resources.",
      ),
    };
  }
  if (!inputValidated || result.status !== "blocked" || result.code !== "operator_unavailable") {
    return result;
  }
  if (
    input.plan.stage === "auth-bootstrap" &&
    input.plan.gatewayBindings?.trustedSources !== undefined
  ) {
    return {
      ...result,
      nextAction: preparationPlanningAction(
        input,
        "The approved Auth bootstrap includes legacy host-owned protection settings. Plan again in this session to discover the supported prerequisite, then prepare the returned plan through the existing approval flow. A changed plan requires ordinary approval. Keep the existing resources and reconcile any unknown effect outcome before retrying it.",
      ),
    };
  }
  return result;
};

// oxlint-disable-next-line eslint/complexity -- Legacy readiness and participant preflight retain their separate approval-bound identity handoffs.
export const prepareHostedRuntimeWithOperator = async (
  input: HostedRuntimeInput,
  ctx: HostedRuntimeContext,
  operator: HostedOperatorClient,
  retain: (selection: PreparedRuntimeSelection) => void,
  contract: HostedRuntimeContract,
) => {
  const { createResourceMismatch, digest, isOperatorError, sameSelection } = contract;
  const participantPlan =
    input.plan.stage === "auth-participants" && input.plan.normalActorProgram !== undefined;
  let identityRequested = false;
  let inputValidated = false;
  let stage: RuntimePreparationStage = "input_validation";
  const requestIdentity = async () => {
    identityRequested = true;
    stage = "identity_read";
    return await operator.authIdentityInput(
      {
        action: "auth-identity-input",
        operationRef: input.operationRef,
        selection: input.plan.selection,
      },
      ctx.abortSignal,
    );
  };
  try {
    const { plan } = input;
    const selection = {
      appId: input.appId,
      branch: input.branch,
      environment: input.environment,
      projectId: input.projectId,
      sessionId: operator.sessionId ?? ctx.session.id,
    };
    if (
      plan.action !== "prepare" ||
      digest(plan) !== input.planDigest ||
      !sameSelection(plan.selection, selection)
    ) {
      throw createResourceMismatch();
    }
    inputValidated = true;
    stage = "operator_execute";
    const result = await operator.request(
      {
        action: "execute",
        callId: ctx.callId,
        operationRef: input.operationRef,
        planDigest: input.planDigest,
        selection,
      },
      ctx.abortSignal,
    );
    stage = "result_mapping";
    if (
      result.operationRef !== undefined &&
      ["prepared", "pending", "auth-schema-prepared", "participants-prepared"].includes(
        result.status,
      )
    ) {
      retain({
        appId: input.appId,
        branch: input.branch,
        operationRef: result.operationRef,
        planDigest: input.planDigest,
        projectId: input.projectId,
        sessionId: operator.sessionId ?? ctx.session.id,
      });
    }
    const legacyIdentityMissing =
      result.status === "auth-schema-prepared" && plan.normalActorProgram === undefined;
    const participantIdentityMissing =
      participantPlan && result.status === "blocked" && result.code === "auth_identity_required";
    const needsIdentity = legacyIdentityMissing || participantIdentityMissing;
    const identityInput = needsIdentity ? await requestIdentity() : null;
    return { identityInput, result: preparationResult(result, input, inputValidated) };
  } catch (error) {
    reportCaughtPreparationFailure(contract, stage, error);
    const result: OperatorPublicResult = {
      appId: input.appId,
      authenticatedBehavior: "unassessed" as const,
      code: isOperatorError(error) ? error.code : "operator_unavailable",
      status: "blocked" as const,
    };
    if (participantPlan && result.code === "auth_identity_required" && !identityRequested) {
      try {
        return { identityInput: await requestIdentity(), result };
      } catch (identityError) {
        return {
          identityInput: null,
          result: {
            ...result,
            code: isOperatorError(identityError) ? identityError.code : "operator_unavailable",
          },
        };
      }
    }
    return { identityInput: null, result: preparationResult(result, input, inputValidated) };
  }
};

// eslint-disable-next-line eslint/func-style, eslint/no-use-before-define -- Workflow SDK requires a hoisted top-level step declaration.
export async function prepareHostedRuntimeStep(
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowStepToolContext,
  options?: HostedRuntimeApprovalReadOptions,
) {
  "use step";
  let isHostedOperatorError = noHostedOperatorError;
  let stage: RuntimePreparationStage = "module_loading";
  let diagnostic:
    | {
        reportRuntimePreparationFailure: typeof reportRuntimePreparationFailure;
        reportRuntimePreparationStarted: typeof reportRuntimePreparationStarted;
      }
    | undefined;
  const blockedPreparation = (error: Error) => ({
    identityInput: null,
    result: {
      appId: input.appId,
      authenticatedBehavior: "unassessed" as const,
      code: isHostedOperatorError(error) ? error.code : "operator_unavailable",
      status: "blocked" as const,
    },
  });

  try {
    diagnostic = await import("../provisioning/hosted-operator-consent-diagnostic");
    diagnostic.reportRuntimePreparationStarted(ctx.session.id, stage);
    const [clientModule, contract, state, priorApprovalModule] = await Promise.all([
      import("../../lib/provisioning/hosted-operator-client"),
      import("../../lib/provisioning/hosted-operator-contract"),
      import("../../lib/agent/prepared-runtime-selection"),
      import("../../lib/agent/hosted-runtime-prior-approval"),
    ]);
    isHostedOperatorError = (error): error is HostedOperatorErrorType =>
      error instanceof contract.HostedOperatorError;
    stage = "input_validation";
    const approvalInput = priorApprovalModule.hostedRuntimePreparationInputSchema.parse(input);
    stage = "client_resolution";
    const operator = await clientModule.hostedOperatorClientForSession(
      ctx.session.auth,
      ctx.session.id,
    );
    stage = "prior_approval";
    const retainedApproval = await priorApprovalModule.readHostedRuntimeExecutionApproval(
      approvalInput,
      ctx,
      operator,
      options,
    );
    stage = "operator_execute";
    return await prepareHostedRuntimeWithOperator(
      approvalInput,
      { ...ctx, callId: retainedApproval?.callId ?? ctx.callId },
      operator,
      (selection) => {
        state.preparedRuntimeSelections.update((selections) => ({
          ...selections,
          [approvalInput.appId]: selection,
        }));
      },
      {
        createResourceMismatch: () => new contract.HostedOperatorError("resource_mismatch"),
        digest: contract.operatorPlanDigest,
        isOperatorError: (error): error is HostedOperatorErrorType =>
          error instanceof contract.HostedOperatorError,
        sameSelection: (left, right) => contract.sameOperatorSelection(left, right),
        onFailure: (failureStage, error) =>
          diagnostic?.reportRuntimePreparationFailure(ctx.session.id, failureStage, error),
      },
    );
  } catch (error) {
    diagnostic?.reportRuntimePreparationFailure(ctx.session.id, stage, error);
    return blockedPreparation(
      error instanceof Error ? error : new Error("Unknown hosted runtime preparation failure"),
    );
  }
}
