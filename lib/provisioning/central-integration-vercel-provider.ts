import { CentralHostPrerequisiteError } from "./central-integration-host-prerequisite";
/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop, sonarjs/expression-complexity, eslint/complexity, react-doctor/server-sequential-independent-await -- Provider IO and durable dispatch/receipt checkpoints must remain ordered. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import type {
  CentralHostSetupPlan,
  CentralHostCallerPlan,
} from "./central-integration-host-contract";
import { vercelProvisionDiagnosticSchema } from "./contracts";
import { centralHostOperationRef } from "./central-integration-host-contract";

export class CentralIntegrationVercelProviderError extends Error {
  readonly diagnostic: z.infer<typeof vercelProvisionDiagnosticSchema>;
  constructor(diagnostic: z.infer<typeof vercelProvisionDiagnosticSchema>) {
    super("central_vercel_provider_rejected");
    this.name = "CentralIntegrationVercelProviderError";
    this.diagnostic = vercelProvisionDiagnosticSchema.parse(diagnostic);
  }
}
const id = z.string().min(1);
const environmentSet = z
  .strictObject({
    slugs: z.array(id).min(1).optional(),
    preset: z.literal("all-custom").optional(),
  })
  .refine((value) => value.slugs !== undefined || value.preset !== undefined);
const rule = z.strictObject({ from: environmentSet, to: environmentSet });
export const centralTrustedSourcesSchema = z.strictObject({
  enableVercelCiSameRepository: z.boolean().optional(),
  projects: z
    .record(
      id,
      z.strictObject({ label: z.string().optional(), customAllow: z.array(rule).optional() }),
    )
    .optional(),
  oidcProviders: z
    .record(
      id,
      z.array(
        z.strictObject({
          label: z.string().optional(),
          to: environmentSet,
          claims: z.record(id, z.array(id).min(1)),
        }),
      ),
    )
    .optional(),
});
type Sources = z.infer<typeof centralTrustedSourcesSchema>;
type Plan = CentralHostSetupPlan | CentralHostCallerPlan;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: z.infer<ReturnType<typeof z.json>>): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Canonical serialization branches only over parsed JSON.
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => {
        if (a < b) {
          return -1;
        }
        if (a > b) {
          return 1;
        }
        return 0;
      })
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
export const centralTrustedSourcesSha256 = (value: Sources) =>
  hash(canonical(centralTrustedSourcesSchema.parse(value)));
const fail = () => new Error("central_vercel_provider_unavailable");
const unknown = () => new Error("central_vercel_provider_outcome_unknown");
const target = (plan: Plan) =>
  plan.kind === "central-integration-host-setup-v1" ? plan.target : plan.central;
const marker = (plan: Plan) => `autograph:central-integrations:${centralHostOperationRef(plan)}`;
const projectSchema = z.object({
  id,
  accountId: id,
  framework: z.literal("services"),
  rootDirectory: z.literal("."),
  link: z.object({
    type: z.literal("github"),
    repoId: z.union([id, z.number()]).transform(String),
  }),
  oidcTokenConfig: z.object({ enabled: z.literal(true), issuerMode: z.literal("team") }),
  trustedSources: centralTrustedSourcesSchema.nullish(),
  microfrontends: z.object({ groupIds: z.array(id).optional() }).nullish(),
});
const webhook = z.object({
  id,
  ownerId: id,
  projectIds: z.array(id),
  events: z.array(id),
  url: z.url(),
});
export interface CentralGrantAttempt {
  beforeSha256: string;
  afterSha256: string;
}
export interface CentralProviderContext<P extends Plan = Plan> {
  plan: P;
  signal: AbortSignal;
  priorPhase: "idle" | "pending" | "applied";
}
export interface CentralGrantContext extends CentralProviderContext {
  grantAttempt?: CentralGrantAttempt;
  claimDispatch: (attempt: CentralGrantAttempt) => Promise<void>;
}
export interface CentralReceiverReceipt {
  id: string;
  secretSha256: string;
}
export interface CentralReceiverContext extends CentralProviderContext<CentralHostSetupPlan> {
  readAccepted: () => Promise<CentralReceiverReceipt | undefined>;
  /** Persist ID and secret in encrypted custody atomically before returning. Never put secret in public journal. */
  persistAccepted: (receipt: CentralReceiverReceipt & { secret: string }) => Promise<void>;
  claimDispatch: () => Promise<void>;
}
export interface CentralBindingState {
  state: "idle" | "pending" | "applied";
  acceptedEnvId?: string;
}
export interface CentralRuntimeContext extends CentralProviderContext<CentralHostSetupPlan> {
  bindings: {
    read: () => Promise<Record<string, CentralBindingState>>;
    claim: (key: string) => Promise<void>;
    recordAccepted: (key: string, envId: string) => Promise<void>;
    recordVerified: (key: string) => Promise<void>;
  };
}
export interface CentralVercelDependencies {
  assertCurrent: (plan: Plan, requireApproval: boolean) => Promise<void>;
  readCredential: (
    plan: Plan,
  ) => Promise<{ token: string; binding: VercelInstallationBinding } | undefined>;
  readRuntimeBindings: (
    plan: CentralHostSetupPlan,
  ) => Promise<readonly { key: string; value: string }[]>;
  fetch?: typeof fetch;
}
const envRow = z.object({
  id,
  key: id,
  type: z.literal("encrypted"),
  target: z.array(id),
  gitBranch: id.nullish(),
  comment: id.optional(),
  configurationId: id.nullish(),
  customEnvironmentIds: z.array(id).optional(),
});
type EnvRow = z.infer<typeof envRow>;

