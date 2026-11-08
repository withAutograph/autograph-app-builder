import { assertOwnedAppProductionEnvironment } from "./owned-app-auth-environment";
/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop, react-doctor/server-sequential-independent-await, sonarjs/expression-complexity, eslint/complexity, sonarjs/cognitive-complexity -- Provider reads, durable per-key dispatch receipts and authority rechecks must remain ordered. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import type { PublicReleasePlan, PublicReleaseObservation } from "./public-release-contract";
import { publicReleaseRequiresNativeGitEvent } from "./public-release-contract";
import type { PublicReleaseInvocation, PublicReleaseEffectContext } from "./public-release-handler";

import { vercelProvisionDiagnosticSchema } from "./contracts";
import { PublicReleaseProviderError } from "./public-release-provider-error";

const VERCEL_API_ORIGIN = "https://api.vercel.com";

const id = z.string().min(1);
const rowSchema = z.object({
  id,
  key: id,
  type: id,
  target: z.array(id),
  comment: z.string().optional(),
  gitBranch: z.string().nullable().optional(),
  configurationId: z.string().nullable().optional(),
  customEnvironmentIds: z.array(id).optional(),
});
type Row = z.infer<typeof rowSchema>;
const projectSchema = z.object({
  id,
  accountId: id,
  framework: id,
  rootDirectory: id,
  link: z.object({
    type: z.literal("github"),
    repoId: z.union([id, z.number()]).transform(String),
    productionBranch: id,
  }),
  ssoProtection: z.object({ deploymentType: id }),
  oidcTokenConfig: z.object({ enabled: z.boolean(), issuerMode: id }),
  targets: z.object({ production: z.object({ id }).nullable().optional() }).optional(),
  microfrontends: z
    .object({ groupIds: z.array(id).optional() })
    .nullable()
    .optional(),
});
const valueHash = (value: string) => createHash("sha256").update(value).digest("hex");
const assertSnapshotCurrent = async (signal: AbortSignal, assertCurrent: () => Promise<void>) => {
  signal.throwIfAborted();
  await assertCurrent();
  signal.throwIfAborted();
};
const marker = (operationRef: string) => `autograph:public-app-release:${operationRef}`;
const fail = () => new Error("public_release_provider_mismatch");

/** Private server ports. No secret value, credential or provider body is returned or journaled. */
export interface PublicReleaseVercelDependencies {
  assertCurrent: (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
    requireApproval: boolean,
  ) => Promise<void>;
  readCredential: (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
  ) => Promise<{ token: string; binding: VercelInstallationBinding } | undefined>;
  readRuntimeBindings: (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
  ) => Promise<readonly { key: string; value: string }[]>;
  /** Actual deployed app/installation proof for this provider-owned active deployment. */
  readDeliveredRelease: (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
    deploymentId: string,
  ) => Promise<{ releaseId: string } | undefined>;
  fetch?: typeof fetch;
}

const boundedJson = async (
  response: Response,
  signal: AbortSignal,
  maxBytes = 1_048_576,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Private bounded JSON input is immediately parsed by each provider-owned response schema.
): Promise<unknown> => {
  if (!response.body) {
    throw fail();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const discard = async () => {
    try {
      await reader.cancel();
    } catch {
      /* Preserve the original response or cancellation error. */
    }
  };
  const cancel = () => {
    void discard();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        throw fail();
      }
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener("abort", cancel);
    void discard();
    reader.releaseLock();
  }
};

