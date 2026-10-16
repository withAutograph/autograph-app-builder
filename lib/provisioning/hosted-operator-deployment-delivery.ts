/* oxlint-disable eslint/no-await-in-loop -- Provider pages and observed deployment checkpoints are ordered under one real lease. */
import { z } from "zod";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import { HostedOperatorError, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan, OperatorDeploymentCandidate } from "./hosted-operator-contract";
import type { HostedOperatorDeploymentContext } from "./hosted-operator-service";
import { isSharedHostProtectionDeliveryProvenance } from "./hosted-operator-shared-host-protection-successor";

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
const pageSchema = z.object({
  deployments: z.array(z.object({ meta: z.record(z.string(), z.string()).optional(), uid: id })),
  pagination: z.object({ next: z.number().nullable() }).optional(),
});
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
}) => {
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
  const io = (input: HostedOperatorDeploymentContext) => {
    const delivery = deps.target === "gateway" ? input.plan.gatewayDelivery : input.plan.delivery;
    if (delivery === undefined) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const validScope = [
      input.plan.action === "prepare",
      input.effect.kind === (deps.target === "gateway" ? "gateway-delivery" : "delivery"),
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
    const planDigest = operatorPlanDigest(input.plan);
    const expectedMeta = {
      autograph_operator_effect: input.effect.id,
      autograph_operator_operation: input.operationRef,
      autograph_operator_plan: planDigest,
    };
    const gatewayProvenance =
      deps.target === "gateway"
        ? (input.gatewayDeliveryProvenance ?? []).filter((provenance) =>
            isSharedHostProtectionDeliveryProvenance(provenance, input.plan, input.operationRef),
          )
        : [];
    const metadataIdentities = [
      expectedMeta,
      ...gatewayProvenance.flatMap((provenance) => {
        const effect = provenance.plan.effects.find((value) => value.kind === "gateway-delivery");
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
          }
        | { alias: string },
      allowNotFound = false,
      aliasStage?: GatewayAliasDiagnostic["stage"],
    ) => {
      await assertCurrent();
      const credential = await deps.readCredential(input.authority, input.target.installationId);
      if (
        credential?.binding.active !== true ||
        credential.binding.installationId !== input.target.installationId ||
        credential.binding.scopeId !== input.target.scopeId ||
        credential.binding.scopeType !== input.target.scopeType
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      await assertCurrent();
      const url = new URL(pathname, "https://api.vercel.com");
      if (input.target.scopeType === "team") {
        url.searchParams.set("teamId", input.target.scopeId);
      }
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
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
          signal: AbortSignal.any([
            AbortSignal.timeout(20_000),
            ...(input.signal === undefined ? [] : [input.signal]),
          ]),
        });
      const { response, rejectedAssignment } = await sendObserved(
        send,
        aliasStage,
        body === undefined ? "GET" : "POST",
        allowNotFound,
      );
      try {
        if (rejectedAssignment) {
          throw new RejectedAliasAssignmentError();
        }
        if (allowNotFound && response.status === 404) {
          return null;
        }
        if (!response.ok) {
          throw new HostedOperatorError("operator_unavailable");
        }
        const value = z.json().parse(await response.json());
        await assertCurrent();
        return value;
      } finally {
        if (!response.bodyUsed) {
          await response.body?.cancel();
        }
      }
    };
    const readDeployment = async (
      deploymentId: string,
      verifyProject: boolean,
      requireOperatorMetadata: boolean,
    ): Promise<OperatorDeploymentCandidate> => {
      const observed = deploymentSchema.parse(
        await request(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
          withGitRepoInfo: "true",
        }),
      );
      const matches = [
        observed.id === deploymentId,
        observed.projectId === delivery.projectId,
        observed.ownerId === undefined || observed.ownerId === input.target.scopeId,
        String(observed.gitSource.repoId) === delivery.repoId,
        observed.gitSource.ref === delivery.branch,
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
      }
      const saved = input.deliveryCandidates?.find(
        (candidate) =>
          candidate.deploymentId === observed.id && candidate.operationRef === input.operationRef,
      );
      return {
        ...(saved?.gatewayAliasAttempted === undefined
          ? {}
          : { gatewayAliasAttempted: saved.gatewayAliasAttempted }),
        branch: delivery.branch,
        deploymentId: observed.id,
        operationRef: input.operationRef,
        origin: origin.origin,
        projectId: delivery.projectId,
        readyState: observed.readyState,
        repoId: delivery.repoId,
      };
    };
    const readCandidate = async (deploymentId: string, verifyProject = true) =>
      await readDeployment(deploymentId, verifyProject, true);
    const provesDifferentGatewayAliasTarget = async (deploymentId: string | null) => {
      if (gatewayProvenance.length === 0 || deploymentId === null) {
        return false;
      }
      // This is negative evidence about the alias, never an adopted delivery candidate.
      const observed = await readDeployment(deploymentId, true, false);
      return observed.readyState === "READY";
    };
    const readCandidates = async () => {
      const ids = new Set<string>();
      for (const candidate of input.deliveryCandidates ?? []) {
        if (candidate.operationRef === input.operationRef) {
          ids.add(candidate.deploymentId);
        }
      }
      let cursor: number | undefined;
      const seen = new Set<number>();
      for (;;) {
        const query: DeploymentListQuery = {
          branch: delivery.branch,
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
      const candidates = await Promise.all(
        [...ids].map((deploymentId) => readCandidate(deploymentId)),
      );
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
      expectedMeta,
      readCandidate,
      readCandidates,
      readGatewayAlias,
      provesDifferentGatewayAliasTarget,
      request,
    };
  };
  const reconcile = async (input: HostedOperatorDeploymentContext) => {
    try {
      const reader = io(input);
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
          waitedForBuild ||
          candidates.some(
            (candidate) => deps.target === "gateway" && candidate.gatewayAliasAttempted === true,
          )
        ) {
          return { candidates, status: "unknown" as const };
        }
        return {
          candidates,
          resourceVersion: createHash("sha256")
            .update(JSON.stringify({ candidates, scope: reader.delivery }))
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
      const reader = io(input);
      await reader.assertCurrent();
      const prior = await reconcile(input);
      if (prior.status === "applied" || prior.status === "unknown") {
        return prior;
      }
      if (deps.target === "gateway") {
        const selected = prior.candidates?.find((candidate) => candidate.readyState === "READY");
        if (selected !== undefined) {
          return await assignGatewayAlias(input, prior.candidates, selected);
        }
      }
      // A complete no-match listing is still uncertain; this approved retry is at-least-once and may create another scoped Preview.
      await deps.assertEnvironment(input);
      await reader.assertCurrent();
      const project = projectSchema.parse(
        await reader.request(`/v9/projects/${encodeURIComponent(reader.delivery.projectId)}`),
      );
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
      await reader.assertCurrent();
      const response = z.object({ id }).parse(
        await reader.request(
          "/v13/deployments",
          {},
          {
            gitSource: {
              ref: reader.delivery.branch,
              repoId: reader.delivery.repoId,
              sha: gitSha,
              type: "github",
            },
            meta: reader.expectedMeta,
            name: project.name,
            project: project.id,
            ...((deps.target ?? "app") === "app" &&
            input.plan.delivery?.projectSettings !== undefined
              ? { projectSettings: input.plan.delivery.projectSettings }
              : {}),
          },
        ),
      );
      const candidate = await reader.readCandidate(response.id);
      const candidates = [
        ...(prior.candidates ?? []).filter(
          (value) => value.deploymentId !== candidate.deploymentId,
        ),
        candidate,
      ];
      await input.checkpointDelivery(candidates);
      const observed = await reconcile({ ...input, deliveryCandidates: candidates });
      if (deps.target === "gateway" && observed.status === "retryable") {
        const selected = observed.candidates.find((value) => value.readyState === "READY");
        if (selected !== undefined) {
          return await assignGatewayAlias(input, observed.candidates, selected);
        }
      }
      return observed;
    },
    reconcile,
  };
};
