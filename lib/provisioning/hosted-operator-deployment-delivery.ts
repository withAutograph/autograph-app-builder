/* oxlint-disable eslint/no-await-in-loop -- Provider pages and observed deployment checkpoints are ordered under one real lease. */
import { z } from "zod";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import {
  HostedOperatorError,
  nativeDeliveryGitRef,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  OperatorDeliveryCorrection,
  OperatorDeploymentCandidate,
} from "./hosted-operator-contract";
import type {
  HostedOperatorDeploymentContext,
  HostedOperatorEffectContext,
} from "./hosted-operator-service";
import { isSharedHostProtectionDeliveryProvenance } from "./hosted-operator-shared-host-protection-successor";
import { isRetentionRenewalDeliveryProvenance } from "./hosted-operator-retention-renewal";
import type { RetentionRenewalDeliveryProvenance } from "./hosted-operator-retention-renewal";
import { createHostedOperatorConsentDiagnostic } from "./hosted-operator-consent-diagnostic";
import type { OperatorGatewayDeliveryDiagnostic } from "./hosted-operator-consent-diagnostic";
import { readOperatorGatewayProviderFailure } from "./hosted-operator-gateway-bindings";

interface DeploymentListQuery {
  branch: string;
  limit: string;
  projectId: string;
  until?: string;
}
const matchesMetadataIdentity = (
  expected: Readonly<Record<string, string>>,
  observed: Record<string, string> | undefined,
) => Object.entries(expected).every(([key, value]) => observed?.[key] === value);

const retainedCandidates = (
  provenance: RetentionRenewalDeliveryProvenance | undefined,
  target: "app" | "gateway" | undefined,
) =>
  target === "gateway"
    ? (provenance?.gatewayDeliveryCandidates ?? [])
    : (provenance?.deliveryCandidates ?? []);
const matchesDeliveryMetadata = (
  provenance: RetentionRenewalDeliveryProvenance,
  kind: "delivery" | "gateway-delivery",
  observed: Record<string, string> | undefined,
) => {
  const effect = provenance.plan.effects.find((value) => value.kind === kind);
  return (
    effect !== undefined &&
    matchesMetadataIdentity(
      {
        autograph_operator_effect: effect.id,
        autograph_operator_operation: provenance.operationRef,
        autograph_operator_plan: provenance.planDigest,
      },
      observed,
    )
  );
};

