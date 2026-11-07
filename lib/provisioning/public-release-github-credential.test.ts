/* oxlint-disable eslint/require-await -- Test ports retain asynchronous production boundaries. */
import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createPublicReleaseGitHubCredentialReader,
  createPublicReleaseGitHubDestinationReader,
} from "./public-release-github-credential";
import { plan as basePlan } from "./public-release-test-fixture";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fixture = () => {
  const plan = structuredClone(basePlan);
  plan.source.installationId = "456";
  plan.source.repositoryId = "123";
  const invocation = {
    authority: plan.authority,
    callId: "approved",
    sessionId: plan.selection.sessionId,
    signal: new AbortController().signal,
  };
  let active = true;
  let authorized = true;
  let revokeDuringMint = false;
  const mint = vi.fn<typeof fetch>(async (resource, init) => {
    const input = z.union([z.string(), z.instanceof(URL), z.instanceof(Request)]).parse(resource);
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe("https://api.github.com");
    if (url.pathname === "/repositories/123") {
      return Response.json({
        description: `Created by Autograph App Builder request ${plan.project.provisioningRequestId}`,
        id: 123,
        name: "app",
        owner: { login: "owner" },
      });
    }
    const ref = decodeURIComponent(url.pathname);
    if (ref.endsWith("/git/ref/heads/builder/app")) {
      return Response.json({ object: { sha: plan.source.sourceSha, type: "commit" } });
    }
    if (ref.endsWith("/git/ref/heads/main")) {
      return Response.json({ object: { sha: plan.source.expectedProductionSha, type: "commit" } });
    }
    expect(url.pathname).toBe("/app/installations/456/access_tokens");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(z.string().parse(init?.body))).toEqual({
      permissions: { contents: "write", metadata: "read" },
      repository_ids: [123],
    });
    if (revokeDuringMint) {
      active = false;
    }
    return Response.json({
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: "write", metadata: "read" },
      repositories: [{ id: 123 }],
      repository_selection: "selected",
      token: "private-synthetic-installation-token",
    });
  });
  const dependencies: Parameters<typeof createPublicReleaseGitHubCredentialReader>[0] = {
    assertCurrent: async () => {
      if (!authorized) {
        throw new Error("revoked");
      }
    },
    environment: {
      GITHUB_APP_ID: "789",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
    },
    fetch: mint,
    installations: {
      bind: async () => {
        throw new Error("unexpected bind");
      },
      list: async (authority) => {
        expect(authority).toEqual(plan.authority);
        return [
          {
            accountId: "987",
            accountLogin: "owner",
            accountType: "Organization",
            active,
            installationId: "456",
            updatedAt: new Date(),
          },
        ];
      },
      read: async () => {},
    },
  };
  const reader = createPublicReleaseGitHubCredentialReader(dependencies);
  const destination = createPublicReleaseGitHubDestinationReader({
    ...dependencies,
    assertCurrentSourceOwner: async (current, scope) => {
      expect(scope.installationId).toBe(plan.source.installationId);
      expect(scope.repositoryId).toBe(plan.source.repositoryId);
      await dependencies.assertCurrent(current, plan);
    },
  });
  return {
    destination,
    disconnect: () => {
      active = false;
    },
    invocation,
    mint,
    plan,
    race: () => {
      revokeDuringMint = true;
    },
    reader,
    revoke: () => {
      authorized = false;
    },
  };
};
it("mints only for the current owner's selected installation and exact repository", async () => {
  const f = fixture();
  expect(await f.reader(f.invocation, f.plan)).toMatchObject({
    installationId: "456",
    repositoryId: "123",
  });
  expect(f.mint).toHaveBeenCalledOnce();
});
it("does not mint after owner or installation revocation", async () => {
  const f = fixture();
  f.disconnect();
  await expect(f.reader(f.invocation, f.plan)).rejects.toThrow(
    "public_release_github_authorization_required",
  );
  expect(f.mint).not.toHaveBeenCalled();
  const g = fixture();
  g.revoke();
  await expect(g.reader(g.invocation, g.plan)).rejects.toThrow(
    "public_release_github_authorization_required",
  );
  expect(g.mint).not.toHaveBeenCalled();
});
it("withholds the token when installation is disconnected during token mint", async () => {
  const f = fixture();
  f.race();
  await expect(f.reader(f.invocation, f.plan)).rejects.toThrow(
    "public_release_github_authorization_required",
  );
  expect(f.mint).toHaveBeenCalledOnce();
});

it("reads explicit source and provider-linked production refs without choosing a default branch", async () => {
  const f = fixture();
  expect(await f.destination(f.invocation, f.plan.source)).toEqual({
    deliveryScope: f.plan.source.deliveryScope,
    expectedProductionSha: f.plan.source.expectedProductionSha,
    installationId: "456",
    productionBranch: "main",
    repositoryId: "123",
    sourceBranch: "builder/app",
    sourceSha: f.plan.source.sourceSha,
  });
  expect(f.mint).toHaveBeenCalledTimes(4);
});
