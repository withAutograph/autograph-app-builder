import type { WorkflowStepToolContext } from "eve/tools";
import type { PreparedApplicationReviewContext } from "./application-review-context-store";
import type { AppliedSourceReviewReference } from "./review-applied-product-source";
import type {
  ApplicationReviewContinuation,
  ApplicationReviewRoundResult,
  ApplicationSourceReviewOptions,
} from "./application-source-review";
import type { ProductSourceAssessment } from "./product-source-review";

type RequestDiagnostic =
  | Parameters<NonNullable<ApplicationSourceReviewOptions["onRequestStart"]>>[0]
  | Parameters<NonNullable<ApplicationSourceReviewOptions["onRequest"]>>[0]
  | Parameters<NonNullable<ApplicationSourceReviewOptions["onInvocation"]>>[0];
// oxlint-disable-next-line eslint/func-style -- Native Workflow steps require top-level async declarations.
export async function loadApplicationReviewContextStep(
  reference: AppliedSourceReviewReference,
  ctx: WorkflowStepToolContext,
): Promise<PreparedApplicationReviewContext> {
  "use step";
  const { sourceReviewContextStoreForSession } = await import("./source-review-journal-runtime");
  const store = await sourceReviewContextStoreForSession({
    appId: reference.appId,
    sessionAuth: ctx.session.auth,
    sessionId: ctx.session.id,
    abortSignal: ctx.abortSignal,
  });
  return await store.readContext(reference.contextRef);
}

// oxlint-disable-next-line eslint/func-style -- Native Workflow steps require top-level async declarations.
export async function applicationReviewRoundStep(
  reference: AppliedSourceReviewReference,
  continuation: ApplicationReviewContinuation | undefined,
  ctx: WorkflowStepToolContext,
  preparedContext?: PreparedApplicationReviewContext,
): Promise<
  ApplicationReviewRoundResult | { assessment: ProductSourceAssessment; continuation?: undefined }
> {
  "use step";
  const [runtime, reader, evidenceModule, engine, assessmentModule] = await Promise.all([
    import("./source-review-journal-runtime"),
    import("./application-review-sandbox-reader"),
    import("./application-review-evidence"),
    import("./application-source-review"),
    import("./product-source-review"),
  ]);
  const { sourceReviewJournalForSession } = runtime;
  const { createApplicationReviewSandboxReader } = reader;
  const { createApplicationReviewEvidence } = evidenceModule;
  const { assessApplicationSourceRound, applicationSourceReviewCacheSessionId } = engine;
  const { unavailableSourceAssessment } = assessmentModule;
  const owner = {
    appId: reference.appId,
    sessionAuth: ctx.session.auth,
    sessionId: ctx.session.id,
    abortSignal: ctx.abortSignal,
  };
  if (preparedContext === undefined) {
    throw new Error("Prepared source review context is unavailable.");
  }
  const prepared = preparedContext;
  if (prepared.appId !== reference.appId || prepared.parentSessionId !== ctx.session.id) {
    throw new Error("Prepared review belongs to another owner session or app.");
  }
  const reviewInput = { ...prepared.reviewInput, files: [] };
  const journal = await sourceReviewJournalForSession(owner);
  const assertCurrentOwner = async () => {
    ctx.abortSignal?.throwIfAborted();
    await journal.assertCurrentOwner();
    ctx.abortSignal?.throwIfAborted();
  };
  try {
    await assertCurrentOwner();
    const sandbox = await createApplicationReviewSandboxReader({
      sandboxName: prepared.sandboxName,
      abortSignal: ctx.abortSignal,
      assertCurrentOwner,
    });
    const evidence = createApplicationReviewEvidence({
      abortSignal: ctx.abortSignal,
      applyRoot: prepared.applyRoot,
      changedPaths: prepared.normalizedChanges.map((change) => change.path),
      observed: prepared.observed,
      reviewInput,
      sandbox,
      visiblePaths: prepared.visiblePaths,
      restoredSourceReads: continuation?.references.map(([, value]) => value),
    });
    const report = (event: string, detail: RequestDiagnostic) => {
      console.info(
        JSON.stringify({ event, callId: ctx.callId, sessionId: ctx.session.id, ...detail }),
      );
    };
    const result = await assessApplicationSourceRound(
      reviewInput,
      evidence,
      {
        abortSignal: ctx.abortSignal,
        assertCurrentOwner,
        sessionId: ctx.session.id,
        cacheSessionId: applicationSourceReviewCacheSessionId(ctx.session.id, prepared.reviewKey),
        onRequestStart(value) {
          report("app_builder.source_review_request_started", value);
        },
        onRequest(value) {
          report("app_builder.source_review_request_finished", value);
        },
      },
      continuation,
    );
    await assertCurrentOwner();
    return result;
  } catch {
    ctx.abortSignal?.throwIfAborted();
    // Observation/reviewer unavailability is advisory, as in the ordinary review path.
    const assessment = unavailableSourceAssessment(
      reviewInput,
      "Independent source review was unavailable; its outcome remains unassessed.",
      "blocked",
    );
    return { continuation, assessment };
  }
}

// oxlint-disable-next-line eslint/func-style -- Native Workflow steps require top-level async declarations.
export async function saveApplicationReviewOutcomeStep(
  reference: AppliedSourceReviewReference,
  assessment: ProductSourceAssessment,
  ctx: WorkflowStepToolContext,
): Promise<AppliedSourceReviewReference> {
  "use step";
  const { sourceReviewContextStoreForSession } = await import("./source-review-journal-runtime");
  const store = await sourceReviewContextStoreForSession({
    appId: reference.appId,
    sessionAuth: ctx.session.auth,
    sessionId: ctx.session.id,
    abortSignal: ctx.abortSignal,
  });
  const outcomeRef = await store.publishOutcome(reference.contextRef, assessment);
  ctx.abortSignal?.throwIfAborted();
  if (assessment.invocation !== undefined) {
    console.info(
      JSON.stringify({
        event: "app_builder.source_review_invocation",
        callId: ctx.callId,
        sessionId: ctx.session.id,
        ...assessment.invocation,
      }),
    );
  }
  return { appId: reference.appId, contextRef: reference.contextRef, outcomeRef };
}

interface ApplicationReviewWorkflowSteps {
  load?: typeof loadApplicationReviewContextStep;
  round: typeof applicationReviewRoundStep;
  save: typeof saveApplicationReviewOutcomeStep;
}
const workflowReviewSteps: ApplicationReviewWorkflowSteps = {
  load: loadApplicationReviewContextStep,
  round: applicationReviewRoundStep,
  save: saveApplicationReviewOutcomeStep,
};

/** Each completed round is a native private step checkpoint, never a new total-work limit. */
export const continueApplicationReviewWorkflow = async (
  reference: AppliedSourceReviewReference,
  ctx: WorkflowStepToolContext,
  steps: ApplicationReviewWorkflowSteps = workflowReviewSteps,
): Promise<AppliedSourceReviewReference> => {
  ctx.abortSignal?.throwIfAborted();
  const prepared = await steps.load?.(reference, ctx);
  let continuation: ApplicationReviewContinuation | undefined;
  for (;;) {
    ctx.abortSignal?.throwIfAborted();
    // oxlint-disable-next-line eslint/no-await-in-loop -- The next model round depends on the preceding durable checkpoint.
    const result = await steps.round(reference, continuation, ctx, prepared);
    ctx.abortSignal?.throwIfAborted();
    if (result.assessment !== undefined) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Save only the terminal result after the preceding round completes.
      return await steps.save(reference, result.assessment, ctx);
    }
    continuation = result.continuation;
  }
};
