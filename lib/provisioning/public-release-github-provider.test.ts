/* oxlint-disable eslint/require-await -- Async test ports preserve production boundaries. */
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createPublicReleaseGitHubProvider } from "./public-release-github-provider";
import { plan as basePlan } from "./public-release-test-fixture";
import type { PublicReleaseEffectContext } from "./public-release-handler";

const fixture = () => {
  const plan = structuredClone(basePlan);
  plan.source.repositoryId = "123";
  let production = plan.source.expectedProductionSha;
  let source = plan.source.sourceSha;
  let authorized = true;
  let loseResponse = false;
  let applyWrite = true;
  let moveBeforeWrite = false;
  const writes: { beforeOid: string; afterOid: string; name: string }[] = [];
  const context: PublicReleaseEffectContext = {
    invocation: {
      authority: plan.authority,
      sessionId: plan.selection.sessionId,
      callId: "approved",
      signal: new AbortController().signal,
    },
    operationRef: "33333333-3333-4333-a333-333333333333",
    plan,
    effect: "publish-release-source",
    priorPhase: "idle",
    bindings: {
      read: async () => ({}),
      claim: async () => {
        throw new Error("unused");
      },
      recordAccepted: async () => {},
      recordVerified: async () => {},
    },
  };
  const provider = createPublicReleaseGitHubProvider({
    assertCurrent: async () => {
      if (!authorized) {
        throw new Error("denied");
      }
    },
    readCredential: async () => ({
      token: "test-token",
      installationId: plan.source.installationId,
      repositoryId: "123",
    }),
    fetch: vi.fn<typeof fetch>(async (resource, init) => {
      const input = z.union([z.string(), z.instanceof(URL), z.instanceof(Request)]).parse(resource);
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://api.github.com");
      if (url.pathname === "/repositories/123") {
        return Response.json({
          id: 123,
          node_id: "repository-node",
          name: "app",
          owner: { login: "owner" },
        });
      }
      if (decodeURIComponent(url.pathname).endsWith("/git/ref/heads/main")) {
        return Response.json({ object: { sha: production, type: "commit" } });
      }
      if (
        decodeURIComponent(url.pathname).endsWith("/git/ref/heads/builder%2Fapp") ||
        decodeURIComponent(url.pathname).endsWith("/git/ref/heads/builder/app")
      ) {
        return Response.json({ object: { sha: source, type: "commit" } });
      }
      if (url.pathname === "/graphql") {
        const body = z
          .object({
            query: z.string(),
            variables: z.object({
              beforeOid: z.string(),
              afterOid: z.string(),
              name: z.string(),
              repositoryId: z.string(),
            }),
          })
          .parse(JSON.parse(z.string().parse(init?.body)));
        expect(body.query).toContain("force: false");
        expect(body.variables.repositoryId).toBe("repository-node");
        writes.push(body.variables);
        if (moveBeforeWrite) {
          production = "f".repeat(40);
        }
        if (production !== body.variables.beforeOid) {
          return Response.json({ errors: [{ message: "branch moved" }], data: null });
        }
        if (applyWrite) {
          production = body.variables.afterOid;
        }
        if (loseResponse) {
          throw new Error("sensitive-provider-response");
        }
        return Response.json({ data: { updateRefs: { clientMutationId: null } } });
      }
      throw new Error("unexpected route");
    }),
  });
  return {
    plan,
    context,
    provider,
    writes,
    setProduction: (v: string) => {
      production = v;
    },
    setSource: (v: string) => {
      source = v;
    },
    revoke: () => {
      authorized = false;
    },
    lose: (accepted = true) => {
      loseResponse = true;
      applyWrite = accepted;
    },
    race: () => {
      moveBeforeWrite = true;
    },
  };
};

it("publishes the approved commit with atomic expected-before and independently reads it back", async () => {
  const f = fixture();
  expect(await f.provider.reconcile(f.context)).toBe("not-applied");
  await f.provider.publish(f.context);
  expect(f.writes).toEqual([
    {
      beforeOid: f.plan.source.expectedProductionSha,
      afterOid: f.plan.source.sourceSha,
      name: "refs/heads/main",
      repositoryId: "repository-node",
    },
  ]);
  expect(await f.provider.reconcile({ ...f.context, priorPhase: "pending" })).toBe("applied");
});
it("reconciles accepted lost response without dispatching twice", async () => {
  const f = fixture();
  f.lose();
  await expect(f.provider.publish(f.context)).rejects.toThrow("public_release_source_unavailable");
  expect(await f.provider.reconcile({ ...f.context, priorPhase: "pending" })).toBe("applied");
  expect(f.writes).toHaveLength(1);
});
it("preserves an unaccepted uncertain publication instead of treating the old ref as retry permission", async () => {
  const f = fixture();
  f.lose(false);
  await expect(f.provider.publish(f.context)).rejects.toThrow("public_release_source_unavailable");
  expect(await f.provider.reconcile({ ...f.context, priorPhase: "pending" })).toBe("unknown");
  await expect(f.provider.publish({ ...f.context, priorPhase: "pending" })).rejects.toThrow(
    "public_release_source_unavailable",
  );
  expect(f.writes).toHaveLength(1);
});
it.each(["source", "production"] as const)(
  "refuses a moved %s ref without a write",
  async (side) => {
    const f = fixture();
    if (side === "source") {
      f.setSource("f".repeat(40));
    } else {
      f.setProduction("f".repeat(40));
    }
    await expect(f.provider.publish(f.context)).rejects.toThrow(
      "public_release_source_unavailable",
    );
    expect(f.writes).toHaveLength(0);
  },
);
it("keeps a provider race visible and never forces a changed branch", async () => {
  const f = fixture();
  f.race();
  await expect(f.provider.publish(f.context)).rejects.toThrow("public_release_source_unavailable");
  expect(await f.provider.reconcile({ ...f.context, priorPhase: "pending" })).toBe("unknown");
  expect(f.writes).toHaveLength(1);
});
it("denies publication after owner or consent revocation", async () => {
  const f = fixture();
  f.revoke();
  await expect(f.provider.publish(f.context)).rejects.toThrow("public_release_source_unavailable");
  expect(f.writes).toHaveLength(0);
});
