import { publicReleaseRequiresNativeGitEvent } from "./public-release-plan-reuse";
import { z } from "zod";
import {
  githubReleaseFailure,
  githubReleaseGraphqlFailure,
} from "./public-release-github-diagnostic";
import { createGitHubTokenOctokit } from "../github/octokit";
import type { PublicReleasePlan } from "./public-release-contract";
import type { PublicReleaseEffectContext, PublicReleaseInvocation } from "./public-release-handler";

const oid = z.string().regex(/^[a-f0-9]{40}$/u);
const repositorySchema = z.object({
  description: z.string(),
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().min(1),
  node_id: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});
const referenceSchema = z.object({ object: z.object({ sha: oid, type: z.literal("commit") }) });
const unavailable = () => new Error("public_release_source_unavailable");

export interface PublicReleaseGitHubDependencies {
  /** Verify canonical owner, exact reviewed publication and current-call consent, including cancellation. */
  assertCurrent: (invocation: PublicReleaseInvocation, plan: PublicReleasePlan) => Promise<void>;
  /** Server-only owner-bound repository installation credential; never a model-supplied token. */
  readCredential: (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
  ) => Promise<
    | {
        token: string;
        repositoryId: string;
        installationId: string;
      }
    | undefined
  >;
  fetch?: typeof fetch;
}

/** Publish approved source only. Native Vercel activation remains provider-owned. */
export const createPublicReleaseGitHubProvider = (deps: PublicReleaseGitHubDependencies) => {
  // A matching ref cannot prove that a build happened after new runtime values were bound.
  // Preserve ambiguous acknowledgments rather than retrying or adopting a pre-existing event.
  const confirmedPublications = new Set<string>();
  const check = async (context: PublicReleaseEffectContext) => {
    context.invocation.signal.throwIfAborted();
    if (context.effect !== "publish-release-source") {
      throw unavailable();
    }
    await deps.assertCurrent(context.invocation, context.plan);
    context.invocation.signal.throwIfAborted();
  };
  const client = async (context: PublicReleaseEffectContext) => {
    await check(context);
    const credential = await deps.readCredential(context.invocation, context.plan);
    await check(context);
    if (
      credential === undefined ||
      credential.token.length === 0 ||
      credential.installationId !== context.plan.source.installationId ||
      credential.repositoryId !== context.plan.source.repositoryId
    ) {
      throw unavailable();
    }
    return createGitHubTokenOctokit({ fetch: deps.fetch, token: credential.token });
  };
  const repository = async (context: PublicReleaseEffectContext) => {
    const github = await client(context);
    const result = await github.request("GET /repositories/{repository_id}", {
      repository_id: context.plan.source.repositoryId,
      request: { signal: context.invocation.signal },
    });
    await check(context);
    const repo = repositorySchema.parse(result.data);
    if (
      repo.id !== context.plan.source.repositoryId ||
      repo.description !==
        `Created by Autograph App Builder request ${context.plan.source.deliveryScope.provisioningRequestId}`
    ) {
      throw unavailable();
    }
    return repo;
  };
  const readRef = async (
    context: PublicReleaseEffectContext,
    repo: z.infer<typeof repositorySchema>,
    branch: string,
  ) => {
    const github = await client(context);
    const result = await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: repo.owner.login,
      ref: `heads/${branch}`,
      repo: repo.name,
      request: { signal: context.invocation.signal },
    });
    await check(context);
    return referenceSchema.parse(result.data).object.sha;
  };
  return {
    async publish(context: PublicReleaseEffectContext) {
      try {
        if (context.priorPhase !== "idle") {
          throw unavailable();
        }
        const repo = await repository(context);
        const source = await readRef(context, repo, context.plan.source.sourceBranch);
        const current = await readRef(context, repo, context.plan.source.productionBranch);
        if (source !== context.plan.source.sourceSha) {
          throw unavailable();
        }
        if (current === source) {
          if (publicReleaseRequiresNativeGitEvent(context.plan)) {
            throw unavailable();
          }
          return;
        }
        if (current !== context.plan.source.expectedProductionSha) {
          throw unavailable();
        }
        const github = await client(context);
        // GitHub performs the expected-before-OID check atomically and rejects non-fast-forward updates.
        // https://docs.github.com/en/graphql/reference/git#updaterefs
        const result = await github.request("POST /graphql", {
          query:
            "mutation($repositoryId: ID!, $name: GitRefname!, $afterOid: GitObjectID!, $beforeOid: GitObjectID!) { updateRefs(input: {repositoryId: $repositoryId, refUpdates: [{name: $name, afterOid: $afterOid, beforeOid: $beforeOid, force: false}]}) { clientMutationId } }",
          request: { signal: context.invocation.signal },
          variables: {
            afterOid: source,
            beforeOid: context.plan.source.expectedProductionSha,
            name: `refs/heads/${context.plan.source.productionBranch}`,
            repositoryId: repo.node_id,
          },
        });
        await check(context);
        const diagnostic = githubReleaseGraphqlFailure(result.data, result.headers);
        if (diagnostic !== undefined) {
          throw diagnostic;
        }
        z.object({
          data: z.object({ updateRefs: z.object({ clientMutationId: z.string().nullable() }) }),
          errors: z.array(z.unknown()).max(0).optional(),
        }).parse(result.data);
        if ((await readRef(context, repo, context.plan.source.productionBranch)) !== source) {
          throw unavailable();
        }
        confirmedPublications.add(context.operationRef);
      } catch (error) {
        context.invocation.signal.throwIfAborted();
        // Do not expose provider bodies, credentials or request URLs to the workflow journal.
        throw githubReleaseFailure(error) ?? unavailable();
      }
    },
    async reconcile(
      context: PublicReleaseEffectContext,
    ): Promise<"applied" | "not-applied" | "unknown"> {
      try {
        const repo = await repository(context);
        const current = await readRef(context, repo, context.plan.source.productionBranch);
        if (current === context.plan.source.sourceSha) {
          return !publicReleaseRequiresNativeGitEvent(context.plan) ||
            confirmedPublications.has(context.operationRef)
            ? "applied"
            : "unknown";
        }
        // Once dispatch may have occurred, a branch that moved back does not establish non-application.
        return context.priorPhase === "idle" &&
          current === context.plan.source.expectedProductionSha
          ? "not-applied"
          : "unknown";
      } catch (error) {
        context.invocation.signal.throwIfAborted();
        throw githubReleaseFailure(error) ?? unavailable();
      }
    },
  };
};
