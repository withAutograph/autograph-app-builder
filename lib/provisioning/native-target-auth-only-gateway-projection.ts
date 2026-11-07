import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { HostedOperatorError } from "./hosted-operator-contract";
import type { OperatorDeploymentCandidate } from "./hosted-operator-contract";
import { createNativeTargetAuthOnlyPreviewDelivery } from "./native-target-auth-only-preview-delivery";
import { createNativeTargetAuthOnlyPreviewEnvironmentAdapter } from "./native-target-auth-only-preview-environment-adapter";
import type { NativeTargetAuthOnlyGatewayProjectionRow } from "./native-target-auth-only-preview-environment-adapter";
import type { NativeTargetAuthOnlyDeliveryEnvironmentInput } from "./native-target-auth-only-preview-environment";
import {
  mergeTrustedGatewayAppBinding,
  trustedGatewayAppBindingSchema,
  trustedGatewayProjectProjectionSchema,
} from "./trusted-gateway-project-projection";
import type { TrustedGatewayProjectProjection } from "./trusted-gateway-project-projection";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const mismatch = () => new HostedOperatorError("resource_mismatch");
const uncertain = () => new HostedOperatorError("reconciliation_required");

interface ProjectionInput {
  environment: NativeTargetAuthOnlyDeliveryEnvironmentInput;
  appReceipt: OperatorDeploymentCandidate;
  /** The source workload comes from the approved isolated Auth profile. */
  source: TrustedGatewayProjectProjection["source"];
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1);
export const nativeTargetAuthOnlyGatewayProjectionIntentSchema = z
  .strictObject({
    operationRef: z.uuid(),
    deliveryPlanDigest: sha256,
    gatewayProjectId: id,
    physicalBranch: id.nullable(),
    rowId: id,
    appDeploymentId: id,
    priorSha256: sha256,
    nextSha256: sha256,
  })
  .refine((intent) => intent.priorSha256 !== intent.nextSha256);
export type NativeTargetAuthOnlyGatewayProjectionIntent = z.infer<
  typeof nativeTargetAuthOnlyGatewayProjectionIntentSchema
>;

interface ProjectionJournal {
  read: () => Promise<NativeTargetAuthOnlyGatewayProjectionIntent | undefined>;
  /** Durable one-winner CAS before PATCH. This intent also excludes sibling writers of the same row. */
  claim: (intent: NativeTargetAuthOnlyGatewayProjectionIntent) => Promise<boolean>;
}

type EnvironmentAdapter = ReturnType<typeof createNativeTargetAuthOnlyPreviewEnvironmentAdapter>;
type PreviewAdapter = ReturnType<typeof createNativeTargetAuthOnlyPreviewDelivery>;

const sameImmutableOrigin = (value: string) => {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === value &&
      parsed.hostname.endsWith(".vercel.app")
    );
  } catch {
    return false;
  }
};

const validateExistingProjection = (projection: TrustedGatewayProjectProjection) => {
  const { source, bindings } = projection;
  const apps = new Set<string>();
  const projects = new Set<string>([source.projectId]);
  const origins = new Set<string>([source.publicOrigin]);
  for (const binding of bindings) {
    const { readyState, ...observed } = binding.observation;
    if (readyState !== "READY" || !isDeepStrictEqual(observed, binding.approved)) {
      throw mismatch();
    }
    if (observed.ownerId !== source.ownerId || !sameImmutableOrigin(observed.deploymentUrl)) {
      throw mismatch();
    }
    if (
      apps.has(binding.appId) ||
      projects.has(observed.projectId) ||
      origins.has(observed.deploymentUrl)
    ) {
      throw mismatch();
    }
    apps.add(binding.appId);
    projects.add(observed.projectId);
    origins.add(observed.deploymentUrl);
  }
};

const parseProjection = (value: string) => {
  if (Buffer.byteLength(value) > 65_536) {
    throw mismatch();
  }
  try {
    return trustedGatewayProjectProjectionSchema.parse(JSON.parse(value));
  } catch {
    throw mismatch();
  }
};

export const projectNativeTargetAuthOnlyGatewayBinding = (
  input: ProjectionInput,
  current: string,
  candidate: OperatorDeploymentCandidate,
) => {
  const {
    environment: { deliveryPlan, target, plan },
    source,
  } = input;
  const app = deliveryPlan.delivery.delivery;
  const gateway = deliveryPlan.delivery.publicGateway;
  if (app === undefined || gateway === undefined || target.environment !== "preview") {
    throw mismatch();
  }
  if (
    source.publicOrigin !== gateway.origin ||
    source.projectId !== gateway.projectId ||
    source.ownerId !== target.scopeId
  ) {
    throw mismatch();
  }
  if (
    candidate.readyState !== "READY" ||
    candidate.projectId !== target.projectId ||
    candidate.operationRef !== input.environment.operationRef
  ) {
    throw mismatch();
  }
  if (
    candidate.branch !== app.branch ||
    candidate.repoId !== app.repoId ||
    candidate.projectName !== plan.project.name
  ) {
    throw mismatch();
  }
  if (!sameImmutableOrigin(candidate.origin) || candidate.scopeSlug === undefined) {
    throw mismatch();
  }
  const projection = parseProjection(current);
  if (
    !isDeepStrictEqual(
      projection.source,
      trustedGatewayProjectProjectionSchema.shape.source.parse(source),
    )
  ) {
    throw mismatch();
  }
  validateExistingProjection(projection);
  const approved = {
    deploymentId: candidate.deploymentId,
    deploymentUrl: candidate.origin,
    projectId: candidate.projectId,
    projectName: candidate.projectName,
    scopeSlug: candidate.scopeSlug,
    environment: "preview" as const,
    ownerId: target.scopeId,
  };
  const appBinding = trustedGatewayAppBindingSchema.parse({
    appId: target.appId,
    approved,
    observation: { ...approved, readyState: "READY" },
  });
  const existing = projection.bindings.find((entry) => entry.appId === target.appId);
  if (existing !== undefined) {
    if (!isDeepStrictEqual(existing, appBinding)) {
      throw mismatch();
    }
    return current;
  }
  const next = {
    ...projection,
    bindings: mergeTrustedGatewayAppBinding(projection.bindings, appBinding),
  };
  validateExistingProjection(next);
  const value = JSON.stringify(next);
  if (Buffer.byteLength(value) > 65_536) {
    throw mismatch();
  }
  return value;
};

