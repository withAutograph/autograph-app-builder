import { z } from "zod";
import { HostedOperatorError, nativeDeliveryGitRef } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { ReadyDeliveryReplacementPredecessor } from "./hosted-operator-ready-delivery-replacement";
import { readyDeliveryReplacementIntentSchema } from "./hosted-operator-ready-delivery-replacement-intent";
import { isNativePreviewDeployment } from "./hosted-operator-deployment-delivery";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";

const id = z.string().min(1);
const hasMatchingCredential = (
  credential:
    | {
        binding: {
          active: boolean;
          installationId: string;
          scopeId: string;
          scopeType: string;
        };
      }
    | null
    | undefined,
  target: HostedOperatorContext["target"],
) => {
  if (!credential) {
    return false;
  }
  const matchesInstallation =
    credential.binding.active && credential.binding.installationId === target.installationId;
  const matchesScope =
    credential.binding.scopeId === target.scopeId && credential.binding.scopeType === "team";
  return matchesInstallation && matchesScope && target.scopeType === "team";
};
const deployment = z.object({
  customEnvironment: z.unknown().optional(),
  gitSource: z.object({
    ref: id,
    repoId: z.union([id, z.number()]),
    sha: id,
    type: z.literal("github"),
  }),
  id,
  oidcTokenClaims: z.unknown().optional(),
  ownerId: id,
  projectId: id,
  readyState: z.literal("READY"),
  target: z.string().nullable(),
  url: id,
});
const matchesOrigin = (origin: URL, candidateOrigin: string) => {
  const validBase = origin.origin === candidateOrigin && origin.pathname === "/";
  const hasNoQueryOrFragment = origin.search === "" && origin.hash === "";
  const hasNoCredentials = origin.username === "" && origin.password === "";
  return validBase && hasNoQueryOrFragment && hasNoCredentials;
};
const matchesDeliverySource = (
  native: z.infer<typeof deployment>,
  previousPlan: HostedOperatorPlan,
  source: NonNullable<HostedOperatorPlan["delivery"]>,
  target: "app" | "gateway",
) => {
  const matchesRepository = String(native.gitSource.repoId) === source.repoId;
  const matchesSha = source.gitSha === undefined || native.gitSource.sha === source.gitSha;
  const matchesRef = native.gitSource.ref === nativeDeliveryGitRef(previousPlan, source, target);
  return matchesRef && matchesRepository && matchesSha;
};
const isReplacementIntent = (value: HostedOperatorPlan["appDeliveryReplacement"]) =>
  readyDeliveryReplacementIntentSchema.safeParse(value);
const verifyCandidate = async (
  candidate: NonNullable<
    | ReadyDeliveryReplacementPredecessor["appCandidate"]
    | ReadyDeliveryReplacementPredecessor["gatewayCandidate"]
  >,
  source:
    | NonNullable<HostedOperatorPlan["delivery"]>
    | NonNullable<HostedOperatorPlan["gatewayDelivery"]>,
  target: "app" | "gateway",
  previousPlan: HostedOperatorPlan,
  ports: {
    context: HostedOperatorContext;
    assertCurrent: () => Promise<void>;
    readCredential: Awaited<ReturnType<typeof createHostedOperatorControlPlane>>["readCredential"];
    fetch?: typeof fetch;
  },
  request: (
    path: string,
  ) => Promise<z.output<typeof deployment> | { accountId: string; id: string }>,
) => {
  const project = z
    .object({ accountId: id, id })
    .parse(await request(`/v9/projects/${encodeURIComponent(candidate.projectId)}`));
  const native = deployment.parse(
    await request(`/v13/deployments/${encodeURIComponent(candidate.deploymentId)}`),
  );
  const projectMismatch =
    project.id !== candidate.projectId || project.accountId !== ports.context.target.scopeId;
  const deploymentMismatch =
    native.id !== candidate.deploymentId ||
    native.projectId !== candidate.projectId ||
    native.ownerId !== project.accountId;
  const identityMismatch = projectMismatch || deploymentMismatch;
  const metadataMismatch =
    !isNativePreviewDeployment(native) ||
    !matchesOrigin(new URL(`https://${native.url}`), candidate.origin) ||
    !matchesDeliverySource(native, previousPlan, source, target);
  if (identityMismatch || metadataMismatch) {
    throw new HostedOperatorError("resource_mismatch");
  }
};
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
    if (!hasMatchingCredential(credential, target)) {
      throw new HostedOperatorError("authorization_required");
    }
    await ports.assertCurrent();
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", target.scopeId);
    const response = await (ports.fetch ?? fetch)(url, {
      cache: "no-store",
      credentials: "omit",
      headers: { Authorization: `Bearer ${credential.token}` },
      method: "GET",
      redirect: "error",
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
    const hasRedirect =
      observed.redirect !== undefined && observed.redirect !== null && observed.redirect !== "";
    if (
      observed.alias.toLowerCase() !== alias ||
      observed.projectId !== gateway.projectId ||
      hasRedirect
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return observed.deploymentId;
  };
  return {
    async aliasWriteAuthority(
      plan: HostedOperatorPlan,
      selectedDeploymentId: string,
    ): Promise<"write" | "applied" | "unknown"> {
      const parsedReplacement = isReplacementIntent(plan.appDeliveryReplacement);
      if (!parsedReplacement.success) {
        return "unknown";
      }
      const predecessor = parsedReplacement.data.predecessor.gatewayDeploymentId;
      if (predecessor === undefined) {
        return "unknown";
      }
      const actual = await readGatewayAlias(plan);
      if (actual === selectedDeploymentId) {
        return "applied";
      }
      return actual === predecessor ? "write" : "unknown";
    },
    readGatewayAlias,
    async verify(
      plan: HostedOperatorPlan,
      predecessor: Pick<
        ReadyDeliveryReplacementPredecessor,
        "originatingOperator" | "appCandidate" | "gatewayCandidate"
      >,
    ) {
      const previous = predecessor.originatingOperator;
      const candidateChecks = [
        predecessor.appCandidate !== undefined && previous.plan.delivery !== undefined
          ? verifyCandidate(
              predecessor.appCandidate,
              previous.plan.delivery,
              "app",
              previous.plan,
              ports,
              request,
            )
          : Promise.resolve(),
        predecessor.gatewayCandidate !== undefined && previous.plan.gatewayDelivery !== undefined
          ? verifyCandidate(
              predecessor.gatewayCandidate,
              previous.plan.gatewayDelivery,
              "gateway",
              previous.plan,
              ports,
              request,
            )
          : Promise.resolve(),
      ];
      await Promise.all(candidateChecks);
      if (
        predecessor.gatewayCandidate &&
        (await readGatewayAlias(plan)) !== predecessor.gatewayCandidate.deploymentId
      ) {
        throw new HostedOperatorError("reconciliation_required");
      }
    },
  };
};
