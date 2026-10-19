import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { ReadyDeliveryReplacementPredecessor } from "./hosted-operator-ready-delivery-replacement";
import { isNativePreviewDeployment } from "./hosted-operator-deployment-delivery";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";

const id = z.string().min(1);
const deployment = z.object({
  id,
  projectId: id,
  ownerId: id,
  readyState: z.literal("READY"),
  url: id,
  target: z.string().nullable(),
  customEnvironment: z.unknown().optional(),
  oidcTokenClaims: z.unknown().optional(),
  gitSource: z.object({
    ref: id,
    repoId: z.union([id, z.number()]),
    sha: id,
    type: z.literal("github"),
  }),
});
/** Closed native metadata reads only. This never reads policy or touches an old delivery/alias attempt. */
export const createReadyReplacementNativeReader = (ports: {
  context: HostedOperatorContext;
  assertCurrent: () => Promise<void>;
  readCredential: Awaited<ReturnType<typeof createHostedOperatorControlPlane>>["readCredential"];
  fetch?: typeof fetch;
}) => {
  const request = async (path: string) => {
    await ports.assertCurrent();
    const { target, authority } = ports.context;
    const credential = await ports.readCredential(authority, target.installationId);
    if (
      !credential ||
      !credential.binding.active ||
      credential.binding.installationId !== target.installationId ||
      credential.binding.scopeId !== target.scopeId ||
      credential.binding.scopeType !== "team" ||
      target.scopeType !== "team"
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    await ports.assertCurrent();
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", target.scopeId);
    const response = await (ports.fetch ?? fetch)(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      headers: { Authorization: `Bearer ${credential.token}` },
    });
    if (!response.ok) {
      throw new HostedOperatorError("reconciliation_required");
    }
    await ports.assertCurrent();
    return z.json().parse(await response.json());
  };
  const readGatewayAlias = async (plan: HostedOperatorPlan) => {
    const gateway = plan.publicGateway;
    if (!gateway) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const alias = new URL(gateway.origin).hostname;
    const observed = z
      .object({
        alias: id,
        deploymentId: id,
        projectId: id,
        redirect: z.string().nullable().optional(),
      })
      .parse(await request(`/v4/aliases/${encodeURIComponent(alias)}`));
    if (
      observed.alias.toLowerCase() !== alias ||
      observed.projectId !== gateway.projectId ||
      (observed.redirect !== undefined && observed.redirect !== null && observed.redirect !== "")
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return observed.deploymentId;
  };
  return {
    readGatewayAlias,
    async aliasWriteAuthority(
      plan: HostedOperatorPlan,
      selectedDeploymentId: string,
    ): Promise<"write" | "applied" | "unknown"> {
      const predecessor = plan.appDeliveryReplacement?.predecessor.gatewayDeploymentId;
      if (predecessor === undefined) {
        return "unknown";
      }
      const actual = await readGatewayAlias(plan);
      if (actual === selectedDeploymentId) {
        return "applied";
      }
      return actual === predecessor ? "write" : "unknown";
    },
    async verify(
      plan: HostedOperatorPlan,
      predecessor: Pick<
        ReadyDeliveryReplacementPredecessor,
        "originatingOperator" | "appCandidate" | "gatewayCandidate"
      >,
    ) {
      const previous = predecessor.originatingOperator;
      for (const [candidate, source] of [
        [predecessor.appCandidate, previous.plan.delivery],
        [predecessor.gatewayCandidate, previous.plan.gatewayDelivery],
      ] as const) {
        if (!candidate) {
          continue;
        }
        if (!source) {
          throw new HostedOperatorError("resource_mismatch");
        }
        const project = z
          .object({ id, accountId: id })
          .parse(await request(`/v9/projects/${encodeURIComponent(candidate.projectId)}`));
        const native = deployment.parse(
          await request(`/v13/deployments/${encodeURIComponent(candidate.deploymentId)}`),
        );
        const origin = new URL(`https://${native.url}`);
        if (
          project.id !== candidate.projectId ||
          project.accountId !== ports.context.target.scopeId ||
          native.id !== candidate.deploymentId ||
          native.projectId !== candidate.projectId ||
          native.ownerId !== project.accountId ||
          !isNativePreviewDeployment(native) ||
          origin.origin !== candidate.origin ||
          origin.pathname !== "/" ||
          origin.search !== "" ||
          origin.hash !== "" ||
          origin.username !== "" ||
          origin.password !== "" ||
          native.gitSource.ref !== source.branch ||
          String(native.gitSource.repoId) !== source.repoId ||
          (source.gitSha !== undefined && native.gitSource.sha !== source.gitSha)
        ) {
          throw new HostedOperatorError("resource_mismatch");
        }
      }
      if (
        predecessor.gatewayCandidate &&
        (await readGatewayAlias(plan)) !== predecessor.gatewayCandidate.deploymentId
      ) {
        throw new HostedOperatorError("reconciliation_required");
      }
    },
  };
};