export const createPublicReleaseVercelProvider = (deps: PublicReleaseVercelDependencies) => {
  const check = async (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
    approval: boolean,
  ) => {
    invocation.signal.throwIfAborted();
    await deps.assertCurrent(invocation, plan, approval);
    invocation.signal.throwIfAborted();
  };
  const request = async (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
    route: string,
    approval: boolean,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: {
      key: string;
      value: string;
      type: "encrypted";
      target: ["production"];
      comment: string;
    },
  ) => {
    await check(invocation, plan, approval);
    const credential = await deps.readCredential(invocation, plan);
    await check(invocation, plan, approval);
    if (
      credential === undefined ||
      credential.token.length === 0 ||
      !credential.binding.active ||
      credential.binding.installationId !== plan.project.installationId ||
      credential.binding.scopeType !== "team" ||
      credential.binding.scopeId !== plan.project.teamId
    ) {
      throw fail();
    }
    const url = new URL(route, VERCEL_API_ORIGIN);
    if (url.origin !== VERCEL_API_ORIGIN) {
      throw fail();
    }
    url.searchParams.set("teamId", plan.project.teamId);
    const fetchRequest = deps.fetch ?? fetch;
    const options: RequestInit = {
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      method,
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    options.redirect = "error";
    options.signal = invocation.signal;
    const response = await fetchRequest(url, options);
    await check(invocation, plan, approval);
    if (!response.ok) {
      const requestRef = vercelProvisionDiagnosticSchema.shape.requestRef.safeParse(
        response.headers.get("x-vercel-id"),
      );
      let code: z.output<typeof vercelProvisionDiagnosticSchema>["code"];
      try {
        // Error bodies are untrusted diagnostic input; read only a bounded projection.
        const errorBody = await boundedJson(response, invocation.signal, 16_384);
        const parsed = z
          .object({ error: z.object({ code: vercelProvisionDiagnosticSchema.shape.code }) })
          .safeParse(errorBody);
        if (parsed.success) {
          ({ code } = parsed.data.error);
        }
      } catch {
        invocation.signal.throwIfAborted();
        // Non-JSON, oversized and malformed errors still preserve safe HTTP facts.
      }
      await check(invocation, plan, approval);
      const parseDiagnostic = vercelProvisionDiagnosticSchema.parse.bind(
        vercelProvisionDiagnosticSchema,
      );
      const diagnosticInput: z.input<typeof vercelProvisionDiagnosticSchema> = {
        statusCode: response.status,
      };
      if (code !== undefined) {
        diagnosticInput.code = code;
      }
      if (requestRef.success) {
        diagnosticInput.requestRef = requestRef.data;
      }
      const diagnostic = parseDiagnostic(diagnosticInput);
      throw new PublicReleaseProviderError(diagnostic);
    }
    const result = await boundedJson(response, invocation.signal);
    await check(invocation, plan, approval);
    return result;
  };
  const project = async (
    invocation: PublicReleaseInvocation,
    plan: PublicReleasePlan,
    approval: boolean,
  ) => {
    const current = projectSchema.parse(
      await request(
        invocation,
        plan,
        `/v9/projects/${encodeURIComponent(plan.project.projectId)}`,
        approval,
      ),
    );
    if (
      current.id !== plan.project.projectId ||
      current.accountId !== plan.project.teamId ||
      current.framework !== "services" ||
      current.rootDirectory !== "." ||
      current.link.repoId !== plan.source.repositoryId ||
      current.link.productionBranch !== plan.source.productionBranch ||
      current.ssoProtection.deploymentType !== "prod_deployment_urls_and_all_previews" ||
      !current.oidcTokenConfig.enabled ||
      current.oidcTokenConfig.issuerMode !== "team" ||
      (current.microfrontends?.groupIds?.length ?? 0) > 0
    ) {
      throw fail();
    }
    return current;
  };
  const rows = async (context: PublicReleaseEffectContext) =>
    z
      .object({ envs: z.array(rowSchema) })
      .parse(
        await request(
          context.invocation,
          context.plan,
          `/v10/projects/${encodeURIComponent(context.plan.project.projectId)}/env`,
          true,
        ),
      ).envs;
  const findRow = (context: PublicReleaseEffectContext, all: Row[], key: string) => {
    const matches = all.filter((row) => row.key === key && row.target.includes("production"));
    if (matches.length > 1) {
      throw fail();
    }
    if (matches.length === 0) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing provider state is a distinct reconciliation observation.
      return undefined;
    }
    const [row] = matches;
    const entry = context.plan.environment.find((item) => item.key === key);
    const owned =
      row.comment === marker(context.operationRef) ||
      (entry?.priorBinding?.id === row.id &&
        row.comment === marker(entry.priorBinding.operationRef));
    if (
      !owned ||
      row.type !== "encrypted" ||
      row.target.length !== 1 ||
      (row.gitBranch !== null && row.gitBranch !== undefined) ||
      (row.configurationId !== null && row.configurationId !== undefined) ||
      (row.customEnvironmentIds?.length ?? 0) > 0
    ) {
      throw fail();
    }
    return row;
  };
  const readValue = async (context: PublicReleaseEffectContext, row: Row) =>
    z
      .object({ value: z.string() })
      .parse(
        await request(
          context.invocation,
          context.plan,
          `/v1/projects/${encodeURIComponent(context.plan.project.projectId)}/env/${encodeURIComponent(row.id)}`,
          true,
        ),
      ).value;
  const recordObservedBinding = async (
    context: PublicReleaseEffectContext,
    key: string,
    envId: string,
  ) => {
    const states = await context.bindings.read();
    const state = Object.hasOwn(states, key) ? states[key] : undefined;
    if (
      state === undefined ||
      (state.acceptedEnvId !== undefined && state.acceptedEnvId !== envId)
    ) {
      throw fail();
    }
    if (state.state === "applied") {
      return;
    }
    if (state.state === "idle") {
      await context.bindings.claim(key);
    }
    await context.bindings.recordAccepted(key, envId);
    await context.bindings.recordVerified(key);
  };

  return {
    async reconcileBindings(
      context: PublicReleaseEffectContext,
    ): Promise<"applied" | "not-applied" | "unknown"> {
      await project(context.invocation, context.plan, true);
      const all = await rows(context);
      assertOwnedAppProductionEnvironment(
        context.plan,
        all.flatMap((row) => (row.target.includes("production") ? [row.key] : [])),
      );
      const states = await context.bindings.read();
      let applied = 0;
      for (const entry of context.plan.environment) {
        const row = findRow(context, all, entry.key);
        const state = Object.hasOwn(states, entry.key) ? states[entry.key] : undefined;
        if (!row) {
          if (
            state?.state === "pending" ||
            state?.acceptedEnvId !== undefined ||
            (state === undefined && context.priorPhase !== "idle")
          ) {
            return "unknown";
          }
          continue;
        }
        if (state?.acceptedEnvId !== undefined && state.acceptedEnvId !== row.id) {
          throw fail();
        }
        const hash = valueHash(await readValue(context, row));
        if (hash === entry.sha256) {
          await recordObservedBinding(context, entry.key, row.id);
          applied += 1;
        } else if (state?.state !== "idle" || entry.priorBinding?.valueSha256 !== hash) {
          return "unknown";
        }
      }
      await check(context.invocation, context.plan, true);
      return applied === context.plan.environment.length ? "applied" : "not-applied";
    },
    async bindRuntime(context: PublicReleaseEffectContext) {
      await project(context.invocation, context.plan, true);
      const values = await deps.readRuntimeBindings(context.invocation, context.plan);
      await check(context.invocation, context.plan, true);
      if (
        values.length !== context.plan.environment.length ||
        new Set(values.map((value) => value.key)).size !== values.length
      ) {
        throw fail();
      }
      if (
        !context.plan.environment.every((entry) => {
          const value = values.find((item) => item.key === entry.key)?.value;
          return value !== undefined && valueHash(value) === entry.sha256;
        })
      ) {
        throw fail();
      }
      const valuesByKey = new Map(values.map((item) => [item.key, item.value]));
      const all = await rows(context);
      assertOwnedAppProductionEnvironment(
        context.plan,
        all.flatMap((row) => (row.target.includes("production") ? [row.key] : [])),
      );
      const existing = new Map(
        context.plan.environment.map((entry) => [entry.key, findRow(context, all, entry.key)]),
      );
      for (const entry of context.plan.environment) {
        const current = existing.get(entry.key);
        if (current !== undefined) {
          const hash = valueHash(await readValue(context, current));
          if (hash !== entry.sha256 && hash !== entry.priorBinding?.valueSha256) {
            throw fail();
          }
        }
      }
      for (const entry of context.plan.environment) {
        const value = valuesByKey.get(entry.key);
        if (value === undefined || valueHash(value) !== entry.sha256) {
          throw fail();
        }
        const current = existing.get(entry.key);
        const states = await context.bindings.read();
        const state = Object.hasOwn(states, entry.key) ? states[entry.key] : undefined;
        if (current && valueHash(await readValue(context, current)) === entry.sha256) {
          await recordObservedBinding(context, entry.key, current.id);
          continue;
        }
        if (state?.state !== "idle") {
          throw new Error("public_release_reconciliation_required");
        }
        if (
          current &&
          valueHash(await readValue(context, current)) !== entry.priorBinding?.valueSha256
        ) {
          throw fail();
        }
        await context.bindings.claim(entry.key);
        const suffix = current === undefined ? "" : `/${encodeURIComponent(current.id)}`;
        const route = `/v${current ? "9" : "10"}/projects/${encodeURIComponent(context.plan.project.projectId)}/env${suffix}`;
        const result = await request(
          context.invocation,
          context.plan,
          route,
          true,
          current ? "PATCH" : "POST",
          {
            key: entry.key,
            value,
            type: "encrypted",
            target: ["production"],
            comment: marker(context.operationRef),
          },
        );
        const returned = current
          ? rowSchema.parse(result)
          : z.object({ created: rowSchema }).parse(result).created;
        if (returned.key !== entry.key || (current && returned.id !== current.id)) {
          throw fail();
        }
        await context.bindings.recordAccepted(entry.key, returned.id);
        const observed = findRow(context, await rows(context), entry.key);
        if (
          !observed ||
          observed.id !== returned.id ||
          valueHash(await readValue(context, observed)) !== entry.sha256
        ) {
          throw fail();
        }
        await context.bindings.recordVerified(entry.key);
      }
      await check(context.invocation, context.plan, true);
    },
    async observe(
      invocation: PublicReleaseInvocation,
      plan: PublicReleasePlan,
    ): Promise<PublicReleaseObservation> {
      const current = await project(invocation, plan, false);
      const environment = z
        .object({ envs: z.array(rowSchema) })
        .parse(
          await request(
            invocation,
            plan,
            `/v10/projects/${encodeURIComponent(plan.project.projectId)}/env`,
            false,
          ),
        );
      assertOwnedAppProductionEnvironment(
        plan,
        environment.envs.flatMap((row) => (row.target.includes("production") ? [row.key] : [])),
      );
      const deploymentId = current.targets?.production?.id;
      if (deploymentId === undefined || deploymentId.length === 0) {
        return { status: "pending" };
      }
      if (publicReleaseRequiresNativeGitEvent(plan)) {
        if (plan.project.priorActiveDeploymentId === undefined) {
          throw fail();
        }
        if (deploymentId === plan.project.priorActiveDeploymentId) {
          return { status: "pending" };
        }
      }
      const host = new URL(plan.publicOrigin).hostname;
      const domain = z
        .object({
          name: id,
          verified: z.boolean(),
          gitBranch: z.string().nullable().optional(),
          redirect: z.string().nullable().optional(),
        })
        .parse(
          await request(
            invocation,
            plan,
            `/v9/projects/${encodeURIComponent(plan.project.projectId)}/domains/${encodeURIComponent(host)}`,
            false,
          ),
        );
      const alias = z
        .object({ alias: id, projectId: id, deploymentId: id })
        .parse(await request(invocation, plan, `/v4/aliases/${encodeURIComponent(host)}`, false));
      if (
        domain.name !== host ||
        !domain.verified ||
        (domain.gitBranch !== null && domain.gitBranch !== undefined) ||
        (domain.redirect !== null && domain.redirect !== undefined) ||
        alias.alias !== host ||
        alias.projectId !== plan.project.projectId ||
        alias.deploymentId !== deploymentId
      ) {
        throw fail();
      }
      const deployment = z
        .object({
          id,
          projectId: id,
          target: id,
          readyState: id,
          gitSource: z
            .object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) })
            .nullable()
            .optional(),
        })
        .parse(
          await request(
            invocation,
            plan,
            `/v13/deployments/${encodeURIComponent(deploymentId)}?withGitRepoInfo=true`,
            false,
          ),
        );
      if (
        deployment.id !== deploymentId ||
        deployment.projectId !== plan.project.projectId ||
        deployment.target !== "production"
      ) {
        throw fail();
      }
      if (deployment.readyState !== "READY") {
        return { status: "pending" };
      }
      // Source provenance validates the already provider-selected active delivery. It never elects a deployment.
      if (deployment.gitSource?.sha !== plan.source.sourceSha) {
        return { status: "pending" };
      }
      const release = await deps.readDeliveredRelease(invocation, plan, deploymentId);
      await check(invocation, plan, false);
      if (release?.releaseId !== plan.runtime.releaseId) {
        return { status: "pending" };
      }
      const active = await project(invocation, plan, false);
      const currentAlias = z
        .object({ alias: id, projectId: id, deploymentId: id })
        .parse(await request(invocation, plan, `/v4/aliases/${encodeURIComponent(host)}`, false));
      if (
        active.targets?.production?.id !== deploymentId ||
        currentAlias.alias !== host ||
        currentAlias.projectId !== plan.project.projectId ||
        currentAlias.deploymentId !== deploymentId
      ) {
        return { status: "pending" };
      }
      return {
        status: "ready",
        deploymentId,
        projectId: plan.project.projectId,
        environment: "production",
        publicOrigin: plan.publicOrigin,
        releaseId: release.releaseId,
      };
    },
  };
};

