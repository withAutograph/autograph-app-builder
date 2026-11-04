import { z } from "zod";
import type { CentralHostEffectContext } from "./central-integration-host-service";
import type { CentralHostSetupPlan } from "./central-integration-host-contract";
import type { PublicReleaseInvocation } from "./public-release-handler";

const oid = z.string().regex(/^[a-f0-9]{40}$/u);
const repository = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
});
const ref = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal("commit"), sha: oid }),
});
const unavailable = () => new Error("central_host_source_unavailable");
export const createCentralHostGitHubProvider = (input: {
  assertCurrent: (invocation: PublicReleaseInvocation, plan: CentralHostSetupPlan) => Promise<void>;
  readCredential: (
    invocation: PublicReleaseInvocation,
    plan: CentralHostSetupPlan,
  ) => Promise<{ token: string; repositoryId: string; installationId: string }>;
  fetch?: typeof fetch;
}) => {
  const read = async (
    invocation: PublicReleaseInvocation,
    plan: CentralHostSetupPlan,
    suffix: string,
    method: "GET" | "POST" = "GET",
    body?: object,
  ) => {
    invocation.signal.throwIfAborted();
    await input.assertCurrent(invocation, plan);
    const credential = await input.readCredential(invocation, plan);
    if (
      credential.repositoryId !== plan.source.repositoryId ||
      credential.installationId !== plan.source.installationId
    )
      throw unavailable();
    await input.assertCurrent(invocation, plan);
    const headers = {
      authorization: `Bearer ${credential.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    const ownedResponse = await (input.fetch ?? fetch)(
      `https://api.github.com/repositories/${encodeURIComponent(plan.source.repositoryId)}`,
      { method: "GET", redirect: "error", signal: invocation.signal, headers },
    );
    await input.assertCurrent(invocation, plan);
    if (!ownedResponse.ok) {
      throw unavailable();
    }
    const owned = repository.parse(await ownedResponse.json());
    if (owned.id !== plan.source.repositoryId) {
      throw unavailable();
    }
    if (suffix === "") {
      return owned;
    }
    const response = await (input.fetch ?? fetch)(
      `https://api.github.com/repos/${owned.full_name}${suffix}`,
      {
        method,
        redirect: "error",
        signal: invocation.signal,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    await input.assertCurrent(invocation, plan);
    if (response.status === 404 && method === "GET") return undefined;
    if (!response.ok) throw unavailable();
    return await response.json();
  };
  const branch = (plan: CentralHostSetupPlan) =>
    `/git/ref/heads/${plan.source.operationBranch.split("/").map(encodeURIComponent).join("/")}`;
  const inspect = async (invocation: PublicReleaseInvocation, plan: CentralHostSetupPlan) => {
    const owned = repository.parse(await read(invocation, plan, ""));
    if (owned.id !== plan.source.repositoryId) {
      throw unavailable();
    }
    const source = z
      .object({ sha: oid })
      .parse(await read(invocation, plan, `/git/commits/${plan.source.reviewedSourceSha}`));
    if (source.sha !== plan.source.reviewedSourceSha) throw unavailable();
    const observed = await read(invocation, plan, branch(plan));
    if (observed === undefined) return undefined;
    const parsed = ref.parse(observed);
    if (
      parsed.ref !== `refs/heads/${plan.source.operationBranch}` ||
      parsed.object.sha !== plan.source.reviewedSourceSha
    )
      throw unavailable();
    return {
      effect: "publish-central-host-source" as const,
      repositoryId: plan.source.repositoryId,
      branch: plan.source.operationBranch,
      sourceSha: plan.source.reviewedSourceSha,
    };
  };
  return {
    inspect,
    async publish(context: CentralHostEffectContext) {
      if (
        context.plan.kind !== "central-integration-host-setup-v1" ||
        context.effect !== "publish-central-host-source" ||
        context.priorPhase !== "idle"
      )
        throw unavailable();
      await context.assertCurrent();
      if ((await inspect(context.invocation, context.plan)) !== undefined) throw unavailable();
      await context.assertCurrent();
      const result = ref.parse(
        await read(context.invocation, context.plan, "/git/refs", "POST", {
          ref: `refs/heads/${context.plan.source.operationBranch}`,
          sha: context.plan.source.reviewedSourceSha,
        }),
      );
      if (
        result.ref !== `refs/heads/${context.plan.source.operationBranch}` ||
        result.object.sha !== context.plan.source.reviewedSourceSha
      )
        throw unavailable();
      const receipt = {
        effect: "publish-central-host-source" as const,
        repositoryId: context.plan.source.repositoryId,
        branch: context.plan.source.operationBranch,
        sourceSha: context.plan.source.reviewedSourceSha,
      };
      await context.checkpoint.recordAccepted(receipt);
      if ((await inspect(context.invocation, context.plan)) === undefined) throw unavailable();
      return receipt;
    },
  };
};
