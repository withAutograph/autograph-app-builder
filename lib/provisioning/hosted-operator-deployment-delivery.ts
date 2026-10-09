/* oxlint-disable eslint/no-await-in-loop -- Provider pages and observed deployment checkpoints are ordered under one real lease. */
import { z } from "zod";
import { createHash } from "node:crypto";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import { HostedOperatorError, operatorPlanDigest } from "./hosted-operator-contract";
import type { OperatorDeploymentCandidate } from "./hosted-operator-contract";
import type { HostedOperatorDeploymentContext } from "./hosted-operator-service";

interface DeploymentListQuery {
  branch: string;
  limit: string;
  projectId: string;
  until?: string;
}
const id = z.string().min(1);
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
    meta: z.record(z.string(), z.string()),
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
  framework: z.literal("nextjs").nullable(),
  id,
  link: z.object({ repoId: z.union([z.number(), id]), type: z.literal("github") }),
  name: id,
});

/** Explicit approved Preview delivery via normal Git. Candidate IDs are observed effects, never Git/alias authority. */
export const createHostedOperatorDeploymentDelivery = (deps: {
  assertAuthorized: Awaited<
    ReturnType<typeof createHostedOperatorControlPlane>
  >["assertAuthorized"];
  assertEnvironment: (input: HostedOperatorDeploymentContext) => Promise<void>;
  readCredential: Awaited<ReturnType<typeof createHostedOperatorControlPlane>>["readCredential"];
  fetch?: typeof fetch;
  target?: "app" | "gateway";
}) => {
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
        (deps.target === "gateway" ? input.plan.publicGateway?.branch : input.target.branch),
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
    const assertCurrent = async () => {
      await input.assertCurrent();
      await deps.assertAuthorized(input);
    };
    const request = async (
      pathname: string,
      query: Record<string, string> = {},
      body?: {
        gitSource: { ref: string; repoId: string; sha: string; type: "github" };
        meta: Record<string, string>;
        name: string;
        project: string;
        target: "staging";
      },
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
      const response = await (deps.fetch ?? fetch)(url, {
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.token}`,
          "Content-Type": "application/json",
        },
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      try {
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
    const readCandidate = async (deploymentId: string): Promise<OperatorDeploymentCandidate> => {
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
        Object.entries(expectedMeta).every(([key, value]) => observed.meta[key] === value),
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
      const project = projectSchema.parse(
        await request(`/v9/projects/${encodeURIComponent(delivery.projectId)}`),
      );
      const team = z
        .object({ id, slug: id })
        .parse(await request(`/v2/teams/${encodeURIComponent(input.target.scopeId)}`));
      if (
        project.id !== delivery.projectId ||
        project.accountId !== input.target.scopeId ||
        team.id !== input.target.scopeId
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return {
        branch: delivery.branch,
        deploymentId: observed.id,
        operationRef: input.operationRef,
        origin: origin.origin,
        projectId: delivery.projectId,
        readyState: observed.readyState,
        repoId: delivery.repoId,
      };
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
          if (
            Object.entries(expectedMeta).every(([key, value]) => candidate.meta?.[key] === value)
          ) {
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
      const candidates = await Promise.all([...ids].map(readCandidate));
      if (candidates.length !== 0) {
        await input.checkpointDelivery(candidates);
      }
      return candidates;
    };
    return { assertCurrent, delivery, expectedMeta, readCandidate, readCandidates, request };
  };
  const reconcile = async (input: HostedOperatorDeploymentContext) => {
    try {
      const reader = io(input);
      const candidates = await reader.readCandidates();
      const selected = candidates.find((value) => value.readyState === "READY");
      if (selected === undefined) {
        if (
          candidates.some((candidate) =>
            ["BUILDING", "QUEUED", "INITIALIZING"].includes(candidate.readyState),
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
      await input.checkpointDelivery(candidates, selected.deploymentId);
      return { candidates, selected, status: "applied" as const };
    } catch {
      return { status: "unknown" as const };
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
        String(project.link.repoId) === reader.delivery.repoId,
        project.framework === (deps.target === "gateway" ? null : "nextjs"),
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
            target: "staging",
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
      return await reconcile({ ...input, deliveryCandidates: candidates });
    },
    reconcile,
  };
};
