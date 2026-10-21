import { randomUUID } from "node:crypto";
import type { ApprovalResponseContext } from "eve/tools/approval";
import type { AppDescription } from "../repository/app-description";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  nativeTargetPlanRequestSchema,
  nativeTargetPreparationRequestSchema,
} from "./native-target-onboarding-input-schema";
import type {
  NativeTargetPlanRequest,
  NativeTargetPreparationRequest,
  NativeTargetOnboardingResult,
} from "./native-target-onboarding-input-schema";
import {
  nativeTargetOnboardingApprovalSchema,
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
} from "../provisioning/native-target-onboarding-contract";
import type {
  NativeTargetNoCreationReason,
  NativeTargetOnboardingApproval,
  NativeTargetOnboardingAttempt,
  NativeTargetOnboardingPlan,
  NativeTargetOnboardingCreationProof,
} from "../provisioning/native-target-onboarding-contract";
import type { NativeTargetOnboardingRow } from "../provisioning/native-target-onboarding-store";
import type {
  NativeTargetVercelProjectCreation,
  NativeTargetVercelProjectObservation,
} from "../provisioning/native-target-vercel-provider";

export {
  nativeTargetPlanRequestSchema,
  nativeTargetPreparationRequestSchema,
  nativeTargetOnboardingResultSchema,
} from "./native-target-onboarding-input-schema";
export type {
  NativeTargetPlanRequest,
  NativeTargetPreparationRequest,
  NativeTargetOnboardingResult,
} from "./native-target-onboarding-input-schema";
export interface NativeTargetSelectedAppState {
  phase: AppBuilderWorkflowState["phase"];
  appSpec?: { appId: string; digest: string };
}
export interface NativeTargetInvocation {
  session: { id: string; auth: unknown };
  callId: string;
  abortSignal: AbortSignal;
}
export interface NativeTargetCapturedRelease {
  description: AppDescription;
  release: NativeTargetOnboardingPlan["origin"]["release"];
}

/** All ports are private server capabilities; none are constructed from tool input. */
export type NativeTargetNonCreationReason = NativeTargetNoCreationReason;
const nonCreationReason = {
  collision: "name_conflict",
  permission_denied: "provider_permission_denied",
  provider_rejected: "provider_validation_failed",
  rate_limited: "provider_rate_limited",
  authorization_denied: "not_dispatched",
} as const;
export interface NativeTargetOnboardingRuntimePorts {
  /** Reauthorizes current owner/app and reads captured immutable release metadata. */
  readCapturedRelease: (
    ctx: NativeTargetInvocation,
    appId: string,
  ) => Promise<NativeTargetCapturedRelease>;
  /** Resolves provider grant, native Neon approval, worker, costs and retention from trusted state. */
  resolvePlan: (
    ctx: NativeTargetInvocation,
    proposal: NativeTargetPlanRequest,
    source: {
      appSpecDigest: string;
      captured: NativeTargetCapturedRelease;
    },
  ) => Promise<NativeTargetOnboardingPlan>;
  /** Each journal operation independently verifies current owner/app authority. */
  journal: {
    read: (
      ctx: NativeTargetInvocation,
      appId: string,
    ) => Promise<NativeTargetOnboardingRow | undefined>;
    reservePlan: (
      ctx: NativeTargetInvocation,
      plan: NativeTargetOnboardingPlan,
    ) => Promise<NativeTargetOnboardingRow>;
    recordApproval: (
      ctx: NativeTargetInvocation,
      appId: string,
    ) => Promise<NativeTargetOnboardingRow>;
    claimAttempt: (
      ctx: NativeTargetInvocation,
      appId: string,
      attempt: NativeTargetOnboardingAttempt,
    ) => Promise<NativeTargetOnboardingRow>;
    authorizeAttempt: (
      ctx: NativeTargetInvocation,
      appId: string,
      attemptId: string,
      leaseId: string,
    ) => Promise<void>;
    acceptProjectId: (
      ctx: NativeTargetInvocation,
      appId: string,
      leaseId: string,
      accepted: {
        attemptId: string;
        projectId: string;
        acceptedAt: string;
      },
    ) => Promise<NativeTargetOnboardingRow>;
    recordUnknown: (
      ctx: NativeTargetInvocation,
      appId: string,
      attemptId: string,
    ) => Promise<NativeTargetOnboardingRow>;
    recordNotCreated: (
      ctx: NativeTargetInvocation,
      appId: string,
      attemptId: string,
      reason: NativeTargetNonCreationReason,
    ) => Promise<NativeTargetOnboardingRow>;
    recordReady: (
      ctx: NativeTargetInvocation,
      appId: string,
      proof: NativeTargetOnboardingCreationProof,
    ) => Promise<NativeTargetOnboardingRow>;
  };
  /** Verifies the actual authenticated Eve response; a candidate is not terminal approval. */
  authorizeApprovalResponse: (
    ctx: ApprovalResponseContext<NativeTargetPreparationRequest>,
  ) => Promise<void>;
  /** Reads independently committed native human settlement; never accepts model approval fields. */
  readSettledApproval: (
    ctx: NativeTargetInvocation,
    request: NativeTargetPreparationRequest,
  ) => Promise<NativeTargetOnboardingApproval | null>;
  createProject: (
    ctx: NativeTargetInvocation,
    input: {
      plan: NativeTargetOnboardingPlan;
      candidateName: string;
      authorizeAttempt: () => Promise<void>;
      acceptProjectId: (projectId: string) => Promise<void>;
    },
  ) => Promise<NativeTargetVercelProjectCreation>;
  observeProject: (
    ctx: NativeTargetInvocation,
    input: {
      plan: NativeTargetOnboardingPlan;
      candidateName: string;
      projectId: string;
    },
  ) => Promise<NativeTargetVercelProjectObservation>;
  now?: () => Date;
  uuid?: () => string;
}