/** Exact provider operations only; enclosing composition owns complete consent and the physical project lease. */
export const createCentralIntegrationVercelProvider = (deps: CentralVercelDependencies) => {
  const check = async (plan: Plan, signal: AbortSignal, approval: boolean) => {
    signal.throwIfAborted();
    await deps.assertCurrent(plan, approval);
    signal.throwIfAborted();
  };
  const request = async (
    plan: Plan,
    signal: AbortSignal,
    path: string,
    method = "GET",
    body?: z.infer<ReturnType<typeof z.json>>,
  ) => {
    await check(plan, signal, method !== "GET");
    const credential = await deps.readCredential(plan);
    await check(plan, signal, method !== "GET");
    const scope = target(plan);
    if (
      credential === undefined ||
      credential.token.length === 0 ||
      !credential.binding.active ||
      credential.binding.scopeType !== "team" ||
      credential.binding.scopeId !== scope.teamId ||
      credential.binding.installationId !== scope.installationId
    )
      throw fail();
    const url = new URL(path, "https://api.vercel.com");
    if (url.origin !== "https://api.vercel.com") throw fail();
    url.searchParams.set("teamId", scope.teamId);
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(url, {
        method,
        headers: {
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw method === "GET" ? fail() : unknown();
    }
    await check(plan, signal, method !== "GET");
    if (!response.ok) {
      const requestRef = vercelProvisionDiagnosticSchema.shape.requestRef.safeParse(
        response.headers.get("x-vercel-id"),
      );
      try {
        await response.body?.cancel();
      } catch {
        /* Preserve bounded HTTP rejection facts. */
      }
      throw new CentralIntegrationVercelProviderError({
        statusCode: response.status,
        ...(requestRef.success ? { requestRef: requestRef.data } : {}),
      });
    }
    if (response.body === null) {
      throw fail();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1_048_576) throw fail();
        chunks.push(chunk.value);
      }
      await check(plan, signal, method !== "GET");
      return z.json().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* Preserve original provider/cancellation failure. */
      }
      reader.releaseLock();
    }
  };
  const project = async (plan: Plan, signal: AbortSignal) => {
    const scope = target(plan);
    const value = projectSchema.parse(
      await request(plan, signal, `/v9/projects/${encodeURIComponent(scope.projectId)}`),
    );
    if (
      value.id !== scope.projectId ||
      value.accountId !== scope.teamId ||
      (value.microfrontends?.groupIds?.length ?? 0) !== 0 ||
      (plan.kind === "central-integration-host-setup-v1" &&
        value.link.repoId !== plan.source.repositoryId)
    )
      throw fail();
    return value;
  };
  const caller = (plan: Plan) =>
    plan.kind === "central-integration-host-setup-v1" ? plan.inspector : plan.caller;
  const assertCallerProject = async (plan: Plan, signal: AbortSignal) => {
    const source = z
      .object({ id, accountId: id })
      .parse(
        await request(plan, signal, `/v9/projects/${encodeURIComponent(caller(plan).projectId)}`),
      );
    const expectedOwner =
      plan.kind === "central-integration-host-caller-v1" ? plan.caller.ownerId : plan.target.teamId;
    if (source.id !== caller(plan).projectId || source.accountId !== expectedOwner) {
      throw fail();
    }
  };
  const desiredRule = (plan: Plan) => ({
    from: { slugs: [caller(plan).environment] },
    to: { slugs: ["preview"] },
  });
  const hasRule = (plan: Plan, sources: Sources) =>
    sources.projects?.[caller(plan).projectId]?.customAllow?.some((entry) =>
      isDeepStrictEqual(entry, desiredRule(plan)),
    ) === true;
  const grantReceipt = (plan: Plan, sources: Sources) => ({
    projectId: target(plan).projectId,
    callerProjectId: caller(plan).projectId,
    environment: caller(plan).environment,
    targetEnvironment: "preview" as const,
    trustedSourcesSha256: centralTrustedSourcesSha256(sources),
    trustedSourcesGrantSha256: hash(
      canonical({
        projectId: target(plan).projectId,
        callerProjectId: caller(plan).projectId,
        environment: caller(plan).environment,
        targetEnvironment: "preview",
        rule: desiredRule(plan),
      }),
    ),
  });
  const readSources = async (plan: Plan, signal: AbortSignal) => {
    const observed = await project(plan, signal);
    return observed.trustedSources ?? {};
  };
  const hooks = async (plan: CentralHostSetupPlan, signal: AbortSignal) =>
    z
      .array(webhook)
      .parse(
        await request(
          plan,
          signal,
          `/v1/webhooks?projectId=${encodeURIComponent(plan.target.projectId)}`,
        ),
      );
  const readHooks = async (context: CentralReceiverContext) =>
    await hooks(context.plan, context.signal);
  const matchesHook = (plan: CentralHostSetupPlan, value: z.infer<typeof webhook>) =>
    value.ownerId === plan.target.teamId &&
    isDeepStrictEqual(value.projectIds, [plan.target.projectId]) &&
    isDeepStrictEqual(value.events.toSorted(), [...plan.receiver.events].toSorted()) &&
    value.url === new URL(plan.receiver.path, plan.receiver.publicOrigin).href;
  const allRows = async (plan: CentralHostSetupPlan, signal: AbortSignal) => {
    const result = z
      .object({
        envs: z.array(
          z.object({
            id,
            key: id,
            type: id,
            target: z.array(id),
            gitBranch: id.nullish(),
            comment: id.optional(),
            configurationId: id.nullish(),
            customEnvironmentIds: z.array(id).optional(),
          }),
        ),
      })
      .parse(
        await request(
          plan,
          signal,
          `/v10/projects/${encodeURIComponent(plan.target.projectId)}/env`,
        ),
      );
    return result.envs;
  };
  const rows = async (context: CentralRuntimeContext) => {
    const values = await allRows(context.plan, context.signal);
    return values.filter(
      (row) =>
        row.target.includes("preview") && row.gitBranch === context.plan.source.operationBranch,
    );
  };
  const selectedRows = async (context: CentralRuntimeContext) => {
    const selected = await rows(context);
    const keys = new Set(context.plan.environment.map((entry) => entry.key));
    if (
      selected.some((row) => !keys.has(row.key)) ||
      new Set(selected.map((row) => row.key)).size !== selected.length
    )
      throw fail();
    return selected.map((row) => {
      const result = envRow.parse(row);
      if (
        result.target.length !== 1 ||
        result.comment !== marker(context.plan) ||
        (result.configurationId !== undefined && result.configurationId !== null) ||
        (result.customEnvironmentIds?.length ?? 0) !== 0
      )
        throw fail();
      return result;
    });
  };
  const valueHash = async (context: CentralRuntimeContext, row: EnvRow) =>
    hash(
      z
        .object({ value: z.string() })
        .parse(
          await request(
            context.plan,
            context.signal,
            `/v1/projects/${encodeURIComponent(context.plan.target.projectId)}/env/${encodeURIComponent(row.id)}`,
          ),
        ).value,
    );
  return {
    async assertInheritedEnvironment(plan: CentralHostSetupPlan, signal: AbortSignal) {
      await project(plan, signal);
      const keys = new Set(plan.environment.map((entry) => entry.key));
      const values = await allRows(plan, signal);
      const inherited = values.filter(
        (row) =>
          row.target.includes("preview") &&
          (row.gitBranch === undefined || row.gitBranch === null || row.gitBranch === ""),
      );
      if (inherited.some((row) => !keys.has(row.key)))
        throw new CentralHostPrerequisiteError("central_host_environment_isolation_required");
    },
    async observeDeployment(
      plan: CentralHostSetupPlan,
      accepted: { providerDeploymentId: string; immutableOrigin: string },
      signal: AbortSignal,
    ) {
      await project(plan, signal);
      const deployment = z
        .object({
          id,
          projectId: id,
          target: z.union([z.null(), z.literal("staging")]),
          url: id,
          readyState: id,
          gitSource: z
            .object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) })
            .nullable()
            .optional(),
        })
        .parse(
          await request(
            plan,
            signal,
            `/v13/deployments/${encodeURIComponent(accepted.providerDeploymentId)}?withGitRepoInfo=true`,
          ),
        );
      if (
        deployment.id !== accepted.providerDeploymentId ||
        deployment.projectId !== plan.target.projectId ||
        `https://${deployment.url}` !== accepted.immutableOrigin
      )
        throw fail();
      return (
        deployment.readyState === "READY" &&
        deployment.gitSource?.sha === plan.source.reviewedSourceSha
      );
    },
    async readTrustedSources(plan: Plan, signal: AbortSignal) {
      const sources = await readSources(plan, signal);
      return { sha256: centralTrustedSourcesSha256(sources) };
    },
    async observeCaller(plan: Plan, signal: AbortSignal) {
      await assertCallerProject(plan, signal);
      const sources = await readSources(plan, signal);
      return hasRule(plan, sources) ? grantReceipt(plan, sources) : undefined;
    },
    async authorizeCaller(context: CentralGrantContext) {
      const { plan, signal } = context;
      await assertCallerProject(plan, signal);
      const before = await readSources(plan, signal);
      const beforeSha256 = centralTrustedSourcesSha256(before);
      if (context.priorPhase !== "idle") {
        if (context.grantAttempt?.afterSha256 === beforeSha256 && hasRule(plan, before))
          return grantReceipt(plan, before);
        throw unknown();
      }
      if (beforeSha256 !== caller(plan).priorGrantSha256) throw fail();
      if (hasRule(plan, before)) return grantReceipt(plan, before);
      const prior = before.projects?.[caller(plan).projectId];
      // Omitted rules imply same-environment defaults; preserve those before adding the single reviewed cross-env rule.
      const defaults = ["production", "preview", "development"].map((slug) => ({
        from: { slugs: [slug] },
        to: { slugs: [slug] },
      }));
      if (prior !== undefined && prior.customAllow === undefined)
        throw new Error("central_trusted_source_defaults_require_review");
      const after: Sources = {
        ...before,
        projects: {
          ...before.projects,
          [caller(plan).projectId]: {
            ...prior,
            customAllow: [...(prior?.customAllow ?? []), desiredRule(plan)],
          },
        },
      };
      void defaults;
      const attempt = { beforeSha256, afterSha256: centralTrustedSourcesSha256(after) };
      await context.claimDispatch(attempt);
      if (centralTrustedSourcesSha256(await readSources(plan, signal)) !== beforeSha256)
        throw unknown();
      await request(
        plan,
        signal,
        `/v9/projects/${encodeURIComponent(target(plan).projectId)}`,
        "PATCH",
        { trustedSources: after },
      );
      const observed = await readSources(plan, signal);
      if (centralTrustedSourcesSha256(observed) !== attempt.afterSha256 || !hasRule(plan, observed))
        throw unknown();
      return grantReceipt(plan, observed);
    },
    async observeReceiver(
      context: CentralReceiverContext,
    ): Promise<CentralReceiverReceipt | undefined> {
      await project(context.plan, context.signal);
      const accepted = await context.readAccepted();
      if (accepted === undefined) return;
      const all = await hooks(context.plan, context.signal);
      const selected = all.filter((entry) => entry.id === accepted.id);
      if (selected.length !== 1 || !matchesHook(context.plan, selected[0])) throw fail();
      await check(context.plan, context.signal, false);
      return accepted;
    },
    async registerReceiver(context: CentralReceiverContext) {
      await project(context.plan, context.signal);
      const accepted = await context.readAccepted();
      if (accepted !== undefined) {
        const all = await hooks(context.plan, context.signal);
        const selected = all.filter((entry) => entry.id === accepted.id);
        if (selected.length !== 1 || !matchesHook(context.plan, selected[0])) throw fail();
        return accepted;
      }
      if (context.priorPhase !== "idle") throw unknown();
      const existingHooks = await readHooks(context);
      if (
        existingHooks.some(
          (entry) =>
            entry.url ===
            new URL(context.plan.receiver.path, context.plan.receiver.publicOrigin).href,
        )
      )
        throw fail();
      await context.claimDispatch();
      const response = webhook.extend({ secret: id }).parse(
        await request(context.plan, context.signal, "/v1/webhooks", "POST", {
          url: new URL(context.plan.receiver.path, context.plan.receiver.publicOrigin).href,
          projectIds: [context.plan.target.projectId],
          events: [...context.plan.receiver.events],
        }),
      );
      if (!matchesHook(context.plan, response)) throw unknown();
      const receipt = { id: response.id, secretSha256: hash(response.secret) };
      await context.persistAccepted({ ...receipt, secret: response.secret });
      const currentHooks = await readHooks(context);
      const observed = currentHooks.filter((entry) => entry.id === receipt.id);
      if (observed.length !== 1 || !matchesHook(context.plan, observed[0])) throw unknown();
      return receipt;
    },
    async bindRuntime(context: CentralRuntimeContext) {
      await project(context.plan, context.signal);
      const values = await deps.readRuntimeBindings(context.plan);
      if (
        values.length !== context.plan.environment.length ||
        new Set(values.map((entry) => entry.key)).size !== values.length ||
        context.plan.environment.some(
          (entry) =>
            !values.some((row) => row.key === entry.key && hash(row.value) === entry.sha256),
        )
      )
        throw fail();
      await selectedRows(context);
      const valuesByKey = new Map(values.map((entry) => [entry.key, entry.value]));
      for (const entry of context.plan.environment) {
        const states = await context.bindings.read();
        const state = states[entry.key];
        const currentRows = await selectedRows(context);
        const current = currentRows.find((row) => row.key === entry.key);
        if (current !== undefined) {
          if (
            state?.acceptedEnvId !== current.id ||
            (await valueHash(context, current)) !== entry.sha256
          )
            throw unknown();
          await context.bindings.recordVerified(entry.key);
          continue;
        }
        if (state?.state !== "idle") throw unknown();
        await context.bindings.claim(entry.key);
        const value = valuesByKey.get(entry.key);
        if (value === undefined) throw fail();
        const result = z.object({ created: envRow }).parse(
          await request(
            context.plan,
            context.signal,
            `/v10/projects/${encodeURIComponent(context.plan.target.projectId)}/env`,
            "POST",
            {
              key: entry.key,
              value,
              type: "encrypted",
              target: ["preview"],
              gitBranch: context.plan.source.operationBranch,
              comment: marker(context.plan),
            },
          ),
        ).created;
        if (
          result.key !== entry.key ||
          result.gitBranch !== context.plan.source.operationBranch ||
          result.comment !== marker(context.plan) ||
          !isDeepStrictEqual(result.target, ["preview"]) ||
          (result.configurationId !== undefined && result.configurationId !== null) ||
          (result.customEnvironmentIds?.length ?? 0) !== 0
        )
          throw unknown();
        await context.bindings.recordAccepted(entry.key, result.id);
        const currentRowsAfterWrite = await selectedRows(context);
        const observed = currentRowsAfterWrite.find((row) => row.id === result.id);
        if (observed === undefined || (await valueHash(context, observed)) !== entry.sha256)
          throw unknown();
        await context.bindings.recordVerified(entry.key);
      }
      await check(context.plan, context.signal, true);
    },
    async observeRuntime(
      context: CentralRuntimeContext,
    ): Promise<{ environmentSha256: string } | undefined> {
      await project(context.plan, context.signal);
      const all = await selectedRows(context);
      const selected = new Map(all.map((row) => [row.key, row]));
      const states = await context.bindings.read();
      for (const entry of context.plan.environment) {
        const row = selected.get(entry.key);
        if (
          row === undefined ||
          states[entry.key]?.acceptedEnvId !== row.id ||
          (await valueHash(context, row)) !== entry.sha256
        )
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence is an explicit readback result, never permission to retry.
          return undefined;
      }
      await check(context.plan, context.signal, false);
      return { environmentSha256: hash(canonical(context.plan.environment)) };
    },
  };
};
