import { isDeepStrictEqual } from "node:util";

import { createNativeTargetOnboardingRuntime } from "../agent/native-target-onboarding-runtime";
import type {
  NativeTargetCapturedRelease,
  NativeTargetPlanRequest,
} from "../agent/native-target-onboarding-runtime";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import { HostedOperatorError } from "./hosted-operator-contract";
import { HostedSessionReadTimeoutError } from "../eve/hosted-session-read-timeout-error";
import { reportHostedOperatorNativeFailure } from "./hosted-operator-native-diagnostic";
import type { HostedOperatorNativeFailureStage } from "./hosted-operator-native-diagnostic";
import {
  nativeTargetOnboardingApprovalSchema,
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingRegistryId,
} from "./native-target-onboarding-contract";
import type {
  NativeTargetOnboardingPlan,
  NativeTargetOnboardingApproval,
  NativeTargetOnboardingRecord,
} from "./native-target-onboarding-contract";
import { createNativeTargetOnboardingRegistry } from "./native-target-onboarding-store";
import type {
  NativeTargetCurrentOwner,
  NativeTargetOnboardingStore,
} from "./native-target-onboarding-store";
import { nativeTargetTransportResponseSchemas } from "./native-target-onboarding-transport";
import type {
  NativeTargetTransportRequest,
  NativeTargetTransportResponse,
} from "./native-target-onboarding-transport";
import type {
  NativeTargetVercelProjectCreation,
  NativeTargetVercelProjectObservation,
} from "./native-target-vercel-provider";

type Invocation = NativeTargetTransportRequest;
type Current = NativeTargetCurrentOwner & { historyOwner: OperatorOwnerContext };

export interface NativeTargetOnboardingServiceDependencies {
  store: NativeTargetOnboardingStore;
  verifyWorkload: (request: Request) => Promise<void>;
  /** Rechecks the canonical session, tenant membership, and app linkage on every journal call. */
  authorize: (request: Request, input: Invocation) => Promise<Current>;
  readCapturedRelease: (
    owner: Current,
    appId: string,
    appSpecDigest: string,
  ) => Promise<NativeTargetCapturedRelease>;
  resolvePlan: (
    owner: Current,
    proposal: NativeTargetPlanRequest,
    source: { appSpecDigest: string; captured: NativeTargetCapturedRelease },
  ) => Promise<NativeTargetOnboardingPlan>;
  readApproval: (
    owner: Current,
    record: NativeTargetOnboardingRecord,
    callId: string | undefined,
    workload: { authorization: string | null; signal: AbortSignal },
  ) => Promise<NativeTargetOnboardingApproval | null>;
  createProject: (input: {
    owner: Current;
    plan: NativeTargetOnboardingPlan;
    name: string;
    authorizeAttempt: () => Promise<void>;
    acceptProjectId: (projectId: string) => Promise<void>;
  }) => Promise<NativeTargetVercelProjectCreation>;
  observeProject: (input: {
    owner: Current;
    plan: NativeTargetOnboardingPlan;
    name: string;
    projectId: string;
  }) => Promise<NativeTargetVercelProjectObservation>;
}

const readApprovalResult = (value: NativeTargetOnboardingApproval | null) =>
  value === null ? null : nativeTargetOnboardingApprovalSchema.parse(value);

const denied = () => new HostedOperatorError("authorization_required");
const mismatch = () => new HostedOperatorError("resource_mismatch");

/** A static deployment target already owns this app slot; use its normal target resolver. */
export class NativeTargetExistingConfiguredTargetError extends Error {
  constructor() {
    super("native_target_existing_configured_target");
    this.name = "NativeTargetExistingConfiguredTargetError";
  }
}

const observeNativePlan = async <T>(
  enabled: boolean,
  stage: HostedOperatorNativeFailureStage,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (enabled && !(error instanceof NativeTargetExistingConfiguredTargetError)) {
      try {
        reportHostedOperatorNativeFailure(stage, error);
      } catch {
        // A diagnostic failure cannot alter the original operation.
      }
    }
    throw error;
  }
};

/** A side-effect-free peek may report pending while its durable tail is incomplete. */
const peekNativeApproval = async (
  signal: AbortSignal,
  read: () => Promise<NativeTargetOnboardingApproval | null>,
): Promise<NativeTargetOnboardingApproval | null> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof HostedSessionReadTimeoutError) {
      signal.throwIfAborted();
      return null;
    }
    throw error;
  }
};

