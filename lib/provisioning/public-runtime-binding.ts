/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- Keep the complete public release, binding and current authorization predicate visible without changing admission semantics. */
import { browserEntryPathSchema } from "../repository/browser-entry-path";
import { z } from "zod";
import { operatorPlanDigest, HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import {
  publicReleaseRecordSchema,
  publicReleaseOperationRef,
  publicReleasePlanDigest,
} from "./public-release-contract";
import type {
  PublicReleasePlan,
  PublicReleaseRecord,
  PublicReleaseObservation,
} from "./public-release-contract";

/** A fresh public observation is distinct from every historical protected Preview receipt. */
export const publicRuntimeBindingSchema = z.strictObject({
  kind: z.literal("public-application-runtime-v1"),
  operationRef: z.uuid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  runtimeOperationRef: z.uuid(),
  runtimePlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  projectId: z.string().min(1),
  environment: z.literal("production"),
  publicOrigin: z
    .url()
    .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value),
  appEntryPath: browserEntryPathSchema.nullable().optional(),
  deploymentId: z.string().min(1),
  releaseId: z.string().min(1),
});
export type PublicRuntimeBinding = z.infer<typeof publicRuntimeBindingSchema>;
const fail = () => new HostedOperatorError("auth_identity_required");
export const assertPublicRuntimeBinding = (
  binding: PublicRuntimeBinding,
  plan: HostedOperatorPlan,
  operationRef: string,
) => {
  if (
    plan.runtimePreparation !== "single-project-resources-v1" ||
    binding.runtimeOperationRef !== operationRef ||
    binding.runtimePlanDigest !== operatorPlanDigest(plan) ||
    binding.projectId !== plan.selection.projectId ||
    binding.releaseId !== plan.release.id ||
    binding.publicOrigin !== plan.deploymentBoundary?.verification.publicOrigin
  ) {
    throw fail();
  }
};

/** All selection inputs come from the current owned source/normal destination, never listing order or timestamps. */
export const readVerifiedPublicRuntimeBinding = async (input: {
  plan: HostedOperatorPlan;
  operationRef: string;
  appEntryPath?: string | null;
  readCandidates: () => Promise<
    readonly { requestId: string; requestDigest: string; record: unknown }[]
  >;
  assertCurrent: () => Promise<void>;
  assertApproved: (
    plan: PublicReleasePlan,
    receipt: { approvalId: string; approvedByCallId: string },
  ) => Promise<void>;
  observe: (plan: PublicReleasePlan) => Promise<PublicReleaseObservation>;
}) => {
  await input.assertCurrent();
  const rows = await input.readCandidates();
  await input.assertCurrent();
  if (rows.length !== 1) {
    throw fail();
  }
  const [row] = rows;
  const record: PublicReleaseRecord = publicReleaseRecordSchema.parse(row.record);
  const { plan } = record;
  if (
    row.requestId !== publicReleaseOperationRef(plan) ||
    row.requestDigest !== publicReleasePlanDigest(plan) ||
    record.planDigest !== row.requestDigest ||
    plan.purpose !== "application" ||
    plan.runtime.operationRef !== input.operationRef ||
    plan.runtime.planDigest !== operatorPlanDigest(input.plan) ||
    plan.selection.appId !== input.plan.selection.appId ||
    plan.selection.sessionId !== input.plan.selection.sessionId ||
    plan.project.projectId !== input.plan.selection.projectId ||
    plan.runtime.releaseId !== input.plan.release.id ||
    record.observation?.status !== "ready" ||
    plan.effects.some((effect) => record.effects[effect] !== "applied") ||
    plan.environment.some(
      (entry) =>
        record.bindings[entry.key]?.state !== "applied" ||
        (record.bindings[entry.key]?.acceptedEnvId ?? "") === "",
    ) ||
    (record.approvalReceipts?.length ?? 0) === 0
  ) {
    throw fail();
  }
  for (const receipt of record.approvalReceipts ?? []) {
    // Consent is re-read sequentially from the actual owner's native history.
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each complete consent is independently verified before the public read.
    await input.assertApproved(plan, receipt);
  }
  const observed = await input.observe(plan);
  await input.assertCurrent();
  if (
    observed.status !== "ready" ||
    observed.projectId !== plan.project.projectId ||
    observed.publicOrigin !== plan.publicOrigin ||
    observed.releaseId !== plan.runtime.releaseId ||
    observed.deploymentId !== record.observation.deploymentId
  ) {
    throw fail();
  }
  const binding = publicRuntimeBindingSchema.parse({
    kind: "public-application-runtime-v1",
    operationRef: row.requestId,
    planDigest: row.requestDigest,
    runtimeOperationRef: input.operationRef,
    runtimePlanDigest: operatorPlanDigest(input.plan),
    projectId: observed.projectId,
    environment: observed.environment,
    publicOrigin: observed.publicOrigin,
    ...(input.appEntryPath === undefined ? {} : { appEntryPath: input.appEntryPath }),
    deploymentId: observed.deploymentId,
    releaseId: observed.releaseId,
  });
  assertPublicRuntimeBinding(binding, input.plan, input.operationRef);
  return binding;
};
