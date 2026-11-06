/* oxlint-disable eslint/require-await -- Async test ports preserve production boundaries. */
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createPublicReleaseGitHubProvider } from "./public-release-github-provider";
import { plan as basePlan } from "./public-release-test-fixture";
import type { PublicReleaseEffectContext } from "./public-release-handler";

const fixture = () => {
  const plan = structuredClone(basePlan);
  plan.source.repositoryId = "123";
  let description = `Created by Autograph App Builder request ${plan.project.provisioningRequestId}`;
  let production = plan.source.expectedProductionSha;
  let source = plan.source.sourceSha;
  let authorized = true;
  let loseResponse = false;
  let applyWrite = true;
  let moveBeforeWrite = false;
  const writes: { beforeOid: string; afterOid: string; name: string }[] = [];
  const context: PublicReleaseEffectContext = {
    bindings: {
      claim: async () => {
        throw new Error("unused");
      },
      read: async () => ({}),
      recordAccepted: async () => {},
      recordVerified: async () => {},
    },
    effect: "publish-release-source",
    invocation: {
      authority: plan.authority,
      callId: "approved",
      sessionId: plan.selection.sessionId,
      signal: new AbortController().signal,
    },
    operationRef: "33333333-3333-4333-a333-333333333333",
    plan,
    priorPhase: "idle",
  };
  const provider = createPublicReleaseGitHubProvider({
    assertCurrent: async () => {
      if (!authorized) {
        throw new Error("denied");
      }
    },
    fetch: vi.fn<typeof fetch>(async (resource, init) => {
      const input = z.union([z.string(), z.instanceof(URL), z.instanceof(Request)]).parse(resource);
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://api.github.com");
      if (url.pathname === "/repositories/123") {
        return Response.json({
          description,
          id: 123,
          name: "app",
          node_id: "repository-node",
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
              afterOid: z.string(),
              beforeOid: z.string(),
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
          return Response.json({ data: null, errors: [{ message: "branch moved" }] });
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
    readCredential: async () => ({
      installationId: plan.source.installationId,
      repositoryId: "123",
      token: "test-token",
    }),
  });
  return {
    context,
    foreignRepository: () => {
      description = "Shared platform repository";
    },
    lose: (accepted = true) => {
      loseResponse = true;
      applyWrite = accepted;
    },
    plan,
    provider,
    race: () => {
      moveBeforeWrite = true;
    },
    revoke: () => {
      authorized = false;
    },
    setProduction: (v: string) => {
      production = v;
    },
    setSource: (v: string) => {
      source = v;
    },
    writes,
  };
};

it("publishes the approved commit with atomic expected-before and independently reads it back", async () => {
  const f = fixture();
  expect(await f.provider.reconcile(f.context)).toBe("not-applied");
  await f.provider.publish(f.context);
  expect(f.writes).toEqual([
    {
      afterOid: f.plan.source.sourceSha,
      beforeOid: f.plan.source.expectedProductionSha,
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
  await expect(f.provider.publish(f.context)).rejects.toMatchObject({
    diagnostic: { provider: "github", statusCode: 200 },
  });
  expect(await f.provider.reconcile({ ...f.context, priorPhase: "pending" })).toBe("unknown");
  expect(f.writes).toHaveLength(1);
});
it("denies publication after owner or consent revocation", async () => {
  const f = fixture();
  f.revoke();
  await expect(f.provider.publish(f.context)).rejects.toThrow("public_release_source_unavailable");
  expect(f.writes).toHaveLength(0);
});

it("refuses a shared or foreign repository before any publication, even with matching IDs and refs", async () => {
  const f = fixture();
  f.foreignRepository();
  await expect(f.provider.publish(f.context)).rejects.toThrow("public_release_source_unavailable");
  await expect(f.provider.reconcile(f.context)).rejects.toThrow(
    "public_release_source_unavailable",
  );
  expect(f.writes).toEqual([]);
});

it("requires a confirmed native Git event after changed runtime bindings", async () => {
  const f = fixture();
  f.plan.purpose = "auth-bootstrap";
  f.setProduction(f.plan.source.sourceSha);
  expect(await f.provider.reconcile(f.context)).toBe("unknown");
  await expect(f.provider.publish(f.context)).rejects.toThrow("public_release_source_unavailable");
  expect(f.writes).toHaveLength(0);
});
it("does not adopt a lost acknowledgment as evidence of a build after changed bindings", async () => {
  const f = fixture();
  f.plan.purpose = "application";
  f.lose();
  await expect(f.provider.publish(f.context)).rejects.toThrow("public_release_source_unavailable");
  expect(await f.provider.reconcile({ ...f.context, priorPhase: "pending" })).toBe("unknown");
  expect(f.writes).toHaveLength(1);
});
it("confirms its own native Git event, and permits unchanged runtime reuse", async () => {
  const f = fixture();
  f.plan.purpose = "auth-bootstrap";
  await f.provider.publish(f.context);
  expect(await f.provider.reconcile(f.context)).toBe("applied");
  const unchanged = fixture();
  unchanged.plan.purpose = "application";
  unchanged.plan.environment = unchanged.plan.environment.map((entry) => ({
    ...entry,
    priorBinding: {
      id: "env-owned",
      operationRef: unchanged.context.operationRef,
      valueSha256: entry.sha256,
    },
  }));
  unchanged.setProduction(unchanged.plan.source.sourceSha);
  expect(await unchanged.provider.reconcile(unchanged.context)).toBe("applied");
  await unchanged.provider.publish(unchanged.context);
  expect(unchanged.writes).toHaveLength(0);
});