/** The native transport carries only hints. Every action resolves the same current owner again. */
export const createNativeTargetOnboardingService =
  (deps: NativeTargetOnboardingServiceDependencies) =>
  async (request: Request, input: Invocation): Promise<Response> => {
    const workloadHeaders = new Headers(request.headers);
    const isPlan = input.action === "native-target-plan";
    await observeNativePlan(isPlan, "native_plan_workload", () =>
      deps.verifyWorkload(new Request(request.url, { headers: workloadHeaders })),
    );
    const workload = {
      authorization: workloadHeaders.get("authorization"),
      signal: request.signal,
    };
    const owner = await observeNativePlan(isPlan, "native_plan_owner", () =>
      deps.authorize(request, input),
    );
    const ownerMatches = [
      owner.adapterSessionId === input.adapterSessionId,
      owner.publicSessionId === input.ownerContext.sessionId,
      owner.adapterGeneration === input.ownerContext.adapterGeneration,
      isDeepStrictEqual(owner.historyOwner, input.ownerContext),
      isDeepStrictEqual(owner.authority, input.ownerContext.authority),
    ].every(Boolean);
    if (!ownerMatches) {
      throw denied();
    }
    const authorize = async (invocation: Invocation, appId: string) => {
      if (invocation !== input || appId !== input.input.appId) {
        throw denied();
      }
      const current = await observeNativePlan(isPlan, "native_plan_owner", () =>
        deps.authorize(request, input),
      );
      if (!isDeepStrictEqual(current, owner)) {
        throw denied();
      }
      return current;
    };
    const registry = createNativeTargetOnboardingRegistry<Invocation>({
      store: deps.store,
      authorize,
      assertPlanOrigin: async (current, plan) => {
        const trusted = await observeNativePlan(isPlan, "native_plan_captured_release", () =>
          deps.readCapturedRelease(owner, plan.appId, plan.origin.appSpecDigest),
        );
        if (
          !isDeepStrictEqual(trusted.release, plan.origin.release) ||
          plan.origin.publicSessionId !== current.publicSessionId ||
          plan.origin.adapterSessionId !== current.adapterSessionId ||
          plan.origin.adapterGeneration !== current.adapterGeneration
        ) {
          throw mismatch();
        }
      },
      readApproval: async (_current, record) =>
        readApprovalResult(
          await deps.readApproval(
            await authorize(input, record.appId),
            record,
            input.callId,
            workload,
          ),
        ),
    });
    const runtime = createNativeTargetOnboardingRuntime({
      readCapturedRelease: async (_ctx, appId, retainedPlan) => {
        if (input.action !== "native-target-plan") {
          throw mismatch();
        }
        if (retainedPlan !== undefined) {
          const row = await observeNativePlan(isPlan, "native_plan_registry_read", () =>
            registry.read(input, appId),
          );
          if (
            input.input.resourceProfileId === undefined ||
            row?.record.stage !== "planned" ||
            row.record.previousAttempts.length !== 0 ||
            row.record.planDigest !== nativeTargetOnboardingPlanDigest(retainedPlan)
          ) {
            throw mismatch();
          }
          return await observeNativePlan(isPlan, "native_plan_captured_release", () =>
            deps.readCapturedRelease(owner, appId, row.record.plan.origin.appSpecDigest),
          );
        }
        if (input.selectedApp === undefined) {
          throw denied();
        }
        const selected = input.selectedApp;
        return await observeNativePlan(isPlan, "native_plan_captured_release", () =>
          deps.readCapturedRelease(owner, appId, selected.appSpecDigest),
        );
      },
      resolvePlan: async (_ctx, proposal, source) =>
        await observeNativePlan(isPlan, "native_plan_profile_resolution", () =>
          deps.resolvePlan(owner, proposal, source),
        ),
      journal: {
        supersedePlannedScope: async (_ctx, plan, expectedPlanDigest) =>
          await observeNativePlan(isPlan, "native_plan_supersede", () =>
            registry.supersedePlannedScope(input, plan, expectedPlanDigest),
          ),
        read: async (_ctx, appId) =>
          await observeNativePlan(isPlan, "native_plan_registry_read", () =>
            registry.read(input, appId),
          ),
        reservePlan: async (_ctx, plan) => await registry.reservePlan(input, plan),
        recordApproval: async (_ctx, appId) => await registry.recordApproval(input, appId),
        claimAttempt: async (_ctx, appId, attempt) =>
          await registry.claimAttempt(input, appId, attempt),
        authorizeAttempt: async (_ctx, appId, attemptId, leaseId) => {
          await registry.authorizeAttempt(input, appId, attemptId, leaseId);
        },
        acceptProjectId: async (_ctx, appId, leaseId, accepted) =>
          await registry.acceptProjectId(input, appId, leaseId, accepted),
        recordUnknown: async (_ctx, appId, attemptId) =>
          await registry.recordUnknown(input, appId, attemptId),
        recordNotCreated: async (_ctx, appId, attemptId, reason) =>
          await registry.recordNotCreated(input, appId, attemptId, reason),
        recordReady: async (_ctx, appId, proof) => await registry.recordReady(input, appId, proof),
      },
      authorizeApprovalResponse: () => Promise.reject(denied()),
      readSettledApproval: async (_ctx, prepared) => {
        const row = await registry.read(input, prepared.appId);
        if (row === undefined || row.requestId !== prepared.operationRef) {
          throw mismatch();
        }
        return readApprovalResult(
          await deps.readApproval(
            await authorize(input, prepared.appId),
            row.record,
            input.callId,
            workload,
          ),
        );
      },
      createProject: async (_ctx, dispatch) => {
        const current = await authorize(input, dispatch.plan.appId);
        return await deps.createProject({
          owner: current,
          plan: dispatch.plan,
          name: dispatch.candidateName,
          authorizeAttempt: dispatch.authorizeAttempt,
          acceptProjectId: dispatch.acceptProjectId,
        });
      },
      observeProject: async (_ctx, observation) =>
        await deps.observeProject({
          owner: await authorize(input, observation.plan.appId),
          plan: observation.plan,
          name: observation.candidateName,
          projectId: observation.projectId,
        }),
    });
    const context = {
      session: { id: input.adapterSessionId, auth: null },
      callId: input.callId,
      abortSignal: request.signal,
    };
    let output: NativeTargetTransportResponse;
    switch (input.action) {
      case "native-target-plan": {
        try {
          output = await observeNativePlan(isPlan, "native_plan_dispatch", () =>
            runtime.plan(input.input, context, {
              phase: "planned",
              ...(input.selectedApp === undefined
                ? {}
                : {
                    appSpec: {
                      appId: input.selectedApp.appId,
                      digest: input.selectedApp.appSpecDigest,
                    },
                  }),
            }),
          );
        } catch (error) {
          if (error instanceof NativeTargetExistingConfiguredTargetError) {
            return Response.json(
              {
                code: "native_target_existing_configured_target",
                nextAction: "resolve-preview-target",
              },
              { status: 409, headers: { "cache-control": "private, no-store" } },
            );
          }
          throw error;
        }
        break;
      }
      case "native-target-prepare": {
        output = await runtime.prepare(input.input, context);
        break;
      }
      case "native-target-approval-read": {
        const row = await registry.read(input, input.input.appId);
        if (
          row === undefined ||
          row.requestId !== input.input.operationRef ||
          row.record.planDigest !== input.input.planDigest ||
          nativeTargetOnboardingPlanDigest(row.record.plan) !== input.input.planDigest
        ) {
          throw mismatch();
        }
        const proof = await peekNativeApproval(request.signal, () =>
          deps.readApproval(owner, row.record, input.callId, workload),
        );
        if (proof === null) {
          output = { status: "pending" };
        } else if (proof.outcome === "approved") {
          output = { status: "approved", proof: { ...proof, outcome: "approved" } };
        } else {
          output = { status: "cancelled", proof: { ...proof, outcome: "cancelled" } };
        }
        break;
      }
      case "native-target-approval-candidate": {
        const row = await registry.read(input, input.input.appId);
        const candidateMatches =
          row !== undefined &&
          [
            row.requestId === nativeTargetOnboardingRegistryId(owner.authority, input.input.appId),
            row.requestId === input.input.operationRef,
            row.record.planDigest === input.input.planDigest,
            input.candidate.responder.principalId === owner.authority.ownerUserId,
          ].every(Boolean);
        if (!candidateMatches) {
          throw mismatch();
        }
        output = { status: "allowed" };
        break;
      }
      default: {
        throw mismatch();
      }
    }
    return Response.json(nativeTargetTransportResponseSchemas[input.action].parse(output), {
      headers: { "cache-control": "private, no-store" },
    });
  };
