import type { WorkflowStepToolContext } from "eve/tools";
import type {
  HostedOperatorError as HostedOperatorErrorType,
  HostedOperatorPlan,
  OperatorSelection,
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
}

type HostedOperatorErrorClassifier = (value: unknown) => value is HostedOperatorErrorType;
const noHostedOperatorError: HostedOperatorErrorClassifier = (
  _value: unknown,
): _value is HostedOperatorErrorType => false;

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
  const requestIdentity = async () => {
    identityRequested = true;
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
    return { identityInput, result };
  } catch (error) {
    const result = {
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
    return { identityInput: null, result };
  }
};

// eslint-disable-next-line eslint/func-style, eslint/no-use-before-define -- Workflow SDK requires a hoisted top-level step declaration.
export async function prepareHostedRuntimeStep(
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  let isHostedOperatorError = noHostedOperatorError;
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
    const [clientModule, contract, state, priorApprovalModule] = await Promise.all([
      import("../../lib/provisioning/hosted-operator-client"),
      import("../../lib/provisioning/hosted-operator-contract"),
      import("../../lib/agent/prepared-runtime-selection"),
      import("../../lib/agent/hosted-runtime-prior-approval"),
    ]);
    isHostedOperatorError = (error): error is HostedOperatorErrorType =>
      error instanceof contract.HostedOperatorError;
    const approvalInput = priorApprovalModule.hostedRuntimePreparationInputSchema.parse(input);
    const operator = await clientModule.hostedOperatorClientForSession(
      ctx.session.auth,
      ctx.session.id,
    );
    const retainedApproval = await priorApprovalModule.readHostedRuntimePriorApproval(
      approvalInput,
      ctx,
      operator,
    );
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
      },
    );
  } catch (error) {
    return blockedPreparation(
      error instanceof Error ? error : new Error("Unknown hosted runtime preparation failure"),
    );
  }
}