const assertRetainedCandidateIdentity = (
  candidate: OperatorDeploymentCandidate | undefined,
  delivery: NonNullable<HostedOperatorPlan["delivery"]>,
  operationRef: string,
  origin: string,
) => {
  if (candidate === undefined) {
    return;
  }
  if (
    ![
      candidate.operationRef === operationRef,
      candidate.projectId === delivery.projectId,
      candidate.repoId === delivery.repoId,
      candidate.branch === delivery.branch,
      candidate.origin === origin,
    ].every(Boolean)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
};

const id = z.string().min(1);
const isPendingBuild = (candidate: OperatorDeploymentCandidate) =>
  ["BUILDING", "QUEUED", "INITIALIZING"].includes(candidate.readyState);
const nativePreviewMetadataSchema = z
  .object({
    customEnvironment: z.null().optional(),
    oidcTokenClaims: z.object({ environment: z.literal("preview") }).optional(),
    target: z.union([z.null(), z.literal("staging")]),
  })
  .refine(
    (deployment) =>
      deployment.target === null || deployment.oidcTokenClaims?.environment === "preview",
    "Native staging target must attest the Preview environment.",
  );

export interface NativeDeploymentMetadata {
  customEnvironment?: unknown;
  oidcTokenClaims?: unknown;
  target: string | null;
}

/** Native Preview metadata only; never interprets custom environments as Preview. */
export const isNativePreviewDeployment = (metadata: NativeDeploymentMetadata): boolean =>
  nativePreviewMetadataSchema.safeParse(metadata).success;

const deploymentSchema = z
  .object({
    customEnvironment: z.null().optional(),
    gitSource: z.object({
      ref: id,
      repoId: z.union([z.number(), id]),
      sha: z.string().regex(/^[a-f0-9]{40}$/u),
      type: z.literal("github"),
    }),
    id,
    meta: z.record(z.string(), z.string()).optional(),
    oidcTokenClaims: z.object({ environment: z.literal("preview") }).optional(),
    ownerId: id.optional(),
    projectId: id,
    readyState: id,
    target: z.union([z.null(), z.literal("staging")]),
    url: id,
  })
  .refine(
    (deployment) => isNativePreviewDeployment(deployment),
    "Native staging target must attest the Preview environment.",
  );
const blockedProductionSchema = z.object({
  buildSkipped: z.literal(true),
  builds: z.array(z.unknown()),
  gitSource: z.object({
    ref: id,
    repoId: z.union([z.number(), id]),
    sha: z.string().regex(/^[a-f0-9]{40}$/u),
    type: z.literal("github"),
  }),
  id,
  meta: z.record(z.string(), z.string()).optional(),
  oidcTokenClaims: z.object({
    environment: z.literal("production"),
    owner_id: id,
    project_id: id,
  }),
  ownerId: id,
  projectId: id,
  readyState: z.literal("BLOCKED"),
  target: z.literal("production"),
});
const rejectedProductionSchema = blockedProductionSchema
  .omit({ buildSkipped: true, builds: true })
  .extend({
    customEnvironment: z.null().optional(),
    readyState: id,
  });
const failedNativePreviewSchema = z.object({
  customEnvironment: z.null().optional(),
  gitSource: z.object({
    ref: id,
    repoId: z.union([z.number(), id]),
    sha: z.string().regex(/^[a-f0-9]{40}$/u),
    type: z.literal("github"),
  }),
  id,
  meta: z.record(z.string(), z.string()).optional(),
  oidcTokenClaims: z.object({
    environment: z.literal("preview"),
    owner_id: id,
    project_id: id,
  }),
  ownerId: id,
  projectId: id,
  readyState: z.literal("ERROR"),
  target: z.union([z.null(), z.literal("staging")]),
});
const pageSchema = z.object({
  deployments: z.array(z.object({ meta: z.record(z.string(), z.string()).optional(), uid: id })),
  pagination: z.object({ next: z.number().nullable() }).optional(),
});
interface PriorAppDelivery {
  deliveryCandidates: readonly OperatorDeploymentCandidate[];
  operationRef: string;
  plan: HostedOperatorPlan;
  planDigest: string;
}

const withoutProjectSettings = (plan: HostedOperatorPlan): HostedOperatorPlan => {
  if (plan.delivery === undefined) {
    return plan;
  }
  const delivery = { ...plan.delivery };
  delete delivery.projectSettings;
  return { ...plan, delivery };
};

const sameAppDeliveryExceptProjectSettings = (
  current: HostedOperatorPlan,
  prior: HostedOperatorPlan,
) =>
  operatorPlanDigest(withoutProjectSettings(current)) ===
  operatorPlanDigest(withoutProjectSettings(prior));
const projectSchema = z.object({
  accountId: id,
  id,
  link: z
    .object({ repoId: z.union([z.number(), id]), type: z.literal("github") })
    .nullable()
    .optional(),
  name: id,
});
const projectLinkMatchesDelivery = (
  project: z.infer<typeof projectSchema>,
  repoId: string,
  allowUnlinked: boolean,
) =>
  project.link === undefined || project.link === null
    ? allowUnlinked
    : String(project.link.repoId) === repoId;

const aliasCategorySchema = z.enum(["ok", "not_found", "rejected", "unknown", "redirected"]);

export interface GatewayAliasDiagnostic {
  stage: "assignment" | "readback";
  method: "GET" | "POST";
  httpStatus?: number;
  category: z.infer<typeof aliasCategorySchema>;
}

class RejectedAliasAssignmentError extends HostedOperatorError {
  constructor() {
    super("operator_unavailable");
    this.name = "RejectedAliasAssignmentError";
  }
}

/** Explicit approved Preview delivery via normal Git. Candidate IDs are observed effects, never Git/alias authority. */
export const createHostedOperatorDeploymentDelivery = (deps: {
  assertAuthorized: Awaited<
    ReturnType<typeof createHostedOperatorControlPlane>
  >["assertAuthorized"];
  assertEnvironment: (input: HostedOperatorDeploymentContext) => Promise<void>;
  readCredential: Awaited<ReturnType<typeof createHostedOperatorControlPlane>>["readCredential"];
  fetch?: typeof fetch;
  target?: "app" | "gateway";
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  observeAlias?: (diagnostic: GatewayAliasDiagnostic) => void | Promise<void>;
  beforeCreate?: (input: HostedOperatorDeploymentContext) => Promise<void>;
  beforeAliasWrite?: (
    input: HostedOperatorDeploymentContext,
    selected: OperatorDeploymentCandidate,
  ) => Promise<"write" | "applied" | "unknown">;
}) => {
  const deliveryDiagnostic = (input: HostedOperatorDeploymentContext) => {
    let stage: OperatorGatewayDeliveryDiagnostic["stage"] = "context";
    let phase: OperatorGatewayDeliveryDiagnostic["phase"];
    let method: OperatorGatewayDeliveryDiagnostic["method"];
    let httpStatus: OperatorGatewayDeliveryDiagnostic["httpStatus"];
    let providerFailure:
      | Pick<
          OperatorGatewayDeliveryDiagnostic,
          "providerCode" | "providerTerms" | "validationFields"
        >
      | undefined;
    return {
      at(value: OperatorGatewayDeliveryDiagnostic["stage"]) {
        stage = value;
        phase = undefined;
        method = undefined;
        httpStatus = undefined;
        providerFailure = undefined;
      },
      phase(value: OperatorGatewayDeliveryDiagnostic["phase"]) {
        phase = value;
      },
      request(value: OperatorGatewayDeliveryDiagnostic["method"]) {
        method = value;
        httpStatus = undefined;
        providerFailure = undefined;
      },
      response(value: number) {
        httpStatus = value;
      },
      providerFailure(value: NonNullable<typeof providerFailure>) {
        providerFailure = value;
      },
      finish(result: OperatorGatewayDeliveryDiagnostic["result"]) {
        if (deps.target !== "gateway") {
          return;
        }
        try {
          createHostedOperatorConsentDiagnostic(input.target.sessionId)({
            boundary: "operator",
            phase: "inline",
            stage: "operator_request",
            outcome: result === "applied" ? "verified" : "setup_unavailable",
            gatewayDelivery: { stage, phase, method, httpStatus, result, ...providerFailure },
          });
        } catch {
          /* Advisory metadata never changes delivery or its original exception. */
        }
      },
    };
  };
  const observeAlias = (diagnostic: GatewayAliasDiagnostic) => {
    try {
      if (deps.observeAlias === undefined) {
        console.info("hosted_operator_gateway_alias", diagnostic);
      } else {
        const sink = deps.observeAlias;
        void (async () => {
          try {
            await sink(diagnostic);
          } catch {
            // A rejected advisory sink cannot alter delivery.
          }
        })();
      }
    } catch {
      // Advisory observations never change the delivery outcome.
    }
  };
  const sendObserved = async (
    send: () => Promise<Response>,
    stage: GatewayAliasDiagnostic["stage"] | undefined,
    method: GatewayAliasDiagnostic["method"],
    allowNotFound: boolean,
  ) => {
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      if (stage !== undefined) {
        observeAlias({ stage, method, category: "unknown" });
      }
      throw error;
    }
    if (stage === undefined) {
      return { response, rejectedAssignment: false };
    }
    const rejectedAssignment =
      stage === "assignment" && [400, 401, 403, 404, 409, 429].includes(response.status);
    let category: GatewayAliasDiagnostic["category"] = "unknown";
    if (response.ok) {
      category = "ok";
    } else if (allowNotFound && response.status === 404) {
      category = "not_found";
    } else if (rejectedAssignment) {
      category = "rejected";
    }
    observeAlias({ stage, method, httpStatus: response.status, category });
    return { response, rejectedAssignment };
  };
  const io = (
    input: HostedOperatorDeploymentContext,
    observation?: ReturnType<typeof deliveryDiagnostic>,
  ) => {
    const deliveryKind = deps.target === "gateway" ? "gateway-delivery" : "delivery";
    const delivery = deps.target === "gateway" ? input.plan.gatewayDelivery : input.plan.delivery;
    if (delivery === undefined) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const validScope = [
      input.plan.action === "prepare",
      input.effect.kind === deliveryKind,
      input.target.environment === "preview",
      delivery.projectId ===
        (deps.target === "gateway" ? input.plan.publicGateway?.projectId : input.target.projectId),
      delivery.branch ===
        (deps.target === "gateway"
          ? input.plan.publicGateway?.branch
          : (input.plan.deploymentBoundary?.app.branch ?? input.target.branch)),
    ].every(Boolean);
    if (!validScope) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const gitRef = nativeDeliveryGitRef(input.plan, delivery, deps.target ?? "app");
    const planDigest = operatorPlanDigest(input.plan);
    const expectedMeta = {
      autograph_operator_effect: input.effect.id,
      autograph_operator_operation: input.operationRef,
      autograph_operator_plan: planDigest,
    };
    let deliveryCorrection = input.deliveryCorrections?.find(
      (correction) => correction.effectId === input.effect.id,
    );
    const gatewayProvenance =
      deps.target === "gateway"
        ? (input.gatewayDeliveryProvenance ?? []).filter((provenance) =>
            isSharedHostProtectionDeliveryProvenance(provenance, input.plan, input.operationRef),
          )
        : [];
    const renewalProvenance = (input.renewalDeliveryProvenance ?? []).filter((provenance) =>
      isRetentionRenewalDeliveryProvenance(provenance, input.plan, input.operationRef),
    );
    const metadataIdentities = [
      expectedMeta,
      ...[...gatewayProvenance, ...renewalProvenance].flatMap((provenance) => {
        const effect = provenance.plan.effects.find((value) => value.kind === deliveryKind);
        return effect === undefined
          ? []
          : [
              {
                autograph_operator_effect: effect.id,
                autograph_operator_operation: provenance.operationRef,
                autograph_operator_plan: provenance.planDigest,
              },
            ];
      }),
    ];
    const matchesMetadata = (metadata: Record<string, string> | undefined) =>
      metadataIdentities.some((expected) => matchesMetadataIdentity(expected, metadata));
    const assertCurrent = async () => {
      input.signal?.throwIfAborted();
      await input.assertCurrent();
      await deps.assertAuthorized(input);
    };
    // oxlint-disable-next-line eslint/complexity -- Preserve provider request order and add only optional diagnostic observations.
    const request = async (
      pathname: string,
      query: Record<string, string> = {},
      body?:
        | {
            gitSource: { ref: string; repoId: string; sha: string; type: "github" };
            meta: Record<string, string>;
            name: string;
            project: string;
            projectSettings?: NonNullable<HostedOperatorPlan["delivery"]>["projectSettings"];
            target?: "staging";
          }
        | { alias: string },
      allowNotFound = false,
      aliasStage?: GatewayAliasDiagnostic["stage"],
    ) => {
      observation?.request(body === undefined ? "GET" : "POST");
      observation?.phase("authority");
      await assertCurrent();
      observation?.phase("credential");
      const credential = await deps.readCredential(input.authority, input.target.installationId);
      if (
        credential?.binding.active !== true ||
        credential.binding.installationId !== input.target.installationId ||
        credential.binding.scopeId !== input.target.scopeId ||
        credential.binding.scopeType !== input.target.scopeType
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      observation?.phase("authority");
      await assertCurrent();
      const url = new URL(pathname, "https://api.vercel.com");
      if (input.target.scopeType === "team") {
        url.searchParams.set("teamId", input.target.scopeId);
      }
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
      const signal = AbortSignal.any([
        AbortSignal.timeout(20_000),
        ...(input.signal === undefined ? [] : [input.signal]),
      ]);
      const send = async () =>
        await (deps.fetch ?? fetch)(url, {
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: "no-store",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
          },
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          signal,
        });
      observation?.phase("fetch");
      const { response, rejectedAssignment } = await sendObserved(
        send,
        aliasStage,
        body === undefined ? "GET" : "POST",
        allowNotFound,
      );
      observation?.phase("http_response");
      observation?.response(response.status);
      try {
        if (rejectedAssignment) {
          throw new RejectedAliasAssignmentError();
        }
        if (allowNotFound && response.status === 404) {
          return null;
        }
        if (!response.ok) {
          if (deps.target === "gateway" && observation !== undefined) {
            observation.providerFailure(await readOperatorGatewayProviderFailure(response, signal));
          }
          throw new HostedOperatorError("operator_unavailable");
        }
        observation?.phase("json_decode");
        const value = z.json().parse(await response.json());
        observation?.phase("authority");
        await assertCurrent();
        observation?.phase("response_schema");
        return value;
      } finally {
        if (!response.bodyUsed) {
          await response.body?.cancel();
        }
      }
    };
    // oxlint-disable-next-line eslint/complexity -- Keep native source, owner, environment and operation checks in one authoritative readback.
    const readDeployment = async (
      deploymentId: string,
      verifyProject: boolean,
      requireOperatorMetadata: boolean,
      supplied?: z.infer<typeof deploymentSchema>,
    ): Promise<OperatorDeploymentCandidate> => {
      const observed = deploymentSchema.parse(
        supplied ??
          (await request(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
            withGitRepoInfo: "true",
          })),
      );
      const matches = [
        observed.id === deploymentId,
        observed.projectId === delivery.projectId,
        observed.ownerId === undefined || observed.ownerId === input.target.scopeId,
        String(observed.gitSource.repoId) === delivery.repoId,
        observed.gitSource.ref === gitRef,
        delivery.gitSha !== undefined && observed.gitSource.sha === delivery.gitSha,
        !requireOperatorMetadata || matchesMetadata(observed.meta),
      ].every(Boolean);
      if (!matches) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const origin = new URL(`https://${observed.url}`);
      const exactOrigin = [
        origin.pathname === "/",
        origin.search === "",
        origin.hash === "",
        origin.username === "",
        origin.password === "",
      ].every(Boolean);
      if (!exactOrigin) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const retained = retainedCandidates(
        renewalProvenance.find((provenance) =>
          matchesDeliveryMetadata(provenance, deliveryKind, observed.meta),
        ),
        deps.target,
      ).find((candidate) => candidate.deploymentId === observed.id);
      assertRetainedCandidateIdentity(retained, delivery, input.operationRef, origin.origin);
      const saved =
        input.deliveryCandidates?.find(
          (candidate) =>
            candidate.deploymentId === observed.id && candidate.operationRef === input.operationRef,
        ) ?? retained;
      let projectName = saved?.projectName;
      let scopeSlug = saved?.scopeSlug;
      // Pending polls retain deployment identity checks; project/team are checked at entry and terminal readback.
      if (verifyProject || !["BUILDING", "QUEUED", "INITIALIZING"].includes(observed.readyState)) {
        const project = projectSchema.parse(
          await request(`/v9/projects/${encodeURIComponent(delivery.projectId)}`),
        );
        const team = z
          .object({ id, slug: id })
          .parse(await request(`/v2/teams/${encodeURIComponent(input.target.scopeId)}`));
        if (
          project.id !== delivery.projectId ||
          project.accountId !== input.target.scopeId ||
          !projectLinkMatchesDelivery(project, delivery.repoId, deps.target !== "gateway") ||
          team.id !== input.target.scopeId
        ) {
          throw new HostedOperatorError("resource_mismatch");
        }
        projectName = project.name;
        scopeSlug = team.slug;
      }
      return {
        ...(saved?.gatewayAliasAttempted === undefined
          ? {}
          : { gatewayAliasAttempted: saved.gatewayAliasAttempted }),
        branch: delivery.branch,
        deploymentId: observed.id,
        operationRef: input.operationRef,
        origin: origin.origin,
        projectId: delivery.projectId,
        ...(projectName === undefined ? {} : { projectName }),
        readyState: observed.readyState,
        repoId: delivery.repoId,
        ...(scopeSlug === undefined ? {} : { scopeSlug }),
      };
    };
    const readCandidate = async (deploymentId: string, verifyProject = true) =>
      await readDeployment(deploymentId, verifyProject, true);
    const readCandidateOrRejection = async (deploymentId: string) => {
      const raw = await request(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
        withGitRepoInfo: "true",
      });
      const rejected = rejectedProductionSchema.safeParse(raw);
      if (!rejected.success) {
        return await readDeployment(deploymentId, true, true, deploymentSchema.parse(raw));
      }
      const observed = rejected.data;
      const exactRejectedIdentity = [
        observed.id === deploymentId,
        observed.projectId === delivery.projectId,
        observed.ownerId === input.target.scopeId,
        observed.oidcTokenClaims.owner_id === input.target.scopeId,
        observed.oidcTokenClaims.project_id === delivery.projectId,
        String(observed.gitSource.repoId) === delivery.repoId,
        observed.gitSource.ref === gitRef,
        delivery.gitSha !== undefined && observed.gitSource.sha === delivery.gitSha,
        matchesMetadataIdentity(expectedMeta, observed.meta),
      ].every(Boolean);
      if (!exactRejectedIdentity || input.checkpointDeliveryCorrection === undefined) {
        throw new HostedOperatorError("reconciliation_required");
      }
      await assertCurrent();
      deliveryCorrection = await input.checkpointDeliveryCorrection({
        effectId: input.effect.id,
        rejectedDeploymentIds: [deploymentId],
        createAttempted: false,
      });
      // This observed Production result never enters the Preview candidate collection.
      // oxlint-disable-next-line unicorn/no-useless-undefined -- A rejected deployment explicitly has no Preview candidate.
      return undefined;
    };
    const provesDifferentGatewayAliasTarget = async (deploymentId: string | null) => {
      if (gatewayProvenance.length === 0 || deploymentId === null) {
        return false;
      }
      // This is negative evidence about the alias, never an adopted delivery candidate.
      const observed = await readDeployment(deploymentId, true, false);
      return observed.readyState === "READY";
    };
    // oxlint-disable-next-line sonarjs/cognitive-complexity -- Complete ordered inventory and journal observations before deciding whether another create is safe.
    const readCandidates = async () => {
      const ids = new Set<string>();
      for (const candidate of input.deliveryCandidates ?? []) {
        if (candidate.operationRef === input.operationRef) {
          ids.add(candidate.deploymentId);
        }
      }
      for (const deploymentId of deliveryCorrection?.rejectedDeploymentIds ?? []) {
        ids.add(deploymentId);
      }
      // Candidate IDs are observation hints only. Even rejected provenance must be read
      // rather than mistaken for absence that could authorize another create.
      for (const candidate of (input.renewalDeliveryProvenance ?? []).flatMap((provenance) =>
        retainedCandidates(provenance, deps.target),
      )) {
        ids.add(candidate.deploymentId);
      }
      let cursor: number | undefined;
      const seen = new Set<number>();
      for (;;) {
        const query: DeploymentListQuery = {
          branch: gitRef,
          limit: "100",
          projectId: delivery.projectId,
        };
        if (cursor !== undefined) {
          query.until = String(cursor);
        }
        const page = pageSchema.parse(await request("/v7/deployments", { ...query }));
        for (const candidate of page.deployments) {
          if (matchesMetadata(candidate.meta)) {
            ids.add(candidate.uid);
          }
        }
        const next = page.pagination?.next;
        if (next === undefined || next === null) {
          break;
        }
        if (seen.has(next)) {
          throw new HostedOperatorError("operator_unavailable");
        }
        seen.add(next);
        cursor = next;
      }
      const candidates: OperatorDeploymentCandidate[] = [];
      for (const deploymentId of ids) {
        // oxlint-disable-next-line react-doctor/async-await-in-loop -- Rejection observations update one journal CAS and must remain sequential.
        const candidate = await readCandidateOrRejection(deploymentId);
        if (candidate !== undefined) {
          candidates.push(candidate);
        }
      }
      if (candidates.length !== 0) {
        await input.checkpointDelivery(candidates);
      }
      return candidates;
    };
    const readGatewayAlias = async () => {
      const gateway = input.plan.publicGateway;
      if (deps.target !== "gateway" || gateway === undefined) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const alias = new URL(gateway.origin).hostname;
      const raw = await request(
        `/v4/aliases/${encodeURIComponent(alias)}`,
        {},
        undefined,
        true,
        "readback",
      );
      if (raw === null) {
        return { alias, deploymentId: null, redirected: false };
      }
      const observed = z
        .object({
          alias: id,
          deploymentId: id,
          projectId: id,
          redirect: z.string().nullable().optional(),
        })
        .parse(raw);
      if (observed.alias.toLowerCase() !== alias || observed.projectId !== gateway.projectId) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const redirected =
        observed.redirect !== undefined &&
        observed.redirect !== null &&
        observed.redirect.length > 0;
      if (redirected) {
        observeAlias({ stage: "readback", method: "GET", category: "redirected" });
      }
      return { alias, deploymentId: observed.deploymentId, redirected };
    };
    return {
      assertCurrent,
      delivery,
      gitRef,
      expectedMeta,
      readCandidate,
      readCandidateOrRejection,
      readCandidates,
      deliveryCorrection: () => deliveryCorrection,
      readGatewayAlias,
      provesDifferentGatewayAliasTarget,
      request,
    };
  };
  const reconcile = async (
    input: HostedOperatorDeploymentContext,
    observation?: ReturnType<typeof deliveryDiagnostic>,
  ) => {
    try {
      const reader = io(input, observation);
      let candidates = await reader.readCandidates();
      let waitedForBuild = false;
      let waitMilliseconds = 5000;
      while (
        !candidates.some((candidate) => candidate.readyState === "READY") &&
        !candidates.some((candidate) => candidate.gatewayAliasAttempted === true) &&
        candidates.some(isPendingBuild)
      ) {
        // Renew the real execution lease around each bounded sleep. Only positively observed
        // pending candidates are polled; uncertain effects never authorize another create.
        await reader.assertCurrent();
        await (deps.wait === undefined
          ? delay(waitMilliseconds, undefined, { signal: input.signal })
          : deps.wait(waitMilliseconds, input.signal));
        await reader.assertCurrent();
        candidates = await Promise.all(
          candidates.map(async (candidate) =>
            isPendingBuild(candidate)
              ? await reader.readCandidate(candidate.deploymentId, false)
              : candidate,
          ),
        );
        await input.checkpointDelivery(candidates);
        waitedForBuild = true;
        waitMilliseconds = Math.min(waitMilliseconds + 5000, 15_000);
      }
      let selected = candidates.find((value) => value.readyState === "READY");
      if (selected === undefined) {
        if (
          reader.deliveryCorrection()?.createAttempted === true ||
          waitedForBuild ||
          candidates.some(
            (candidate) => deps.target === "gateway" && candidate.gatewayAliasAttempted === true,
          )
        ) {
          return { candidates, status: "unknown" as const };
        }
        return {
          candidates,
          correction: reader.deliveryCorrection(),
          resourceVersion: createHash("sha256")
            .update(
              JSON.stringify({
                candidates,
                correction: reader.deliveryCorrection(),
                scope: reader.delivery,
              }),
            )
            .digest("hex"),
          status: "retryable" as const,
        };
      }
      await deps.assertEnvironment(input);
      await reader.assertCurrent();
      if (deps.target === "gateway") {
        const alias = await reader.readGatewayAlias();
        if (alias.redirected) {
          return { candidates, status: "unknown" as const };
        }
        const assigned = candidates.find(
          (candidate) =>
            candidate.deploymentId === alias.deploymentId && candidate.readyState === "READY",
        );
        if (assigned === undefined) {
          if (
            candidates.some((candidate) => candidate.gatewayAliasAttempted === true) &&
            !(await reader.provesDifferentGatewayAliasTarget(alias.deploymentId))
          ) {
            return { candidates, status: "unknown" as const };
          }
          return {
            candidates,
            resourceVersion: createHash("sha256")
              .update(JSON.stringify({ alias, candidates, scope: reader.delivery }))
              .digest("hex"),
            status: "retryable" as const,
          };
        }
        selected = assigned;
      }
      await input.checkpointDelivery(candidates, selected.deploymentId);
      return { candidates, selected, status: "applied" as const };
    } catch {
      return { status: "unknown" as const };
    }
  };
  const priorAppDeliveryIsTerminalFailure = async (
    input: HostedOperatorDeploymentContext,
    reader: ReturnType<typeof io>,
    prior: PriorAppDelivery,
  ) => {
    const priorDelivery = prior.plan.delivery;
    const currentDelivery = input.plan.delivery;
    const priorEffect = prior.plan.effects.find((effect) => effect.kind === "delivery");
    const identityMatches = [
      deps.target !== "gateway",
      prior.operationRef === input.operationRef,
      prior.planDigest === operatorPlanDigest(prior.plan),
      prior.plan.action === "prepare",
      priorEffect?.id === input.effect.id,
      input.effect.kind === "delivery",
      currentDelivery !== undefined,
      priorDelivery !== undefined,
      sameAppDeliveryExceptProjectSettings(input.plan, prior.plan),
    ].every(Boolean);
    if (
      !identityMatches ||
      priorEffect === undefined ||
      priorDelivery === undefined ||
      currentDelivery === undefined
    ) {
      return false;
    }

    const oldMeta = {
      autograph_operator_effect: priorEffect.id,
      autograph_operator_operation: prior.operationRef,
      autograph_operator_plan: prior.planDigest,
    };
    const ids = new Set<string>();
    for (const candidate of prior.deliveryCandidates) {
      if (candidate.operationRef === prior.operationRef) {
        ids.add(candidate.deploymentId);
      }
    }
    let cursor: number | undefined;
    const seen = new Set<number>();
    for (;;) {
      const query: DeploymentListQuery = {
        branch: nativeDeliveryGitRef(prior.plan, priorDelivery, "app"),
        limit: "100",
        projectId: priorDelivery.projectId,
      };
      if (cursor !== undefined) {
        query.until = String(cursor);
      }
      const page = pageSchema.parse(await reader.request("/v7/deployments", { ...query }));
      for (const candidate of page.deployments) {
        if (matchesMetadataIdentity(oldMeta, candidate.meta)) {
          ids.add(candidate.uid);
        }
      }
      const next = page.pagination?.next;
      if (next === undefined || next === null) {
        break;
      }
      if (seen.has(next)) {
        return false;
      }
      seen.add(next);
      cursor = next;
    }
    if (ids.size === 0) {
      return false;
    }

    const observations = await Promise.all(
      [...ids].map(async (deploymentId) => {
        const raw = await reader.request(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
          withGitRepoInfo: "true",
        });
        const blocked = blockedProductionSchema.safeParse(raw);
        if (blocked.success) {
          const observed = blocked.data;
          return [
            observed.id === deploymentId,
            observed.projectId === priorDelivery.projectId,
            observed.ownerId === input.target.scopeId,
            observed.oidcTokenClaims.owner_id === input.target.scopeId,
            observed.oidcTokenClaims.project_id === priorDelivery.projectId,
            String(observed.gitSource.repoId) === priorDelivery.repoId,
            observed.gitSource.ref === nativeDeliveryGitRef(prior.plan, priorDelivery, "app"),
            priorDelivery.gitSha !== undefined && observed.gitSource.sha === priorDelivery.gitSha,
            matchesMetadataIdentity(oldMeta, observed.meta),
            observed.builds.length === 0,
          ].every(Boolean);
        }
        const failedPreview = failedNativePreviewSchema.safeParse(raw);
        if (!failedPreview.success) {
          return false;
        }
        const observed = failedPreview.data;
        return [
          observed.id === deploymentId,
          observed.projectId === priorDelivery.projectId,
          observed.ownerId === input.target.scopeId,
          observed.oidcTokenClaims.owner_id === input.target.scopeId,
          observed.oidcTokenClaims.project_id === priorDelivery.projectId,
          String(observed.gitSource.repoId) === priorDelivery.repoId,
          observed.gitSource.ref === nativeDeliveryGitRef(prior.plan, priorDelivery, "app"),
          priorDelivery.gitSha !== undefined && observed.gitSource.sha === priorDelivery.gitSha,
          matchesMetadataIdentity(oldMeta, observed.meta),
        ].every(Boolean);
      }),
    );
    return observations.every(Boolean);
  };
  const priorAttemptIsProven = async (
    input: HostedOperatorDeploymentContext,
    reader: ReturnType<typeof io>,
  ) => {
    // Renewal preserves an uncertain replacement create for observation only. An empty
    // listing cannot prove that its saved reserved attempt never reached Vercel.
    if (
      deps.target !== "gateway" &&
      input.plan.hostProtection !== undefined &&
      input.plan.appDeliveryReplacement !== undefined &&
      (input.renewalDeliveryProvenance ?? []).some(
        (prior) =>
          isRetentionRenewalDeliveryProvenance(prior, input.plan, input.operationRef) &&
          prior.pendingEffectId === input.effect.id &&
          prior.pendingEffectAttempt !== undefined,
      )
    ) {
      return false;
    }
    const { priorAppDelivery } = input;
    if (priorAppDelivery === undefined) {
      return true;
    }
    try {
      return await priorAppDeliveryIsTerminalFailure(input, reader, priorAppDelivery);
    } catch {
      // Unreadable prior effects stay unknown and never authorize a second POST.
      return false;
    }
  };
  const assignGatewayAlias = async (
    input: HostedOperatorDeploymentContext,
    candidates: OperatorDeploymentCandidate[],
    selected: OperatorDeploymentCandidate,
  ) => {
    const fresh = io({ ...input, deliveryCandidates: candidates });
    await deps.assertEnvironment(input);
    await fresh.assertCurrent();

    let alias: Awaited<ReturnType<typeof fresh.readGatewayAlias>>;
    try {
      const candidate = await fresh.readCandidate(selected.deploymentId);
      if (candidate.readyState !== "READY") {
        return { candidates, status: "unknown" as const };
      }
      alias = await fresh.readGatewayAlias();
      if (alias.redirected) {
        return { candidates, status: "unknown" as const };
      }
      if (alias.deploymentId === selected.deploymentId) {
        return await reconcile({ ...input, deliveryCandidates: candidates });
      }
      if (
        candidates.some((value) => value.gatewayAliasAttempted === true) &&
        !(await fresh.provesDifferentGatewayAliasTarget(alias.deploymentId))
      ) {
        return { candidates, status: "unknown" as const };
      }
      const aliasAuthority = await deps.beforeAliasWrite?.(
        { ...input, deliveryCandidates: candidates },
        selected,
      );
      if (aliasAuthority === "applied") {
        return await reconcile({ ...input, deliveryCandidates: candidates });
      }
      if (aliasAuthority === "unknown") {
        return { candidates, status: "unknown" as const };
      }
      await fresh.assertCurrent();
    } catch {
      // No assignment was dispatched; a later corrected read may safely try again.
      return { candidates, status: "unknown" as const };
    }
    const marked = candidates.map((candidate) =>
      candidate.deploymentId === selected.deploymentId
        ? { ...candidate, gatewayAliasAttempted: true as const }
        : candidate,
    );
    // Persist intent immediately before the outward write. A lost response never authorizes a blind re-POST.
    await input.checkpointDelivery(marked);
    const markedInput = { ...input, deliveryCandidates: marked };
    try {
      await fresh.assertCurrent();
      await fresh.request(
        `/v2/deployments/${encodeURIComponent(selected.deploymentId)}/aliases`,
        {},
        { alias: alias.alias },
        false,
        "assignment",
      );
      return await reconcile(markedInput);
    } catch (error) {
      if (error instanceof RejectedAliasAssignmentError) {
        const rejected = marked.map((candidate) =>
          candidate.deploymentId === selected.deploymentId
            ? { ...candidate, gatewayAliasAttempted: false }
            : candidate,
        );
        try {
          // Only a durably recorded definite rejection permits a later approved retry.
          await input.checkpointDelivery(rejected);
        } catch {
          return { candidates: marked, status: "unknown" as const };
        }
        return {
          candidates: rejected,
          resourceVersion: createHash("sha256")
            .update(JSON.stringify({ candidates: rejected, scope: fresh.delivery }))
            .digest("hex"),
          status: "retryable" as const,
        };
      }
      return { candidates: marked, status: "unknown" as const };
    }
  };
  return {
    async deliver(input: HostedOperatorDeploymentContext) {
      const observation = deliveryDiagnostic(input);
      // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Preserve ordered reconciliation, durable correction claim and provider creation within the same lease.
      const run = async () => {
        observation.at("context");
        const reader = io(input, observation);
        observation.at("authority");
        await reader.assertCurrent();
        observation.at("reconciliation");
        const prior = await reconcile(input, observation);
        if (prior.status === "applied" || prior.status === "unknown") {
          return prior;
        }
        if (deps.target === "gateway") {
          const selected = prior.candidates?.find((candidate) => candidate.readyState === "READY");
          if (selected !== undefined) {
            observation.at("alias_assignment");
            return await assignGatewayAlias(input, prior.candidates, selected);
          }
        }
        // A complete no-match listing is still uncertain; this approved retry is at-least-once and may create another scoped Preview.
        observation.at("environment");
        await deps.assertEnvironment(input);
        observation.at("authority");
        await reader.assertCurrent();
        observation.at("prior_attempt");
        if (!(await priorAttemptIsProven(input, reader))) {
          return { candidates: prior.candidates ?? [], status: "unknown" as const };
        }
        observation.at("project_read");
        const project = projectSchema.parse(
          await reader.request(`/v9/projects/${encodeURIComponent(reader.delivery.projectId)}`),
        );
        observation.at("project_assertion");
        const { gitSha } = reader.delivery;
        if (gitSha === undefined) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const exactProject = [
          project.id === reader.delivery.projectId,
          project.accountId === input.target.scopeId,
          projectLinkMatchesDelivery(project, reader.delivery.repoId, deps.target !== "gateway"),
          reader.delivery.gitSha !== undefined,
        ].every(Boolean);
        if (!exactProject) {
          throw new HostedOperatorError("resource_mismatch");
        }
        observation.at("authority");
        await reader.assertCurrent();
        observation.at("before_create");
        await deps.beforeCreate?.(input);
        observation.at("authority");
        await reader.assertCurrent();
        const correction: OperatorDeliveryCorrection | undefined =
          "correction" in prior ? prior.correction : undefined;
        if (correction !== undefined) {
          if (input.checkpointDeliveryCorrection === undefined) {
            return { candidates: prior.candidates ?? [], status: "unknown" as const };
          }
          // Claim this correction before POST. A lost response may be observed, never blindly repeated.
          observation.at("correction_intent");
          await input.checkpointDeliveryCorrection({ ...correction, createAttempted: true });
          observation.at("authority");
          await reader.assertCurrent();
        }
        observation.at("deployment_create");
        const response = z.object({ id }).parse(
          await reader.request(
            "/v13/deployments",
            {},
            {
              gitSource: {
                ref: reader.gitRef,
                repoId: reader.delivery.repoId,
                sha: gitSha,
                type: "github",
              },
              meta: reader.expectedMeta,
              name: project.name,
              project: project.id,
              target: "staging",
              ...((deps.target ?? "app") === "app" &&
              input.plan.delivery?.projectSettings !== undefined
                ? { projectSettings: input.plan.delivery.projectSettings }
                : {}),
            },
          ),
        );
        observation.at("deployment_readback");
        const candidate = await reader.readCandidateOrRejection(response.id);
        if (candidate === undefined) {
          const rejected = reader.deliveryCorrection();
          if (rejected !== undefined && !rejected.createAttempted) {
            observation.at("correction_intent");
            await input.checkpointDeliveryCorrection?.({ ...rejected, createAttempted: true });
          }
          return { candidates: prior.candidates ?? [], status: "unknown" as const };
        }
        const candidates = [
          ...(prior.candidates ?? []).filter(
            (value) => value.deploymentId !== candidate.deploymentId,
          ),
          candidate,
        ];
        observation.at("checkpoint");
        await input.checkpointDelivery(candidates);
        observation.at("reconciliation");
        const observed = await reconcile({ ...input, deliveryCandidates: candidates }, observation);
        if (deps.target === "gateway" && observed.status === "retryable") {
          const selected = observed.candidates.find((value) => value.readyState === "READY");
          if (selected !== undefined) {
            observation.at("alias_assignment");
            return await assignGatewayAlias(input, observed.candidates, selected);
          }
        }
        return observed;
      };
      try {
        const result = await run();
        observation.finish(result.status);
        return result;
      } catch (error) {
        observation.finish("unknown");
        throw error;
      }
    },
    reconcile,
  };
};