const proveIntendedRow = (
  input: ProjectionInput,
  row: NativeTargetAuthOnlyGatewayProjectionRow,
  candidate: OperatorDeploymentCandidate,
  nextSha256: string,
) => ({
  operationRef: input.environment.operationRef,
  deliveryPlanDigest: input.environment.approval.planDigest,
  gatewayProjectId: row.projectId,
  physicalBranch: row.physicalBranch,
  rowId: row.rowId,
  appDeploymentId: candidate.deploymentId,
  nextSha256,
});

interface ProjectionProviderPorts {
  openProjection: EnvironmentAdapter["openGatewayProjection"];
  reconcileApp: PreviewAdapter["reconcile"];
}

/** Prepare the existing projection row for a separately approved Gateway refresh. */
export const createNativeTargetAuthOnlyGatewayProjection = (
  deps: Parameters<typeof createNativeTargetAuthOnlyPreviewEnvironmentAdapter>[0] & {
    journal: ProjectionJournal;
    /** Read the exact reviewed Gateway source's static catalog before adopting an entry. */
    assertCatalogApp: (input: ProjectionInput) => Promise<void>;
    /** Read the current approved projection operation, exclusive Gateway row lease and fence. */
    assertAuthorized: (intent: NativeTargetAuthOnlyGatewayProjectionIntent) => Promise<void>;
  },
  providers?: ProjectionProviderPorts,
) => {
  const environmentAdapter = createNativeTargetAuthOnlyPreviewEnvironmentAdapter(deps);
  return async (input: ProjectionInput) => {
    const { environment, appReceipt } = input;
    environment.signal.throwIfAborted();
    await environment.assertCurrent();
    await deps.assertCatalogApp(input);
    const connection = await (providers === undefined
      ? environmentAdapter.openGatewayProjection(environment)
      : providers.openProjection(environment));
    const appDelivery = createNativeTargetAuthOnlyPreviewDelivery({
      target: "app",
      readCredential: deps.readCredential,
      assertEnvironment: async () => {
        await environment.assertCurrent();
      },
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
    const reconcile = (value: Parameters<PreviewAdapter["reconcile"]>[0]) =>
      providers === undefined ? appDelivery.reconcile(value) : providers.reconcileApp(value);
    const observed = await reconcile({
      authority: environment.authority,
      target: environment.target,
      plan: environment.deliveryPlan.delivery,
      approvedPlanDigest: environment.approval.planDigest,
      approval: environment.approval,
      operationRef: environment.operationRef,
      fenceGeneration: environment.fenceGeneration,
      effectId: environment.deliveryPlan.effects[1].id,
      deliveryCandidates: [appReceipt],
      assertCurrent: environment.assertCurrent,
      signal: environment.signal,
      checkpointDelivery: async () => {
        await environment.assertCurrent();
      },
    });
    if (observed.status !== "applied" || !isDeepStrictEqual(observed.selected, appReceipt)) {
      throw uncertain();
    }
    if (
      observed.candidates.some(
        (candidate) =>
          candidate.readyState === "READY" && candidate.deploymentId !== appReceipt.deploymentId,
      )
    ) {
      throw uncertain();
    }
    const prior = await connection.read();
    const next = projectNativeTargetAuthOnlyGatewayBinding(input, prior.value, observed.selected);
    const nextSha256 = digest(next);
    const expected = proveIntendedRow(input, prior, observed.selected, nextSha256);
    const retained = await deps.journal.read();
    const result = {
      projectionDigest: nextSha256,
      appDeploymentId: observed.selected.deploymentId,
    };
    if (retained !== undefined) {
      const parsed = nativeTargetAuthOnlyGatewayProjectionIntentSchema.safeParse(retained);
      if (!parsed.success) {
        throw uncertain();
      }
      const intent = parsed.data;
      if (
        !isDeepStrictEqual(intent, { ...expected, priorSha256: intent.priorSha256 }) ||
        prior.value !== next
      ) {
        throw uncertain();
      }
      await deps.assertAuthorized(intent);
      return result;
    }
    if (prior.value === next) {
      await environment.assertCurrent();
      return result;
    }
    const attempt = nativeTargetAuthOnlyGatewayProjectionIntentSchema.parse({
      ...expected,
      priorSha256: digest(prior.value),
    });
    await deps.assertAuthorized(attempt);
    if (!(await deps.journal.claim(attempt))) {
      throw uncertain();
    }
    const assertWrite = async () => {
      environment.signal.throwIfAborted();
      await environment.assertCurrent();
      if (!isDeepStrictEqual(await deps.journal.read(), attempt)) {
        throw uncertain();
      }
      await deps.assertAuthorized(attempt);
    };
    try {
      await assertWrite();
      await connection.patch(prior, next, assertWrite);
      const after = await connection.read();
      if (!isDeepStrictEqual(after, { ...prior, value: next })) {
        throw uncertain();
      }
      await assertWrite();
      return result;
    } catch {
      throw uncertain();
    }
  };
};
