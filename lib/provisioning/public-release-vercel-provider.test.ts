/* oxlint-disable eslint/require-await -- Test ports implement the same asynchronous boundaries as the actual provider adapters. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createPublicReleaseVercelProvider } from "./public-release-vercel-provider";
import type { PublicReleaseVercelDependencies } from "./public-release-vercel-provider";
import type { PublicReleaseEffectContext } from "./public-release-handler";
import { plan as basePlan } from "./public-release-test-fixture";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const requestUrl = (url: Parameters<typeof fetch>[0]) => {
  const input = z.union([z.string(), z.instanceof(URL), z.instanceof(Request)]).parse(url);
  return new URL(input instanceof Request ? input.url : String(input));
};
const fixture = () => {
  const operationRef = "33333333-3333-4333-a333-333333333333";
  const marker = `autograph:public-app-release:${operationRef}`;
  const value = "synthetic-private-runtime-value";
  const plan = structuredClone(basePlan);
  plan.environment = [{ key: "APP_DATABASE_URL", sha256: hash(value) }];
  const invocation = {
    authority: plan.authority,
    sessionId: plan.selection.sessionId,
    callId: "current-approved-call",
    signal: new AbortController().signal,
  };
  const states: Awaited<ReturnType<PublicReleaseEffectContext["bindings"]["read"]>> = {
    APP_DATABASE_URL: { state: "idle" },
  };
  const rows: {
    id: string;
    key: string;
    type: string;
    target: string[];
    comment: string;
    customEnvironmentIds?: string[];
  }[] = [];
  const values = new Map<string, string>();
  const writes: string[] = [];
  let loseWriteResponse = false;
  let writeAccepted = true;
  const project = {
    id: plan.project.projectId,
    accountId: plan.project.teamId,
    framework: "services",
    rootDirectory: ".",
    link: { repoId: plan.source.repositoryId, productionBranch: plan.source.productionBranch },
    ssoProtection: { deploymentType: "prod_deployment_urls_and_all_previews" },
    oidcTokenConfig: { enabled: true, issuerMode: "team" },
    targets: { production: { id: "active-deployment" } },
  };
  const alias = {
    alias: "app.example",
    projectId: plan.project.projectId,
    deploymentId: "active-deployment",
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = requestUrl(url);
    expect(parsed.origin).toBe("https://api.vercel.com");
    expect(parsed.searchParams.get("teamId")).toBe(plan.project.teamId);
    if (init?.method === "POST" || init?.method === "PATCH") {
      expect(parsed.pathname).toMatch(/\/projects\/[^/]+\/env(?:\/[^/]+)?$/u);
      expect(parsed.searchParams.has("upsert")).toBe(false);
      expect(states.APP_DATABASE_URL.state).toBe("pending");
      const body = z
        .object({
          key: z.string(),
          value: z.string(),
          type: z.string(),
          target: z.array(z.string()),
          comment: z.string(),
        })
        .parse(JSON.parse(z.string().parse(init.body)));
      writes.push(parsed.pathname);
      const id =
        init.method === "PATCH" ? (parsed.pathname.split("/").at(-1) ?? "missing") : "new-env";
      const row = {
        id,
        key: body.key,
        type: body.type,
        target: body.target,
        comment: body.comment,
      };
      if (writeAccepted) {
        const existing = rows.findIndex((item) => item.id === id);
        if (existing === -1) {
          rows.push(row);
        } else {
          rows[existing] = row;
        }
        values.set(id, body.value);
      }
      if (loseWriteResponse) {
        throw new Error("synthetic lost transport response");
      }
      return Response.json(init.method === "POST" ? { created: row } : row);
    }
    if (/\/v9\/projects\/[^/]+$/u.test(parsed.pathname)) {
      return Response.json(project);
    }
    if (parsed.pathname.endsWith("/domains/app.example")) {
      return Response.json({ name: "app.example", verified: true });
    }
    if (parsed.pathname === "/v4/aliases/app.example") {
      return Response.json(alias);
    }
    if (parsed.pathname === "/v13/deployments/active-deployment") {
      return Response.json({
        id: "active-deployment",
        projectId: plan.project.projectId,
        target: "production",
        readyState: "READY",
      });
    }
    if (/\/v10\/projects\/[^/]+\/env$/u.test(parsed.pathname)) {
      return Response.json({ envs: rows });
    }
    const rowId = parsed.pathname.split("/").at(-1) ?? "missing";
    if (/\/v1\/projects\/[^/]+\/env\//u.test(parsed.pathname) && values.has(rowId)) {
      return Response.json({ value: values.get(rowId) });
    }
    throw new Error("Unexpected provider route");
  });
  const deps: PublicReleaseVercelDependencies = {
    assertCurrent: vi.fn().mockResolvedValue(),
    readCredential: vi.fn().mockResolvedValue({
      token: "synthetic-private-provider-token",
      binding: {
        installationId: plan.project.installationId,
        scopeId: plan.project.teamId,
        scopeType: "team",
        active: true,
        displayName: "Synthetic",
        slug: "synthetic",
        plan: "pro",
        updatedAt: new Date(0),
      },
    }),
    readRuntimeBindings: vi.fn().mockResolvedValue([{ key: "APP_DATABASE_URL", value }]),
    readDeliveredRelease: vi.fn().mockResolvedValue({ releaseId: plan.runtime.releaseId }),
    fetch: fetcher,
  };
  const context: PublicReleaseEffectContext = {
    invocation,
    plan,
    operationRef,
    effect: "bind-production-runtime",
    priorPhase: "idle",
    bindings: {
      async read() {
        return structuredClone(states);
      },
      async claim(key) {
        if (states[key].state === "idle") {
          states[key] = { ...states[key], state: "pending" };
        }
        return states[key];
      },
      async recordAccepted(key, acceptedEnvId) {
        expect(states[key].state).toBe("pending");
        states[key] = { ...states[key], acceptedEnvId };
      },
      async recordVerified(key) {
        states[key] = { ...states[key], state: "applied" };
      },
    },
  };
  return {
    plan,
    invocation,
    context,
    states,
    rows,
    values,
    writes,
    deps,
    fetcher,
    project,
    alias,
    provider: createPublicReleaseVercelProvider(deps),
    marker,
    value,
    loseResponse(accepted: boolean) {
      loseWriteResponse = true;
      writeAccepted = accepted;
    },
  };
};

it("persists a per-key dispatch before creating and independently reading an encrypted Production binding", async () => {
  const f = fixture();
  await f.provider.bindRuntime(f.context);
  expect(f.states.APP_DATABASE_URL).toEqual({ state: "applied", acceptedEnvId: "new-env" });
  expect(await f.provider.reconcileBindings({ ...f.context, priorPhase: "applied" })).toBe(
    "applied",
  );
  expect(f.writes).toHaveLength(1);
});

it("reconciles an accepted write with a lost response without sending another write", async () => {
  const f = fixture();
  f.loseResponse(true);
  await expect(f.provider.bindRuntime(f.context)).rejects.toThrow("lost transport");
  expect(await f.provider.reconcileBindings({ ...f.context, priorPhase: "pending" })).toBe(
    "applied",
  );
  await f.provider.bindRuntime(f.context);
  expect(f.writes).toHaveLength(1);
});

it("does not treat a missing row after unknown dispatch as permission to retry", async () => {
  const f = fixture();
  f.loseResponse(false);
  await expect(f.provider.bindRuntime(f.context)).rejects.toThrow("lost transport");
  expect(await f.provider.reconcileBindings({ ...f.context, priorPhase: "pending" })).toBe(
    "unknown",
  );
  await expect(f.provider.bindRuntime(f.context)).rejects.toThrow("reconciliation_required");
  expect(f.writes).toHaveLength(1);
});

it("refuses foreign bindings before any mutation", async () => {
  const f = fixture();
  f.rows.push({
    id: "foreign",
    key: "APP_DATABASE_URL",
    type: "encrypted",
    target: ["production"],
    comment: "unrelated-owner",
  });
  await expect(f.provider.bindRuntime(f.context)).rejects.toThrow("provider_mismatch");
  expect(f.writes).toHaveLength(0);
});

it("checks the complete private value projection before writing any variable", async () => {
  const f = fixture();
  f.plan.environment.push({ key: "BETTER_AUTH_SECRET", sha256: hash("expected-private-value") });
  vi.mocked(f.deps.readRuntimeBindings).mockResolvedValue([
    { key: "APP_DATABASE_URL", value: f.value },
    { key: "BETTER_AUTH_SECRET", value: "wrong-value" },
  ]);
  await expect(f.provider.bindRuntime(f.context)).rejects.toThrow("provider_mismatch");
  expect(f.writes).toHaveLength(0);
});

it("requires the current owner credential and permission again after private config lookup", async () => {
  const f = fixture();
  let revoked = false;
  vi.mocked(f.deps.readRuntimeBindings).mockImplementation(async () => {
    revoked = true;
    return [{ key: "APP_DATABASE_URL", value: f.value }];
  });
  vi.mocked(f.deps.assertCurrent).mockImplementation(async () => {
    if (revoked) {
      throw new Error("authorization_required");
    }
  });
  await expect(f.provider.bindRuntime(f.context)).rejects.toThrow("authorization_required");
  expect(f.writes).toHaveLength(0);
});

it("observes only the provider-active Production binding and delivered release", async () => {
  const f = fixture();
  const result = await f.provider.observe(f.invocation, f.plan);
  expect(result).toEqual({
    status: "ready",
    deploymentId: "active-deployment",
    projectId: f.plan.project.projectId,
    environment: "production",
    publicOrigin: f.plan.publicOrigin,
    releaseId: f.plan.runtime.releaseId,
  });
  expect(JSON.stringify(result)).not.toContain("synthetic-private");
  expect(
    f.fetcher.mock.calls.every(
      ([url, init]) => init?.method === "GET" && !requestUrl(url).pathname.endsWith("/deployments"),
    ),
  ).toBe(true);
});

it("does not claim delivery when the public alias points at another project", async () => {
  const f = fixture();
  f.alias.projectId = "foreign-project";
  await expect(f.provider.observe(f.invocation, f.plan)).rejects.toThrow("provider_mismatch");
  expect(f.deps.readDeliveredRelease).not.toHaveBeenCalled();
});

it("keeps deployment readiness pending when the installed app release is unproved", async () => {
  const f = fixture();
  vi.mocked(f.deps.readDeliveredRelease).mockResolvedValue();
  expect(await f.provider.observe(f.invocation, f.plan)).toEqual({ status: "pending" });
});

it("updates only the exact prior owned binding named by the approved plan", async () => {
  const f = fixture();
  const previousOperation = "44444444-4444-4444-a444-444444444444";
  f.plan.environment[0].priorBinding = {
    id: "old-env",
    operationRef: previousOperation,
    valueSha256: hash("old-private-value"),
  };
  f.rows.push({
    id: "old-env",
    key: "APP_DATABASE_URL",
    type: "encrypted",
    target: ["production"],
    comment: `autograph:public-app-release:${previousOperation}`,
  });
  f.values.set("old-env", "old-private-value");
  await f.provider.bindRuntime(f.context);
  expect(f.writes).toEqual([`/v9/projects/${f.plan.project.projectId}/env/old-env`]);
  expect(f.rows).toHaveLength(1);
  expect(f.states.APP_DATABASE_URL.acceptedEnvId).toBe("old-env");
});

it("detects a later conflicting binding before writing earlier absent keys", async () => {
  const f = fixture();
  f.plan.environment.push({ key: "BETTER_AUTH_SECRET", sha256: hash("private-auth") });
  vi.mocked(f.deps.readRuntimeBindings).mockResolvedValue([
    { key: "APP_DATABASE_URL", value: f.value },
    { key: "BETTER_AUTH_SECRET", value: "private-auth" },
  ]);
  f.rows.push({
    id: "foreign",
    key: "BETTER_AUTH_SECRET",
    type: "encrypted",
    target: ["production"],
    comment: "foreign-owner",
  });
  await expect(f.provider.bindRuntime(f.context)).rejects.toThrow("provider_mismatch");
  expect(f.writes).toHaveLength(0);
});

it("does not report an old delivery ready when provider activation changes during app proof", async () => {
  const f = fixture();
  vi.mocked(f.deps.readDeliveredRelease).mockImplementation(async () => {
    f.project.targets.production.id = "new-provider-active-deployment";
    return { releaseId: f.plan.runtime.releaseId };
  });
  expect(await f.provider.observe(f.invocation, f.plan)).toEqual({ status: "pending" });
});

it("refuses a production binding shared with a custom environment before any write", async () => {
  const f = fixture();
  f.plan.environment[0].priorBinding = {
    id: "existing-env",
    operationRef: "44444444-4444-4444-a444-444444444444",
    valueSha256: hash("old"),
  };
  f.rows.push({
    id: "existing-env",
    key: "APP_DATABASE_URL",
    type: "encrypted",
    target: ["production"],
    comment: "autograph:public-app-release:44444444-4444-4444-a444-444444444444",
    customEnvironmentIds: ["staging"],
  });
  f.values.set("existing-env", "old");
  await expect(f.provider.bindRuntime(f.context)).rejects.toThrow(
    "public_release_provider_mismatch",
  );
  expect(f.writes).toHaveLength(0);
});