/** Recover provider display identity omitted by an older delivery checkpoint, without a new deployment. */
export const reconcileGatewayAppCandidate = async <T extends HostedOperatorEffectContext>(
  input: T,
  delivery: Pick<ReturnType<typeof createHostedOperatorDeploymentDelivery>, "reconcile">,
): Promise<T> => {
  if (input.plan.stage === "auth-bootstrap") {
    return input;
  }
  const selected = input.deliveryCandidates?.find(
    (candidate) =>
      candidate.readyState === "READY" && candidate.operationRef === input.operationRef,
  );
  if (
    selected === undefined ||
    (selected.projectName !== undefined && selected.scopeSlug !== undefined)
  ) {
    return input;
  }
  const effect = input.plan.effects.find((value) => value.kind === "delivery");
  const { checkpointDelivery } = input;
  if (effect === undefined || checkpointDelivery === undefined) {
    throw new HostedOperatorError("reconciliation_required");
  }
  const observed = await delivery.reconcile({
    ...input,
    effect,
    checkpointDelivery: async (candidates, deploymentId) => {
      if (deploymentId !== undefined && deploymentId !== selected.deploymentId) {
        throw new HostedOperatorError("reconciliation_required");
      }
      await checkpointDelivery(candidates, deploymentId);
    },
  });
  if (observed.status !== "applied" || observed.selected.deploymentId !== selected.deploymentId) {
    throw new HostedOperatorError("reconciliation_required");
  }
  return { ...input, deliveryCandidates: observed.candidates };
};
