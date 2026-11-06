import { z } from "zod";
import { createGitHubApp, createGitHubTokenOctokit } from "../github/octokit";
import { parseGitHubAppHttpProviderCredentials } from "../repository/github-app-http-provider";
import { mergeHostedGitHubInstallationBindings } from "../repository/postgres-github-installation-store";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import type { PublicReleaseGitHubDependencies } from "./public-release-github-provider";
import type { PublicReleasePlan } from "./public-release-contract";
import type { PublicReleaseInvocation } from "./public-release-handler";

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const oid = z.string().regex(/^[a-f0-9]{40}$/u);
const authenticationSchema = z.object({
  installationId: z.union([z.string(), z.number()]).transform(String),
  permissions: z.strictObject({ contents: z.literal("write"), metadata: z.literal("read") }),
  repositoryIds: z.array(z.union([z.string(), z.number()]).transform(String)),
  token: z.string().min(1),
  type: z.literal("token"),
});
const unavailable = () => new Error("public_release_github_authorization_required");
export interface PublicReleaseGitHubSourceScope {
  installationId: string;
  repositoryId: string;
}
interface CredentialDependencies {
  environment: Readonly<Record<string, string | undefined>>;
  installations: HostedGitHubInstallationStore;
  fetch?: typeof fetch;
}
/** Owner-scoped exact-repository token reader shared by approved source publication lanes. */
export const createOwnerScopedGitHubRepositoryCredentialReader = (
  input: CredentialDependencies,
) => {
  const credentials = parseGitHubAppHttpProviderCredentials({
    appId: input.environment.GITHUB_APP_ID,
    privateKey: input.environment.GITHUB_APP_PRIVATE_KEY,
  });
  const app = createGitHubApp({ ...credentials, fetch: input.fetch });
  return async (
    invocation: PublicReleaseInvocation,
    scope: PublicReleaseGitHubSourceScope,
    assertCurrent: () => Promise<void>,
  ) => {
    const check = async () => {
      invocation.signal.throwIfAborted();
      await assertCurrent();
      invocation.signal.throwIfAborted();
    };
    const binding = async () => {
      await check();
      const bindings = (await input.installations.list?.(invocation.authority)) ?? [];
      await check();
      const legacy = await input.installations.read(invocation.authority);
      await check();
      const matches = mergeHostedGitHubInstallationBindings(bindings, legacy).filter(
        (row) => row.active && row.installationId === scope.installationId,
      );
      if (matches.length !== 1) {
        throw unavailable();
      }
    };
    try {
      decimal.parse(scope.repositoryId);
      decimal.parse(scope.installationId);
      const repositoryNumber = z.coerce
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(scope.repositoryId);
      await binding();
      await check();
      const result: unknown = await app.octokit.auth({
        installationId: scope.installationId,
        permissions: { contents: "write", metadata: "read" },
        refresh: true,
        repositoryIds: [repositoryNumber],
        type: "installation",
      });
      await check();
      const authentication = authenticationSchema.parse(result);
      if (
        authentication.installationId !== scope.installationId ||
        authentication.repositoryIds.length !== 1 ||
        authentication.repositoryIds[0] !== scope.repositoryId
      ) {
        throw unavailable();
      }
      await binding();
      await check();
      return {
        installationId: scope.installationId,
        repositoryId: scope.repositoryId,
        token: authentication.token,
      };
    } catch {
      invocation.signal.throwIfAborted();
      throw unavailable();
    }
  };
};
/** Private request-scoped token reader for an approved immutable release plan. */
export const createPublicReleaseGitHubCredentialReader = (
  input: CredentialDependencies & {
    assertCurrent: PublicReleaseGitHubDependencies["assertCurrent"];
  },
): PublicReleaseGitHubDependencies["readCredential"] => {
  const read = createOwnerScopedGitHubRepositoryCredentialReader(input);
  return async (invocation, plan) =>
    await read(invocation, plan.source, async () => {
      await input.assertCurrent(invocation, plan);
    });
};

/** Read actual refs while constructing a new release plan; no model-provided repository authority. */
export const createPublicReleaseGitHubDestinationReader = (
  input: CredentialDependencies & {
    assertCurrentSourceOwner: (
      invocation: PublicReleaseInvocation,
      scope: PublicReleaseGitHubSourceScope,
    ) => Promise<void>;
  },
) => {
  const read = createOwnerScopedGitHubRepositoryCredentialReader(input);
  return async (
    invocation: PublicReleaseInvocation,
    scope: PublicReleaseGitHubSourceScope &
      Pick<PublicReleasePlan["source"], "productionBranch" | "sourceBranch" | "deliveryScope">,
  ) => {
    const check = async () => {
      invocation.signal.throwIfAborted();
      await input.assertCurrentSourceOwner(invocation, scope);
      invocation.signal.throwIfAborted();
    };
    try {
      await check();
      const credential = await read(invocation, scope, check);
      await check();
      const github = createGitHubTokenOctokit({ fetch: input.fetch, token: credential.token });
      const repository = await github.request("GET /repositories/{repository_id}", {
        repository_id: scope.repositoryId,
        request: { signal: invocation.signal },
      });
      await check();
      const repo = z
        .object({
          description: z.string(),
          id: z.union([z.string(), z.number()]).transform(String),
          name: z.string().min(1),
          owner: z.object({ login: z.string().min(1) }),
        })
        .parse(repository.data);
      if (
        repo.id !== scope.repositoryId ||
        repo.description !==
          `Created by Autograph App Builder request ${scope.deliveryScope.provisioningRequestId}`
      ) {
        throw unavailable();
      }
      const readRef = async (branch: string) => {
        await check();
        const response = await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          owner: repo.owner.login,
          ref: `heads/${branch}`,
          repo: repo.name,
          request: { signal: invocation.signal },
        });
        await check();
        return z
          .object({ object: z.object({ sha: oid, type: z.literal("commit") }) })
          .parse(response.data).object.sha;
      };
      const sourceSha = await readRef(scope.sourceBranch);
      const expectedProductionSha = await readRef(scope.productionBranch);
      await check();
      return {
        deliveryScope: scope.deliveryScope,
        expectedProductionSha,
        installationId: scope.installationId,
        productionBranch: scope.productionBranch,
        repositoryId: scope.repositoryId,
        sourceBranch: scope.sourceBranch,
        sourceSha,
      };
    } catch {
      invocation.signal.throwIfAborted();
      throw unavailable();
    }
  };
};