const invalid = () => new Error("native_target_onboarding_mismatch");
const envelope = (row: NativeTargetOnboardingRow): NativeTargetPreparationRequest => ({
  appId: row.appId,
  operationRef: row.requestId,
  planDigest: row.record.planDigest,
  plan: structuredClone(row.record.plan),
});
const publicStatus = (stage: NativeTargetOnboardingRow["record"]["stage"]) => {
  if (stage === "ready" || stage === "cancelled" || stage === "planned") {
    return stage;
  }
  return "pending" as const;
};
const publicResult = (row: NativeTargetOnboardingRow) => ({
  ...envelope(row),
  status: publicStatus(row.record.stage),
  ...(row.record.stage === "ready"
    ? { projectId: row.record.registration.observed.projectId }
    : {}),
});

/** Source provenance is checked at planning; later execution resumes the frozen operation. */
export const createNativeTargetOnboardingRuntime = (ports: NativeTargetOnboardingRuntimePorts) => {
  const now = ports.now ?? (() => new Date());
  const uuid = ports.uuid ?? randomUUID;
  const readExact = async (raw: NativeTargetPreparationRequest, ctx: NativeTargetInvocation) => {
    ctx.abortSignal.throwIfAborted();
    const input = nativeTargetPreparationRequestSchema.parse(raw);
    if (
      input.appId !== input.plan.appId ||
      nativeTargetOnboardingPlanDigest(input.plan) !== input.planDigest
    ) {
      throw invalid();
    }
    const row = await ports.journal.read(ctx, input.appId);
    if (row === undefined) {
      throw invalid();
    }
    if (
      ![
        row.requestId === input.operationRef,
        row.appId === input.appId,
        row.record.planDigest === input.planDigest,
        nativeTargetOnboardingPlanDigest(row.record.plan) === input.planDigest,
      ].every(Boolean)
    ) {
      throw invalid();
    }
    ctx.abortSignal.throwIfAborted();
    return row;
  };
  const readTerminalApproval = async (
    input: NativeTargetPreparationRequest,
    ctx: NativeTargetInvocation,
    row: NativeTargetOnboardingRow,
  ) => {
    const raw = await ports.readSettledApproval(ctx, input);
    if (raw === null) {
      return null;
    }
    const receipt = nativeTargetOnboardingApprovalSchema.parse(raw);
    if (
      (row.record.priorCancellations ?? []).some(
        (prior) =>
          prior.approval.requestId === receipt.requestId ||
          prior.approval.callId === receipt.callId,
      )
    ) {
      return null;
    }

    if (
      ![
        receipt.planDigest === input.planDigest,
        receipt.publicSessionId === input.plan.origin.publicSessionId,
        receipt.responderPrincipalId === row.authority.ownerUserId,
      ].every(Boolean)
    ) {
      throw invalid();
    }
    return receipt;
  };
  const settleObservation = async (
    ctx: NativeTargetInvocation,
    row: NativeTargetOnboardingRow,
    observed: NativeTargetVercelProjectObservation,
  ) => {
    const record = row.record;
    if (!("attempt" in record)) {
      throw invalid();
    }
    if (observed.status !== "verified") {
      return publicResult(
        await ports.journal.recordUnknown(ctx, row.appId, record.attempt.attemptId),
      );
    }
    return publicResult(
      await ports.journal.recordReady(ctx, row.appId, {
        attemptId: record.attempt.attemptId,
        observed: {
          projectId: observed.projectId,
          name: observed.name,
          teamId: observed.scopeId,
          installationId: record.plan.project.installationId,
          projectSettings: observed.settings,
          protection: observed.protection,
        },
        observedAt: now().toISOString(),
      }),
    );
  };
  const nextCandidate = (record: NativeTargetOnboardingRow["record"]) => {
    const previous = record.previousAttempts.at(-1);
    if (previous?.reason !== "name_conflict") {
      return previous?.candidateName ?? record.plan.project.name;
    }
    if (record.plan.conflictPolicy === "stop-on-conflict") {
      return null;
    }
    return `${record.plan.project.name.slice(0, 93).replace(/-+$/u, "")}-${uuid().replaceAll("-", "").slice(0, 6)}`;
  };
  const runAttempt = async (
    ctx: NativeTargetInvocation,
    initial: NativeTargetOnboardingRow,
    candidateName: string,
  ) => {
    let row = initial;
    const { record } = row;
    const started = now();
    const attempt: NativeTargetOnboardingAttempt = {
      attemptId: uuid(),
      leaseId: uuid(),
      candidateName,
      startedAt: started.toISOString(),
      leaseExpiresAt: new Date(started.getTime() + 300_000).toISOString(),
    };
    ctx.abortSignal.throwIfAborted();
    row = await ports.journal.claimAttempt(ctx, record.appId, attempt);
    let result: NativeTargetVercelProjectCreation;
    try {
      result = await ports.createProject(ctx, {
        plan: record.plan,
        candidateName,
        authorizeAttempt: async () => {
          ctx.abortSignal.throwIfAborted();
          await ports.journal.authorizeAttempt(
            ctx,
            record.appId,
            attempt.attemptId,
            attempt.leaseId,
          );
        },
        acceptProjectId: async (projectId) => {
          await ports.journal.acceptProjectId(ctx, record.appId, attempt.leaseId, {
            attemptId: attempt.attemptId,
            projectId,
            acceptedAt: now().toISOString(),
          });
        },
      });
    } catch {
      return publicResult(await ports.journal.recordUnknown(ctx, record.appId, attempt.attemptId));
    }
    if (result.status === "rejected") {
      const retired = await ports.journal.recordNotCreated(
        ctx,
        record.appId,
        attempt.attemptId,
        nonCreationReason[result.reason],
      );
      return { ...publicResult(retired), status: "blocked" as const, reason: result.reason };
    }
    if (result.status !== "verified") {
      return publicResult(await ports.journal.recordUnknown(ctx, record.appId, attempt.attemptId));
    }
    return await settleObservation(ctx, row, result);
  };
  return {
    async plan(
      raw: NativeTargetPlanRequest,
      ctx: NativeTargetInvocation,
      state: NativeTargetSelectedAppState,
    ): Promise<NativeTargetOnboardingResult> {
      ctx.abortSignal.throwIfAborted();
      const proposal = nativeTargetPlanRequestSchema.parse(raw);
      if (state.appSpec === undefined || state.appSpec.appId !== proposal.appId) {
        throw invalid();
      }
      // Read retained operations first: source edits do not redefine their resource authority.
      const retained = await ports.journal.read(ctx, proposal.appId);
      if (retained !== undefined && retained.record.stage !== "cancelled") {
        return publicResult(retained);
      }
      const captured = await ports.readCapturedRelease(ctx, proposal.appId);
      const { description } = captured;
      if (
        description.app.id !== proposal.appId ||
        description.backend.kind !== "generated-postgres" ||
        description.backend.release.id !== captured.release.id ||
        description.backend.release.artifactHash !== `sha256:${captured.release.schemaSha256}`
      ) {
        throw invalid();
      }
      const plan = nativeTargetOnboardingPlanSchema.parse(
        await ports.resolvePlan(ctx, proposal, {
          appSpecDigest: state.appSpec.digest,
          captured,
        }),
      );
      const matches = [
        plan.appId === proposal.appId,
        plan.origin.appSpecDigest === state.appSpec.digest,
        JSON.stringify([...plan.productRoles].toSorted()) ===
          JSON.stringify([...description.backend.roles].toSorted()),
        plan.origin.release.id === captured.release.id,
        plan.origin.release.artifactRef === captured.release.artifactRef,
        plan.origin.release.manifestSha256 === captured.release.manifestSha256,
        plan.origin.release.schemaSha256 === captured.release.schemaSha256,
        plan.project.name === proposal.project.name,
        plan.project.teamId === proposal.project.teamId,
        plan.project.installationId === proposal.project.installationId,
        plan.branch === proposal.branch,
        plan.conflictPolicy === proposal.conflictPolicy,
        nativeTargetOnboardingPlanDigest({
          ...plan,
          project: { ...proposal.project, protection: plan.project.protection },
        }) === nativeTargetOnboardingPlanDigest(plan),
      ].every(Boolean);
      if (!matches) {
        throw invalid();
      }
      ctx.abortSignal.throwIfAborted();
      return publicResult(await ports.journal.reservePlan(ctx, plan));
    },
    async hasApproval(input: NativeTargetPreparationRequest, ctx: NativeTargetInvocation) {
      const row = await readExact(input, ctx);
      if (
        row.record.stage === "cancelled" ||
        ("cancelledBy" in row.record && row.record.cancelledBy !== undefined)
      ) {
        throw invalid();
      }
      const terminal = await readTerminalApproval(input, ctx, row);
      if (terminal?.outcome === "cancelled") {
        throw invalid();
      }
      return terminal !== null;
    },
    async authorizeApprovalResponse(ctx: ApprovalResponseContext<NativeTargetPreparationRequest>) {
      if (
        ctx.request.toolName !== "prepare-app-native-target" ||
        ctx.request.toolInput === undefined
      ) {
        throw invalid();
      }
      const input = nativeTargetPreparationRequestSchema.parse(ctx.request.toolInput);
      if (
        input.appId !== input.plan.appId ||
        nativeTargetOnboardingPlanDigest(input.plan) !== input.planDigest
      ) {
        throw invalid();
      }
      await ports.authorizeApprovalResponse(ctx);
    },
    async prepare(
      input: NativeTargetPreparationRequest,
      ctx: NativeTargetInvocation,
    ): Promise<NativeTargetOnboardingResult> {
      let row = await readExact(input, ctx);
      if (
        row.record.stage === "cancelled" ||
        ("cancelledBy" in row.record && row.record.cancelledBy !== undefined)
      ) {
        return publicResult(row);
      }
      const terminal = await readTerminalApproval(input, ctx, row);
      if (terminal === null) {
        return { ...publicResult(row), status: "approval-pending" as const };
      }
      row = await ports.journal.recordApproval(ctx, input.appId);
      if (terminal.outcome === "cancelled") {
        return publicResult(row);
      }
      if (row.record.stage === "ready" || row.record.stage === "cancelled") {
        return publicResult(row);
      }
      if (row.record.stage === "creating" || row.record.stage === "unknown") {
        if (row.record.acceptedCreation === undefined) {
          return publicResult(row);
        }
        // An accepted ID permits GET reconciliation only, never another POST.
        return await settleObservation(
          ctx,
          row,
          await ports.observeProject(ctx, {
            plan: row.record.plan,
            candidateName: row.record.attempt.candidateName,
            projectId: row.record.acceptedCreation.projectId,
          }),
        );
      }
      if (row.record.stage !== "approved") {
        throw invalid();
      }
      const candidate = nextCandidate(row.record);
      if (candidate === null) {
        return { ...publicResult(row), status: "blocked" as const, reason: "collision" as const };
      }
      const result = await runAttempt(ctx, row, candidate);
      if (
        result.status !== "blocked" ||
        result.reason !== "collision" ||
        row.record.plan.conflictPolicy !== "suffix-on-confirmed-conflict"
      ) {
        return result;
      }
      // Only confirmed collision evidence permits a suffix. Other rejections retain their candidate.
      const retry = await readExact(input, ctx);
      if (retry.record.stage !== "approved") {
        return publicResult(retry);
      }
      const retryCandidate = `${retry.record.plan.project.name.slice(0, 93).replace(/-+$/u, "")}-${uuid().replaceAll("-", "").slice(0, 6)}`;
      return await runAttempt(ctx, retry, retryCandidate);
    },
  };
};
export type NativeTargetOnboardingRuntime = ReturnType<typeof createNativeTargetOnboardingRuntime>;

/** Optional trusted embedding override; production resolves its protected client per invocation. */
export type NativeTargetRuntimeResolutionContext =
  | Pick<NativeTargetInvocation, "session">
  | ApprovalResponseContext<NativeTargetPreparationRequest>;
export type NativeTargetOnboardingRuntimeResolver = (
  ctx: NativeTargetRuntimeResolutionContext,
) => Promise<NativeTargetOnboardingRuntime>;
let resolveRuntime: NativeTargetOnboardingRuntimeResolver | undefined;
export const configureNativeTargetOnboardingRuntime = (
  resolver: NativeTargetOnboardingRuntimeResolver,
) => {
  resolveRuntime = resolver;
};
export const nativeTargetOnboardingRuntimeForSession = async (
  ctx: NativeTargetRuntimeResolutionContext,
) => {
  if (resolveRuntime !== undefined) {
    return await resolveRuntime(ctx);
  }
  const { nativeTargetOnboardingClientForContext } =
    await import("./native-target-onboarding-client");
  return await nativeTargetOnboardingClientForContext(ctx);
};
