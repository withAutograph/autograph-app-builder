/* oxlint-disable eslint/require-await -- Faithful private async journal/provider ports resolve immediately in this deterministic provider fixture. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { expect, test } from "vitest";
import { plan as original } from "./central-integration-host-test-fixture";
import { centralHostCallerPlanSchema } from "./central-integration-host-contract";
import {
  centralTrustedSourcesSchema,
  centralTrustedSourcesSha256,
  createCentralIntegrationVercelProvider,
} from "./central-integration-vercel-provider";
import type {
  CentralGrantAttempt,
  CentralBindingState,
  CentralReceiverReceipt,
} from "./central-integration-vercel-provider";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fixture = () => {
  let sources = centralTrustedSourcesSchema.parse({
    enableVercelCiSameRepository: false,
    projects: {
      peer: {
        label: "Keep peer",
        customAllow: [{ from: { slugs: ["production"] }, to: { slugs: ["preview"] } }],
      },
    },
    oidcProviders: {
      "https://issuer.example": [
        { to: { slugs: ["preview"] }, claims: { sub: ["exact-existing-subject"] } },
      ],
    },
  });
  const plan = {
    ...original,
    environment: [{ key: "INTEGRATIONS_DATABASE_URL", sha256: digest("private-runtime-value") }],
    inspector: { ...original.inspector, priorGrantSha256: centralTrustedSourcesSha256(sources) },
  };
  let active = true;
  let failMutation = false;
  let rejectProvider = false;
  let posts = 0;
  let patches = 0;
  const envs: {
    id: string;
    key: string;
    type: string;
    target: string[];
    gitBranch?: string;
    comment?: string;
  }[] = [];
  const hooks: {
    id: string;
    ownerId: string;
    projectIds: string[];
    events: string[];
    url: string;
  }[] = [];
  const states = new Map<string, CentralBindingState>([
    ["INTEGRATIONS_DATABASE_URL", { state: "idle" }],
  ]);
  let accepted: CentralReceiverReceipt | undefined;
  let privateSecret: string | undefined;
  let grantAttempt: CentralGrantAttempt | undefined;
  let dispatched = false;
  const api = createCentralIntegrationVercelProvider({
    assertCurrent: async () => {
      if (!active) throw new Error("revoked");
    },
    readCredential: async () => ({
      token: "private-provider-token",
      binding: {
        installationId: plan.target.installationId,
        scopeId: plan.target.teamId,
        scopeType: "team",
        active: true,
        displayName: "Fixture",
        slug: "fixture",
        plan: "fixture",
        updatedAt: new Date(0),
      },
    }),
    readRuntimeBindings: async () => [
      { key: "INTEGRATIONS_DATABASE_URL", value: "private-runtime-value" },
    ],
    // oxlint-disable-next-line sonarjs/cognitive-complexity, eslint/complexity -- Stateful fake provider models distinct request/response and lost-response branches.
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = z.string().parse(init?.method);
      if (rejectProvider) {
        return new Response("raw-private-provider-message", {
          status: 403,
          headers: { "x-vercel-id": "iad1::safe-request-reference" },
        });
      }
      expect(url.origin).toBe("https://api.vercel.com");
      expect(url.searchParams.get("teamId")).toBe(plan.target.teamId);
      expect(init?.redirect).toBe("error");
      if (method !== "GET") {
        expect(dispatched || [...states.values()].some((state) => state.state === "pending")).toBe(
          true,
        );
        if (method === "PATCH") patches += 1;
        else posts += 1;
      }
      const body: unknown =
        init?.body === undefined ? undefined : JSON.parse(z.string().parse(init.body));
      if (url.pathname === `/v9/projects/${plan.target.projectId}`) {
        if (method === "PATCH") {
          sources = z
            .object({ trustedSources: centralTrustedSourcesSchema })
            .parse(body).trustedSources;
          if (failMutation) throw new Error("lost response");
        }
        return Response.json({
          id: plan.target.projectId,
          accountId: plan.target.teamId,
          framework: "services",
          rootDirectory: ".",
          link: { type: "github", repoId: plan.source.repositoryId },
          oidcTokenConfig: { enabled: true, issuerMode: "team" },
          trustedSources: sources,
        });
      }
      if (url.pathname.startsWith("/v9/projects/")) {
        return Response.json({ id: url.pathname.split("/").at(-1), accountId: plan.target.teamId });
      }
      if (url.pathname === "/v1/webhooks") {
        if (method === "POST") {
          const hook = {
            ...z
              .object({
                url: z.string(),
                events: z.array(z.string()),
                projectIds: z.array(z.string()),
              })
              .parse(body),
            id: "accepted-webhook",
            ownerId: plan.target.teamId,
          };
          hooks.push(hook);
          if (failMutation) throw new Error("lost response");
          return Response.json({ ...hook, secret: "private-webhook-signing-secret" });
        }
        return Response.json(hooks);
      }
      if (url.pathname.endsWith("/env") && method === "POST") {
        const row = {
          ...z
            .object({
              key: z.string(),
              value: z.string(),
              type: z.string(),
              target: z.array(z.string()),
              gitBranch: z.string(),
              comment: z.string(),
            })
            .parse(body),
          id: "accepted-env",
        };
        envs.push(row);
        if (failMutation) throw new Error("lost response");
        return Response.json({ created: row });
      }
      if (url.pathname.endsWith("/env")) return Response.json({ envs });
      if (url.pathname.endsWith("/env/accepted-env"))
        return Response.json({ value: "private-runtime-value" });
      throw new Error("unexpected provider path");
    },
  });
  const signal = new AbortController().signal;
  const grant = () => ({
    plan,
    signal,
    priorPhase: "idle" as const,
    claimDispatch: async (attempt: CentralGrantAttempt) => {
      grantAttempt = attempt;
      dispatched = true;
    },
  });
  const receiver = () => ({
    plan,
    signal,
    priorPhase: "idle" as const,
    claimDispatch: async () => {
      dispatched = true;
    },
    readAccepted: async () => accepted,
    persistAccepted: async (value: CentralReceiverReceipt & { secret: string }) => {
      accepted = { id: value.id, secretSha256: value.secretSha256 };
      privateSecret = value.secret;
    },
  });
  const runtime = () => ({
    plan,
    signal,
    priorPhase: "idle" as const,
    bindings: {
      read: async () => Object.fromEntries(states),
      claim: async (key: string) => {
        states.set(key, { state: "pending" });
      },
      recordAccepted: async (key: string, id: string) => {
        states.set(key, { state: "pending", acceptedEnvId: id });
      },
      recordVerified: async (key: string) => {
        states.set(key, { ...states.get(key), state: "applied" });
      },
    },
  });
  return {
    api,
    plan,
    signal,
    grant,
    receiver,
    runtime,
    envs,
    hooks,
    states,
    sources: () => sources,
    setSources: (value: typeof sources) => {
      sources = value;
    },
    counts: () => ({ posts, patches }),
    rejectProvider: () => {
      rejectProvider = true;
    },
    setLost: () => {
      failMutation = true;
    },
    revoke: () => {
      active = false;
    },
    attempt: () => grantAttempt,
    secret: () => privateSecret,
  };
};
test("one exact cross-env grant preserves peer/OIDC/CI and reconciles only captured after-state", async () => {
  const f = fixture();
  const before = structuredClone(f.sources());
  const receipt = await f.api.authorizeCaller(f.grant());
  expect(f.counts().patches).toBe(1);
  expect(f.sources().projects?.peer).toEqual(before.projects?.peer);
  expect(f.sources().oidcProviders).toEqual(before.oidcProviders);
  expect(f.sources().enableVercelCiSameRepository).toBe(false);
  expect(f.sources().projects?.[f.plan.inspector.projectId]?.customAllow).toEqual([
    { from: { slugs: ["preview"] }, to: { slugs: ["preview"] } },
  ]);
  expect(
    await f.api.authorizeCaller({ ...f.grant(), priorPhase: "pending", grantAttempt: f.attempt() }),
  ).toEqual(receipt);
  expect(f.counts().patches).toBe(1);
});
test("lost grant response settles only exact attempt; drift remains unknown and cannot retry", async () => {
  const f = fixture();
  f.setLost();
  await expect(f.api.authorizeCaller(f.grant())).rejects.toThrow();
  expect(
    await f.api.authorizeCaller({ ...f.grant(), priorPhase: "pending", grantAttempt: f.attempt() }),
  ).toMatchObject({ targetEnvironment: "preview" });
  f.setSources({ ...f.sources(), enableVercelCiSameRepository: true });
  await expect(
    f.api.authorizeCaller({ ...f.grant(), priorPhase: "pending", grantAttempt: f.attempt() }),
  ).rejects.toThrow("outcome_unknown");
  expect(f.counts().patches).toBe(1);
});
test("prior-state drift and default wildcard semantics fail before grant mutation", async () => {
  const f = fixture();
  f.setSources({ ...f.sources(), enableVercelCiSameRepository: true });
  await expect(f.api.authorizeCaller(f.grant())).rejects.toThrow();
  expect(f.counts().patches).toBe(0);
  const g = fixture();
  g.setSources({
    ...g.sources(),
    projects: {
      ...g.sources().projects,
      [g.plan.inspector.projectId]: { label: "implicit same-env defaults" },
    },
  });
  g.plan.inspector.priorGrantSha256 = centralTrustedSourcesSha256(g.sources());
  await expect(g.api.authorizeCaller(g.grant())).rejects.toThrow("defaults_require_review");
  expect(g.counts().patches).toBe(0);
});
test("caller production grant has exact target and retains unrelated project rules", async () => {
  const f = fixture();
  const setup = {
    operationRef: "11111111-1111-5111-a111-111111111111",
    planDigest: "a".repeat(64),
  };
  const plan = centralHostCallerPlanSchema.parse({
    version: 1,
    kind: "central-integration-host-caller-v1",
    authority: f.plan.authority,
    selection: f.plan.selection,
    profile: f.plan.profile,
    setup,
    setupAuthority: f.plan.authority,
    central: {
      projectId: f.plan.target.projectId,
      teamId: f.plan.target.teamId,
      installationId: f.plan.target.installationId,
      providerDeploymentId: "native-id",
      immutableOrigin: "https://immutable.vercel.app",
      configurationSha256: "a".repeat(64),
    },
    caller: {
      projectId: "app-project",
      ownerId: f.plan.target.teamId,
      environment: "production",
      targetEnvironment: "preview",
      provisioningRequestId: "11111111-1111-4111-a111-111111111111",
      provisioningDigest: "b".repeat(64),
      priorGrantSha256: centralTrustedSourcesSha256(f.sources()),
    },
    effects: ["authorize-app-central-caller"],
  });
  await f.api.authorizeCaller({ ...f.grant(), plan });
  expect(f.sources().projects?.[plan.caller.projectId]?.customAllow).toEqual([
    { from: { slugs: ["production"] }, to: { slugs: ["preview"] } },
  ]);
});
test("webhook signing secret is privately persisted once before readback and replay", async () => {
  const f = fixture();
  const receipt = await f.api.registerReceiver(f.receiver());
  expect(f.secret()).toBe("private-webhook-signing-secret");
  expect(JSON.stringify(receipt)).not.toContain(f.secret());
  expect(await f.api.registerReceiver({ ...f.receiver(), priorPhase: "pending" })).toEqual(receipt);
  expect(await f.api.observeReceiver(f.receiver())).toEqual(receipt);
  expect(f.counts().posts).toBe(1);
});
test("lost webhook response never adopts matching URL or recreates an uncertain subscription", async () => {
  const f = fixture();
  f.setLost();
  await expect(f.api.registerReceiver(f.receiver())).rejects.toThrow();
  expect(f.secret()).toBeUndefined();
  expect(await f.api.observeReceiver({ ...f.receiver(), priorPhase: "pending" })).toBeUndefined();
  await expect(f.api.registerReceiver({ ...f.receiver(), priorPhase: "pending" })).rejects.toThrow(
    "outcome_unknown",
  );
  expect(f.counts().posts).toBe(1);
});
test("branch runtime binds exact encrypted values and leaves global/peer branch rows unchanged", async () => {
  const f = fixture();
  f.envs.push(
    { id: "global", key: "KEEP_GLOBAL", type: "encrypted", target: ["preview"] },
    {
      id: "peer-branch",
      key: "KEEP_PEER",
      type: "encrypted",
      target: ["preview"],
      gitBranch: "peer-branch",
    },
  );
  const originalRows = f.envs.slice();
  await f.api.bindRuntime(f.runtime());
  expect(f.envs.slice(0, 2)).toEqual(originalRows);
  expect(await f.api.observeRuntime(f.runtime())).toBeDefined();
  await f.api.bindRuntime({ ...f.runtime(), priorPhase: "pending" });
  expect(f.counts().posts).toBe(1);
});
test("lost environment response cannot adopt owned-looking row without accepted provider ID", async () => {
  const f = fixture();
  f.setLost();
  await expect(f.api.bindRuntime(f.runtime())).rejects.toThrow();
  expect(await f.api.observeRuntime(f.runtime())).toBeUndefined();
  await expect(f.api.bindRuntime({ ...f.runtime(), priorPhase: "pending" })).rejects.toThrow(
    "outcome_unknown",
  );
  expect(f.counts().posts).toBe(1);
});
test("revoked authority prevents every mutation and private value read", async () => {
  const f = fixture();
  f.revoke();
  await expect(f.api.authorizeCaller(f.grant())).rejects.toThrow("revoked");
  await expect(f.api.registerReceiver(f.receiver())).rejects.toThrow("revoked");
  await expect(f.api.bindRuntime(f.runtime())).rejects.toThrow("revoked");
  expect(f.counts()).toEqual({ posts: 0, patches: 0 });
});

test("drift after durable grant claim prevents any PATCH", async () => {
  const f = fixture();
  const context = f.grant();
  await expect(
    f.api.authorizeCaller({
      ...context,
      claimDispatch: async (attempt) => {
        await context.claimDispatch(attempt);
        f.setSources({ ...f.sources(), enableVercelCiSameRepository: true });
      },
    }),
  ).rejects.toThrow("outcome_unknown");
  expect(f.counts().patches).toBe(0);
});
test("failure to retain webhook secret leaves one uncertain subscription and no retry", async () => {
  const f = fixture();
  await expect(
    f.api.registerReceiver({
      ...f.receiver(),
      persistAccepted: async () => {
        throw new Error("private custody unavailable");
      },
    }),
  ).rejects.toThrow();
  await expect(f.api.registerReceiver({ ...f.receiver(), priorPhase: "pending" })).rejects.toThrow(
    "outcome_unknown",
  );
  expect(f.counts().posts).toBe(1);
});
test("runtime manifest mismatch and foreign selected-branch keys fail before effects", async () => {
  const f = fixture();
  f.plan.environment[0].sha256 = "f".repeat(64);
  await expect(f.api.bindRuntime(f.runtime())).rejects.toThrow();
  expect(f.counts().posts).toBe(0);
  const g = fixture();
  g.envs.push({
    id: "foreign",
    key: "UNREVIEWED",
    type: "encrypted",
    target: ["preview"],
    gitBranch: g.plan.source.operationBranch,
  });
  await expect(g.api.bindRuntime(g.runtime())).rejects.toThrow();
  expect(g.counts().posts).toBe(0);
});

test("adding another app grant does not invalidate an existing caller grant receipt", async () => {
  const f = fixture();
  const before = await f.api.authorizeCaller(f.grant());
  f.setSources({
    ...f.sources(),
    projects: {
      ...f.sources().projects,
      newApp: { customAllow: [{ from: { slugs: ["production"] }, to: { slugs: ["preview"] } }] },
    },
  });
  const after = await f.api.observeCaller(f.plan, f.signal);
  expect(after?.trustedSourcesGrantSha256).toBe(before.trustedSourcesGrantSha256);
  expect(after?.trustedSourcesSha256).not.toBe(before.trustedSourcesSha256);
});

test("provider denial exposes only bounded status/reference, never raw response or credentials", async () => {
  const f = fixture();
  f.rejectProvider();
  await expect(f.api.readTrustedSources(f.plan, f.signal)).rejects.toMatchObject({
    message: "central_vercel_provider_rejected",
    diagnostic: { statusCode: 403, requestRef: "iad1::safe-request-reference" },
  });
});
test("central isolation rejects inherited unscoped Preview credentials without provider writes", async () => {
  const f = fixture();
  f.envs.push({
    id: "foreign-auth",
    key: "BETTER_AUTH_SECRET",
    type: "encrypted",
    target: ["preview"],
  });
  await expect(f.api.assertInheritedEnvironment(f.plan, f.signal)).rejects.toMatchObject({
    code: "central_host_environment_isolation_required",
  });
  expect(f.counts()).toEqual({ posts: 0, patches: 0 });
});
test("central isolation leaves Production and another Preview branch untouched", async () => {
  const f = fixture();
  f.envs.push(
    { id: "production-auth", key: "BETTER_AUTH_SECRET", type: "encrypted", target: ["production"] },
    {
      id: "other-preview",
      key: "DATABASE_URL",
      type: "encrypted",
      target: ["preview"],
      gitBranch: "unrelated",
    },
  );
  await expect(f.api.assertInheritedEnvironment(f.plan, f.signal)).resolves.toBeUndefined();
  expect(f.envs).toHaveLength(2);
  expect(f.counts()).toEqual({ posts: 0, patches: 0 });
});