export interface PublicReleaseVercelBindingSnapshotScope {
  projectId: string;
  teamId: string;
  installationId: string;
  keys: readonly string[];
  signal: AbortSignal;
}
/** Read-only planning facts. The caller must additionally prove each prior row in its owner-scoped release journal. */
export const createPublicReleaseVercelBindingSnapshot =
  (deps: {
    assertCurrent: () => Promise<void>;
    assertProjectKeys?: (keys: readonly string[]) => void;
    readCredential: () => Promise<
      { token: string; binding: VercelInstallationBinding } | undefined
    >;
    fetch?: typeof fetch;
  }) =>
  async (scope: PublicReleaseVercelBindingSnapshotScope) => {
    const check = () => assertSnapshotCurrent(scope.signal, deps.assertCurrent);
    const read = async (route: string) => {
      await check();
      const credential = await deps.readCredential();
      await check();
      if (
        credential === undefined ||
        credential.token.length === 0 ||
        !credential.binding.active ||
        credential.binding.installationId !== scope.installationId ||
        credential.binding.scopeType !== "team" ||
        credential.binding.scopeId !== scope.teamId
      ) {
        throw fail();
      }
      const url = new URL(route, VERCEL_API_ORIGIN);
      url.searchParams.set("teamId", scope.teamId);
      const response = await (deps.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${credential.token}` },
        method: "GET",
        redirect: "error",
        signal: scope.signal,
      });
      await check();
      if (!response.ok) {
        await response.body?.cancel();
        throw fail();
      }
      const result = await boundedJson(response, scope.signal);
      await check();
      return result;
    };
    await check();
    if (new Set(scope.keys).size !== scope.keys.length) {
      throw fail();
    }
    const current = projectSchema.parse(
      await read(`/v9/projects/${encodeURIComponent(scope.projectId)}`),
    );
    if (
      current.id !== scope.projectId ||
      current.accountId !== scope.teamId ||
      current.framework !== "services" ||
      current.rootDirectory !== "." ||
      current.ssoProtection.deploymentType !== "prod_deployment_urls_and_all_previews"
    ) {
      throw fail();
    }
    const all = z
      .object({ envs: z.array(rowSchema) })
      .parse(await read(`/v10/projects/${encodeURIComponent(scope.projectId)}/env`)).envs;
    deps.assertProjectKeys?.(
      all.flatMap((row) => (row.target.includes("production") ? [row.key] : [])),
    );
    const snapshots: { key: string; id: string; operationRef: string; sha256: string }[] = [];
    for (const key of scope.keys) {
      const rows = all.filter((row) => row.key === key && row.target.includes("production"));
      if (rows.length === 0) {
        continue;
      }
      if (rows.length !== 1) {
        throw fail();
      }
      const [row] = rows;
      const markerMatch = /^autograph:public-app-release:(?<operationRef>[0-9a-f-]{36})$/u.exec(
        row.comment ?? "",
      );
      const operationRef = z.uuid().safeParse(markerMatch?.groups?.operationRef);
      if (
        !operationRef.success ||
        row.type !== "encrypted" ||
        row.target.length !== 1 ||
        (row.gitBranch !== null && row.gitBranch !== undefined) ||
        (row.configurationId !== null && row.configurationId !== undefined) ||
        (row.customEnvironmentIds?.length ?? 0) > 0
      ) {
        throw fail();
      }
      const { value } = z
        .object({ value: z.string() })
        .parse(
          await read(
            `/v1/projects/${encodeURIComponent(scope.projectId)}/env/${encodeURIComponent(row.id)}`,
          ),
        );
      snapshots.push({
        key,
        id: row.id,
        operationRef: operationRef.data,
        sha256: valueHash(value),
      });
    }
    await check();
    return snapshots;
  };

/** Trusted planning snapshot; the ID only excludes the prior active deployment, never selects a replacement. */
export const createPublicReleaseVercelActiveDeploymentSnapshot =
  (deps: {
    assertCurrent: () => Promise<void>;
    readCredential: () => Promise<
      { token: string; binding: VercelInstallationBinding } | undefined
    >;
    fetch?: typeof fetch;
  }) =>
  async (
    scope: Omit<PublicReleaseVercelBindingSnapshotScope, "keys"> & {
      repositoryId: string;
      productionBranch: string;
    },
  ): Promise<{ priorActiveDeploymentId: string | null }> => {
    const check = () => assertSnapshotCurrent(scope.signal, deps.assertCurrent);
    await check();
    const credential = await deps.readCredential();
    await check();
    if (
      !credential ||
      !credential.token ||
      !credential.binding.active ||
      credential.binding.installationId !== scope.installationId ||
      credential.binding.scopeType !== "team" ||
      credential.binding.scopeId !== scope.teamId
    ) {
      throw fail();
    }
    const url = new URL(`/v9/projects/${encodeURIComponent(scope.projectId)}`, VERCEL_API_ORIGIN);
    url.searchParams.set("teamId", scope.teamId);
    const response = await (deps.fetch ?? fetch)(url, {
      headers: { authorization: `Bearer ${credential.token}` },
      method: "GET",
      redirect: "error",
      signal: scope.signal,
    });
    await check();
    if (!response.ok) {
      await response.body?.cancel();
      throw fail();
    }
    const current = projectSchema.parse(await boundedJson(response, scope.signal));
    await check();
    if (
      current.id !== scope.projectId ||
      current.accountId !== scope.teamId ||
      current.framework !== "services" ||
      current.rootDirectory !== "." ||
      current.link.repoId !== scope.repositoryId ||
      current.link.productionBranch !== scope.productionBranch ||
      current.ssoProtection.deploymentType !== "prod_deployment_urls_and_all_previews" ||
      !current.oidcTokenConfig.enabled ||
      current.oidcTokenConfig.issuerMode !== "team" ||
      (current.microfrontends?.groupIds?.length ?? 0) > 0
    ) {
      throw fail();
    }
    return { priorActiveDeploymentId: current.targets?.production?.id ?? null };
  };
