/* oxlint-disable eslint/no-await-in-loop, sonarjs/expression-complexity, sonarjs/no-nested-functions, react-doctor/async-await-in-loop -- Provider writes and their durable readbacks are deliberately sequential. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createHostedOperatorRealmLinkConfig } from "./hosted-operator-realm-link-config";
import { z } from "zod";
import {
  resolveNativePreviewEnvironmentGitBranch,
  savedPreviewEnvironmentGitBranch,
  matchesPreviewEnvironmentGitBranch,
} from "./native-preview-environment-scope";
import {
  createHostedOperatorConsentDiagnostic,
  projectOperatorGatewayProviderFailure,
} from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  OperatorGatewayBindingsDiagnostic,
} from "./hosted-operator-consent-diagnostic";
import type { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { isRetentionRenewalBindingProvenance } from "./hosted-operator-retention-renewal";
import {
  canonicalGatewayEnvironmentRowsSchema,
  HostedOperatorError,
  plannedAppBranch,
} from "./hosted-operator-contract";
import type {
  CanonicalGatewayEnvironmentRow,
  ManagedOperatorEnvironmentRow,
} from "./hosted-operator-contract";
import type {
  GatewayManagedEnvironmentContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";

const providerRow = z.object({
  comment: z.string().optional(),
  configurationId: z.string().nullable().optional(),
  gitBranch: z.string().nullable().optional(),
  id: z.string().min(1),
  key: z.string().min(1),
  target: z.array(z.string()),
  type: z.string(),
});
type ProviderRow = z.infer<typeof providerRow>;
// Public Vercel project Trusted Sources schema; retain unrelated provider-owned fields on round-trip.
const trustedEnvironmentSet = z.looseObject({
  slugs: z.array(z.string()).optional(),
  preset: z.literal("all-custom").optional(),
});
const trustedProjectSource = z.looseObject({
  label: z.string().optional(),
  customAllow: z
    .array(z.looseObject({ from: trustedEnvironmentSet, to: trustedEnvironmentSet }))
    .optional(),
});
const trustedSourcesSchema = z.looseObject({
  projects: z.record(z.string(), trustedProjectSource).optional(),
  oidcProviders: z
    .record(
      z.string(),
      z.array(
        z.looseObject({
          label: z.string().optional(),
          claims: z.record(z.string(), z.array(z.string())),
          to: trustedEnvironmentSet,
        }),
      ),
    )
    .optional(),
  enableVercelCiSameRepository: z.boolean().optional(),
});
const trustedProjectSnapshot = z.object({
  id: z.string(),
  accountId: z.string(),
  trustedSources: trustedSourcesSchema.nullish(),
});
type ApprovedTrustedSources = NonNullable<
  NonNullable<GatewayManagedEnvironmentContext["plan"]["gatewayBindings"]>["trustedSources"]
>;
type SourceRuleValues<T> = T extends object ? T[keyof T] : never;
type TrustedSourceRule = NonNullable<SourceRuleValues<ApprovedTrustedSources>>;
const coversTrustedSource = (
  sources: z.infer<typeof trustedSourcesSchema>,
  rule: TrustedSourceRule,
) => {
  const source = sources.projects?.[rule.projectId];
  if (source === undefined) {
    return false;
  }
  // An existing foreign project without overrides retains its same-environment defaults.
  if (source.customAllow === undefined) {
    return rule.from === rule.to;
  }
  return source.customAllow.some(
    (allow) =>
      allow.from.slugs?.includes(rule.from) === true && allow.to.slugs?.includes(rule.to) === true,
  );
};

const hasOnlyApprovedSourcePairs = (
  sources: z.infer<typeof trustedSourcesSchema>,
  projectId: string,
  approved: TrustedSourceRule[],
) => {
  const rules = sources.projects?.[projectId]?.customAllow;
  if (rules === undefined) {
    return false;
  }
  const pairs = new Set(
    approved.flatMap((rule) => (rule.projectId === projectId ? [`${rule.from}:${rule.to}`] : [])),
  );
  return rules.every((rule) => {
    const from = rule.from.slugs;
    const to = rule.to.slugs;
    return (
      rule.from.preset === undefined &&
      rule.to.preset === undefined &&
      from !== undefined &&
      to !== undefined &&
      from.length > 0 &&
      to.length > 0 &&
      from.every((source) => to.every((target) => pairs.has(`${source}:${target}`)))
    );
  });
};

const systemEnvironmentSlugs = new Set(["production", "preview", "development"]);
const includesEnvironmentSet = (
  actual: z.infer<typeof trustedEnvironmentSet>,
  expected: z.infer<typeof trustedEnvironmentSet>,
) => {
  const slugs = new Set(actual.slugs);
  return (
    (expected.preset === undefined || actual.preset === expected.preset) &&
    (expected.slugs ?? []).every(
      (slug) =>
        slugs.has(slug) || (actual.preset === "all-custom" && !systemEnvironmentSlugs.has(slug)),
    )
  );
};
const preservesTrustedSources = (
  actual: z.infer<typeof trustedSourcesSchema>,
  expected: z.infer<typeof trustedSourcesSchema>,
) => {
  const projectsPreserved = Object.entries(expected.projects ?? {}).every(([id, source]) => {
    const observed = actual.projects?.[id];
    if (observed === undefined) {
      return false;
    }
    if (source.customAllow === undefined) {
      return observed.customAllow === undefined;
    }
    return source.customAllow.every((rule) => {
      if (observed.customAllow === undefined) {
        return (
          rule.from.preset === undefined &&
          rule.to.preset === undefined &&
          (rule.from.slugs ?? []).every((from) => (rule.to.slugs ?? []).every((to) => from === to))
        );
      }
      return observed.customAllow.some(
        (candidate) =>
          includesEnvironmentSet(candidate.from, rule.from) &&
          includesEnvironmentSet(candidate.to, rule.to),
      );
    });
  });
  const externalPreserved = Object.entries(expected.oidcProviders ?? {}).every(
    ([issuer, sources]) =>
      sources.every(
        (source) =>
          actual.oidcProviders?.[issuer]?.some(
            (candidate) =>
              includesEnvironmentSet(candidate.to, source.to) &&
              Object.entries(candidate.claims).every(
                ([name, values]) =>
                  source.claims[name] !== undefined &&
                  source.claims[name].every((value) => values.includes(value)),
              ),
          ) === true,
      ),
  );
  return (
    projectsPreserved &&
    externalPreserved &&
    (actual.enableVercelCiSameRepository ?? true) ===
      (expected.enableVercelCiSameRepository ?? true)
  );
};
const providerValue = z.object({ value: z.string() });
const valueDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new HostedOperatorError("operator_unavailable");
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve only the closed reconciliation code; every other caught provider failure keeps its existing public mapping.
const rethrowBindingFailure = (error: unknown): never => {
  if (error instanceof HostedOperatorError && error.code === "reconciliation_required") {
    throw error;
  }
  throw unavailable();
};
const ignoreDiagnostic = () => {
  /* Unobserved read-only helpers keep their existing behavior. */
};
// Bound untrusted error-body buffering only; oversized or unreadable diagnostics stay unclassified.
export const readOperatorGatewayProviderFailure = async (
  response: Response,
  signal: AbortSignal,
) => {
  try {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return {};
    }
    const cancel = () => {
      const discard = async () => {
        try {
          await reader.cancel();
        } catch {
          /* Advisory cleanup cannot replace the original provider failure. */
        }
      };
      void discard();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        if (signal.aborted) {
          return {};
        }
        const next = await reader.read();
        if (next.done) {
          break;
        }
        size += next.value.byteLength;
        if (size > 8192) {
          return {};
        }
        chunks.push(next.value);
      }
      return projectOperatorGatewayProviderFailure(
        JSON.parse(Buffer.concat(chunks).toString("utf-8")),
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
  } catch {
    return {};
  }
};
const managedKeys = [
  "AUTH_DATABASE_RESOURCE",
  "PLATFORM_AUTH_DATABASE_URL",
  "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
  "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
  "PLATFORM_GATEWAY_PROJECT_BINDINGS",
] as const;
const managedKeySchema = z.enum(managedKeys);

/** Known owned values can converge without replacing their provider identities. */
const hasOwnedGatewayConfigChange = (
  input: GatewayManagedEnvironmentContext,
  observation: {
    expected: GatewayValues;
    known: ManagedOperatorEnvironmentRow[];
    rows: ProviderRow[];
    values: ReadonlyMap<string, string>;
  },
) => {
  const { expected, known, rows, values } = observation;
  if (rows.length !== managedKeys.length || known.length !== managedKeys.length) {
    return false;
  }
  const hasDesiredChange = rows.some(
    (row) => values.get(row.id) !== expected[managedKeySchema.parse(row.key)],
  );
  return (
    hasDesiredChange &&
    rows.every((row) => {
      const saved = known.find((item) => item.id === row.id && item.key === row.key);
      const value = values.get(row.id);
      if (
        saved === undefined ||
        value === undefined ||
        saved.pendingOperationRef !== undefined ||
        saved.pendingValueSha256 !== undefined ||
        saved.valueSha256 !== valueDigest(value)
      ) {
        return false;
      }
      const desired = expected[managedKeySchema.parse(row.key)];
      return (
        value === desired ||
        ["PLATFORM_GATEWAY_PROJECT_BINDINGS", "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS"].includes(
          row.key,
        ) ||
        (input.plan.authAdoption === undefined && row.key === "PLATFORM_REALM_OPERATOR_LINK_CONFIG")
      );
    })
  );
};
const requiredSecretKeys = [
  "PLATFORM_GATEWAY_IDENTITY_KEY_ID",
  "PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY",
] as const;

type GatewayValues = Record<(typeof managedKeys)[number], string>;
type CredentialReader = (
  authority: GatewayManagedEnvironmentContext["authority"],
  installationId: string,
) => ReturnType<typeof readActiveVercelInstallationToken>;

const authResource = (input: GatewayManagedEnvironmentContext) => {
  const { authDatabase, neon } = input.plan;
  return {
    database: authDatabase.database,
    environment: "preview" as const,
    hostname: neon.endpoint,
    migratorRole: authDatabase.migratorRole,
    neon: { branchId: neon.branchId, projectId: neon.projectId },
    port: 5432,
    runtimeRole: authDatabase.runtimeRole,
    schema: "public" as const,
    version: 1 as const,
  };
};

const projectionScope = {
  environment: z.literal("preview"),
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
};
const appBinding = z.strictObject({
  appId: z.string().min(1),
  approved: z.strictObject({
    ...projectionScope,
    deploymentId: z.string().min(1),
    deploymentUrl: z.url(),
    projectName: z.string().min(1),
    scopeSlug: z.string().min(1),
  }),
  observation: z.strictObject({
    ...projectionScope,
    deploymentId: z.string().min(1),
    deploymentUrl: z.url(),
    projectName: z.string().min(1),
    readyState: z.literal("READY"),
    scopeSlug: z.string().min(1),
  }),
});
const projectionSchema = z.strictObject({
  bindings: z.array(appBinding),
  provenance: z.literal("trusted-operator-published-provider-projection"),
  source: z.strictObject({
    ...projectionScope,
    audience: z.url(),
    issuer: z.url(),
    publicOrigin: z.url(),
    subject: z.string().min(1),
  }),
  version: z.literal(1),
});
const validGatewayInput = (input: GatewayManagedEnvironmentContext, readonlyCanonical = false) => {
  const { gateway, plan, target } = input;
  const {
    authBrowserOrigin,
    gatewayOrigin,
    publicOrigin,
    operatorOrigin,
    builderCallbackOrigin,
    catalogAppIds,
  } = gateway;
  const boundary = plan.deploymentBoundary;
  const config = plan.gatewayBindings;
  if (!boundary || !config) {
    return false;
  }
  return [
    plan.action === "prepare",
    ["gateway-bindings", "gateway-delivery"].includes(input.effect.kind) ||
      (readonlyCanonical &&
        input.effect.kind === "resources" &&
        input.effect.resourceId === plan.authDatabase.resourceId),
    target.environment === "preview",
    target.scopeType === "team",
    target.scopeId === boundary.teamId,
    target.projectId === plan.selection.projectId,
    target.projectId === boundary.app.projectId,
    target.projectId !== gateway.projectId,
    gateway.projectId === boundary.gateway.projectId,
    gateway.branch === boundary.gateway.branch,
    gateway.projectId === plan.publicGateway?.projectId,
    gateway.branch === plan.publicGateway?.branch,
    gatewayOrigin === boundary.verification.gatewayOrigin,
    publicOrigin === boundary.verification.publicOrigin,
    operatorOrigin === config.operatorOrigin,
    authBrowserOrigin === config.authBrowserOrigin,
    JSON.stringify(gateway.sourceWorkload) === JSON.stringify(config.sourceWorkload),
    gateway.sourceWorkload.projectId === gateway.projectId,
    gateway.sourceWorkload.ownerId === target.scopeId,
    builderCallbackOrigin === config.builderCallbackOrigin,
    JSON.stringify(catalogAppIds.toSorted()) === JSON.stringify(config.catalogAppIds.toSorted()),
    catalogAppIds.includes(plan.selection.appId),
    new Set(catalogAppIds).size === catalogAppIds.length,
    boundary.operator.environment === "preview",
    boundary.operator.projectId !== gateway.projectId,
    target.branch === plan.selection.branch,
  ].every(Boolean);
};

const assertRuntimeUrl = (value: string, input: GatewayManagedEnvironmentContext) => {
  const url = new URL(value);
  let database: string;
  let role: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    role = decodeURIComponent(url.username);
  } catch {
    throw unavailable();
  }
  const resource = input.plan.authDatabase;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname.toLowerCase().replace(/-pooler(?=\.)/u, "") !==
      input.plan.neon.endpoint.toLowerCase().replace(/-pooler(?=\.)/u, "") ||
    database !== resource.database ||
    role !== resource.runtimeRole ||
    url.password === "" ||
    !["", "5432"].includes(url.port) ||
    url.hash !== "" ||
    url.searchParams.getAll("sslmode").length !== 1 ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)) ||
    url.searchParams.getAll("channel_binding").length > 1 ||
    (url.searchParams.has("channel_binding") &&
      url.searchParams.get("channel_binding") !== "require")
  ) {
    throw unavailable();
  }
};

const referenceRow = (
  row: ProviderRow,
  input: GatewayManagedEnvironmentContext,
  knownById: ReadonlyMap<string, ManagedOperatorEnvironmentRow>,
  value: string,
) => {
  const prior = knownById.get(row.id);
  const reference: ManagedOperatorEnvironmentRow = {
    branch: input.gateway.branch,
    comment: z.string().min(1).parse(row.comment),
    id: row.id,
    key: row.key,
    operationRef: prior?.operationRef ?? input.operationRef,
    projectId: input.gateway.projectId,
    valueSha256: valueDigest(value),
  };
  if (prior?.gitBranch !== undefined) {
    reference.gitBranch = prior.gitBranch;
  } else if (prior === undefined && matchesPreviewEnvironmentGitBranch(row.gitBranch, null)) {
    reference.gitBranch = null;
  }
  return reference;
};

export const createHostedOperatorGatewayBindings = (deps: {
  assertAuthorized: ProtectedHostedOperatorDependencies["assertAuthorized"];
  assertCanonicalOwner?: ProtectedHostedOperatorDependencies["assertCanonicalOwner"];
  readCredential: CredentialReader;
  readAuthRuntimeUrl: (input: GatewayManagedEnvironmentContext) => Promise<string>;
  /** Reauthorize and reread the approved source journal; never infer ownership from provider comments. */
  readCanonicalGatewayRows?: (
    input: GatewayManagedEnvironmentContext,
  ) => Promise<{ active: boolean; rows: CanonicalGatewayEnvironmentRow[] }>;
  fetch?: typeof fetch;
  diagnosticSink?: HostedOperatorConsentDiagnosticSink;
}) => {
  const diagnostic = (
    input: GatewayManagedEnvironmentContext,
    mode: OperatorGatewayBindingsDiagnostic["mode"],
  ) => {
    let report: ReturnType<typeof createHostedOperatorConsentDiagnostic> | undefined;
    try {
      report = createHostedOperatorConsentDiagnostic(input.target.sessionId, deps.diagnosticSink);
    } catch {
      /* Diagnostics never change the existing binding or reconciliation outcome. */
    }
    let stage: OperatorGatewayBindingsDiagnostic["stage"] = "context";
    let method: OperatorGatewayBindingsDiagnostic["method"];
    let requestTarget: OperatorGatewayBindingsDiagnostic["requestTarget"];
    let protection:
      | Pick<
          OperatorGatewayBindingsDiagnostic,
          "trustedSourcesVisibility" | "missingApprovedPairCount"
        >
      | undefined;
    let statusCategory: OperatorGatewayBindingsDiagnostic["statusCategory"];
    let httpStatus: OperatorGatewayBindingsDiagnostic["httpStatus"];
    let providerFailure: ReturnType<typeof projectOperatorGatewayProviderFailure> | undefined;
    return {
      at(next: OperatorGatewayBindingsDiagnostic["stage"], preserveRequest = false) {
        stage = next;
        if (!preserveRequest) {
          method = undefined;
          requestTarget = undefined;
          statusCategory = undefined;
          httpStatus = undefined;
          providerFailure = undefined;
        }
      },
      get stage() {
        return stage;
      },
      request(
        next: NonNullable<OperatorGatewayBindingsDiagnostic["method"]>,
        target: NonNullable<OperatorGatewayBindingsDiagnostic["requestTarget"]>,
      ) {
        method = next;
        requestTarget = target;
      },
      protection(value?: typeof protection) {
        protection = value;
      },
      response(status: number) {
        if (!Number.isFinite(status)) {
          return;
        }
        if (Number.isInteger(status) && status >= 100 && status <= 599) {
          httpStatus = status;
        }
        if (status >= 200 && status < 300) {
          statusCategory = "success";
        } else if (status === 401 || status === 403) {
          statusCategory = "auth_denied";
        } else if (status === 429) {
          statusCategory = "rate_limited";
        } else if (status >= 400 && status < 500) {
          statusCategory = "client_error";
        } else if (status >= 500 && status < 600) {
          statusCategory = "server_error";
        } else if (status >= 300 && status < 400) {
          statusCategory = "redirect";
        } else {
          statusCategory = "other";
        }
      },
      noResponse() {
        statusCategory = "no_response";
      },
      providerFailure(
        failure: ReturnType<typeof projectOperatorGatewayProviderFailure> | undefined,
      ) {
        providerFailure = failure;
      },
      finish(result: OperatorGatewayBindingsDiagnostic["result"]) {
        report?.({
          boundary: "operator",
          phase: "inline",
          stage: "operator_request",
          outcome: result === "failed" || result === "unknown" ? "setup_unavailable" : "verified",
          gatewayBindings: {
            mode,
            stage,
            result,
            ...(method === undefined ? {} : { method }),
            ...((result === "failed" || result === "unknown") && requestTarget !== undefined
              ? { requestTarget }
              : {}),
            ...(result === "failed" || result === "unknown" ? protection : {}),
            ...(statusCategory === undefined ? {} : { statusCategory }),
            ...(httpStatus === undefined ? {} : { httpStatus }),
            ...providerFailure,
          },
        });
      },
    };
  };
  const silentObservation: ReturnType<typeof diagnostic> = {
    at: ignoreDiagnostic,
    stage: "context",
    request: ignoreDiagnostic,
    protection: ignoreDiagnostic,
    response: ignoreDiagnostic,
    noResponse: ignoreDiagnostic,
    providerFailure: ignoreDiagnostic,
    finish: ignoreDiagnostic,
  };
  const open = (
    liveInput: GatewayManagedEnvironmentContext,
    readonlyCanonical = false,
    observation = silentObservation,
  ) => {
    const input = {
      ...liveInput,
      authority: structuredClone(liveInput.authority),
      deliveryCandidates: structuredClone(liveInput.deliveryCandidates),
      effect: structuredClone(liveInput.effect),
      gateway: structuredClone(liveInput.gateway),
      gatewayEnvironmentRows: structuredClone(liveInput.gatewayEnvironmentRows),
      ownerContext: structuredClone(liveInput.ownerContext),
      plan: structuredClone(liveInput.plan),
      target: structuredClone(liveInput.target),
    };
    if (!validGatewayInput(input, readonlyCanonical)) {
      throw unavailable();
    }
    const { gateway, target } = input;
    const renewal = input.renewalBindingProvenance;
    if (
      renewal !== undefined &&
      !isRetentionRenewalBindingProvenance(
        renewal,
        input.plan,
        input.operationRef,
        input.effect.id,
        "gateway-bindings",
      )
    ) {
      throw unavailable();
    }
    const { branch, projectId } = gateway;
    const comment = `App Builder protected operator ${input.operationRef}`;
    const approvedCanonical = structuredClone(input.plan.authAdoption?.gatewayEnvironment);
    // Written values are accepted only for writes acknowledged by this invocation, until checkpointed.
    const acknowledgedValues = new Map<string, string>();
    const fullGuard = async () => {
      const priorStage = observation.stage;
      observation.at("authority", true);
      await input.assertCurrent();
      await deps.assertAuthorized(input);
      observation.at(priorStage, true);
    };
    const guard = async () => {
      if (input.assertCurrentObservation === undefined || deps.assertCanonicalOwner === undefined) {
        await fullGuard();
        return;
      }
      const priorStage = observation.stage;
      observation.at("authority", true);
      await input.assertCurrentObservation();
      await deps.assertCanonicalOwner(input);
      observation.at(priorStage, true);
    };
    const request = async (
      route: string,
      method: "GET" | "POST" | "PATCH" = "GET",
      body?:
        | { trustedSources: z.infer<typeof trustedSourcesSchema> }
        | {
            comment?: string;
            gitBranch?: string;
            key?: string;
            target?: string[];
            type: "encrypted";
            value: string;
          },
      requestTarget: NonNullable<
        OperatorGatewayBindingsDiagnostic["requestTarget"]
      > = "project_environment",
    ) => {
      const requestStage = observation.stage;
      const requestGuard = method === "GET" ? guard : fullGuard;
      await requestGuard();
      observation.at("credential");
      const credential = await deps.readCredential(input.authority, target.installationId);
      if (
        credential?.binding.active !== true ||
        credential.binding.installationId !== target.installationId ||
        credential.binding.scopeId !== target.scopeId ||
        credential.binding.scopeType !== target.scopeType
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      observation.at(requestStage);
      await requestGuard();
      const url = new URL(route, "https://api.vercel.com");
      url.searchParams.set("teamId", target.scopeId);
      const signal = AbortSignal.timeout(20_000);
      const options: RequestInit = {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.token}`,
          "Content-Type": "application/json",
        },
        method,
        redirect: "error",
        signal,
      };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      observation.request(method, requestTarget);
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(url, options);
      } catch (error) {
        observation.noResponse();
        throw error;
      }
      try {
        observation.response(response.status);
      } catch {
        /* Advisory status access must not skip the existing post-response guard. */
      }
      try {
        await requestGuard();
        if (!response.ok) {
          observation.providerFailure(await readOperatorGatewayProviderFailure(response, signal));
          throw unavailable();
        }
        if (response.status === 204) {
          return null;
        }
        const value: unknown = await response.json();
        await requestGuard();
        return value;
      } finally {
        if (!response.bodyUsed) {
          await response.body?.cancel();
        }
      }
    };
    const list = async () => {
      observation.at("environment_inventory");
      return z
        .object({ envs: z.array(providerRow) })
        .parse(await request(`/v10/projects/${encodeURIComponent(projectId)}/env`)).envs;
    };
    let previewGitBranch: Promise<string | null> | undefined;
    const newRowGitBranch = () => {
      previewGitBranch ??= (async () => {
        const raw = await request(
          `/v9/projects/${encodeURIComponent(projectId)}`,
          "GET",
          undefined,
          "project_settings",
        );
        const project = z.object({ id: z.string(), accountId: z.string() }).parse(raw);
        if (project.id !== projectId || project.accountId !== target.scopeId) {
          throw unavailable();
        }
        return resolveNativePreviewEnvironmentGitBranch(branch, raw);
      })();
      return previewGitBranch;
    };
    const approvedTrustedSources = input.plan.gatewayBindings?.trustedSources;
    const approvedTrustedSourceRules = Object.values(approvedTrustedSources ?? {}).filter(
      (rule): rule is TrustedSourceRule => rule !== undefined,
    );
    const observeTrustedSources = async () => {
      if (approvedTrustedSources === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Absent approved settings preserve the legacy path without a provider security observation.
        return undefined;
      }
      observation.protection();
      const project = trustedProjectSnapshot.parse(
        await request(
          `/v9/projects/${encodeURIComponent(projectId)}`,
          "GET",
          undefined,
          "project_settings",
        ),
      );
      if (project.id !== projectId || project.accountId !== target.scopeId) {
        throw unavailable();
      }
      const sources = project.trustedSources ?? {};
      const missing = approvedTrustedSourceRules.filter(
        (rule) => !coversTrustedSource(sources, rule),
      );
      let visibility: NonNullable<OperatorGatewayBindingsDiagnostic["trustedSourcesVisibility"]> =
        "present";
      if (project.trustedSources === undefined) {
        visibility = "absent";
      } else if (project.trustedSources === null) {
        visibility = "null";
      }
      observation.protection({
        trustedSourcesVisibility: visibility,
        missingApprovedPairCount: missing.length,
      });
      if (renewal !== undefined && project.trustedSources === undefined) {
        throw unavailable();
      }
      // A finite override cannot preserve the future same-environment semantics of an implicit foreign grant.
      const requiresReconciliation = missing.some(
        (rule) =>
          sources.projects?.[rule.projectId] !== undefined &&
          sources.projects[rule.projectId].customAllow === undefined,
      );
      return { sources, missing, requiresReconciliation };
    };
    const bindTrustedSources = async () => {
      const observed = await observeTrustedSources();
      if (observed === undefined || observed.missing.length === 0) {
        return;
      }
      if (observed.requiresReconciliation) {
        throw new HostedOperatorError("reconciliation_required");
      }
      // Exact pair scope is known for entries first created by this write, independently of unrelated concurrent additions.
      const createdProjectIds = [
        ...new Set(
          observed.missing
            .filter((rule) => observed.sources.projects?.[rule.projectId] === undefined)
            .map((rule) => rule.projectId),
        ),
      ];
      const sources = structuredClone(observed.sources);
      sources.projects ??= {};
      for (const rule of observed.missing) {
        const prior = sources.projects[rule.projectId];
        sources.projects[rule.projectId] = {
          ...prior,
          customAllow: [
            ...(prior?.customAllow ?? []),
            { from: { slugs: [rule.from] }, to: { slugs: [rule.to] } },
          ],
        };
      }
      observation.at("write");
      await request(
        `/v9/projects/${encodeURIComponent(projectId)}`,
        "PATCH",
        {
          trustedSources: sources,
        },
        "project_settings",
      );
      observation.at("write_readback");
      const actual = await observeTrustedSources();
      if (
        actual === undefined ||
        actual.missing.length !== 0 ||
        !preservesTrustedSources(actual.sources, sources) ||
        !createdProjectIds.every((id) =>
          hasOnlyApprovedSourcePairs(actual.sources, id, approvedTrustedSourceRules),
        )
      ) {
        throw unavailable();
      }
    };
    const isBranchPreview = (row: ProviderRow) =>
      row.target.includes("preview") &&
      (row.gitBranch === null || row.gitBranch === undefined || row.gitBranch === branch);
    const requiredEnvironment = async (rows: ProviderRow[]) => {
      observation.at("required_environment");
      const byKey = (key: string) =>
        rows.filter(
          (row) =>
            row.key === key &&
            row.target.length === 1 &&
            row.target[0] === "preview" &&
            (row.gitBranch === null || row.gitBranch === undefined || row.gitBranch === branch),
        );
      for (const key of requiredSecretKeys) {
        if (byKey(key).length !== 1) {
          throw unavailable();
        }
      }
      if (
        byKey("BETTER_AUTH_SECRET").length + byKey("BETTER_AUTH_SECRETS").length === 0 ||
        byKey("BETTER_AUTH_SECRET").length > 1 ||
        byKey("BETTER_AUTH_SECRETS").length > 1
      ) {
        throw unavailable();
      }
      observation.at("public_environment");
      for (const [key, expected] of [
        ["BETTER_AUTH_URL", gateway.publicOrigin],
        ["BETTER_AUTH_APP_NAME", "apps"],
        ["PLATFORM_PUBLIC_ORIGIN", gateway.publicOrigin],
      ] as const) {
        const matches = byKey(key);
        if (matches.length !== 1) {
          throw unavailable();
        }
        const match = matches.at(0);
        if (match === undefined) {
          throw unavailable();
        }
        const actual = providerValue.parse(
          await request(
            `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(match.id)}`,
          ),
        );
        if (actual.value !== expected) {
          throw unavailable();
        }
      }
      observation.at("trusted_origins");
      const trustedOriginRows = byKey("PLATFORM_AUTH_TRUSTED_ORIGINS");
      if (trustedOriginRows.length !== 1) {
        throw unavailable();
      }
      const trustedOriginRow = trustedOriginRows.at(0);
      if (trustedOriginRow === undefined) {
        throw unavailable();
      }
      const trustedOriginValues = new Set(
        providerValue
          .parse(
            await request(
              `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(trustedOriginRow.id)}`,
            ),
          )
          .value.split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      );
      // gatewayOrigin is the server-side transport/JWKS probe origin, not a browser origin.
      if (
        !trustedOriginValues.has(gateway.publicOrigin) ||
        !trustedOriginValues.has(gateway.authBrowserOrigin)
      ) {
        throw unavailable();
      }
    };
    const expectedRealmLinkValue = (
      rows: ProviderRow[],
      observedValues?: ReadonlyMap<string, string>,
    ): string => {
      const realmLinkConfig = createHostedOperatorRealmLinkConfig(input.plan);
      const fallback = JSON.stringify(realmLinkConfig);
      if (input.plan.authAdoption === undefined || input.plan.normalActorProgram !== undefined) {
        return fallback;
      }
      const row = rows.find((candidate) => candidate.key === "PLATFORM_REALM_OPERATOR_LINK_CONFIG");
      const observed = row === undefined ? undefined : observedValues?.get(row.id);
      const canonical = approvedCanonical?.find(
        (candidate) => candidate.id === row?.id && candidate.key === row?.key,
      );
      // Shared Auth keeps an already approved capture endpoint; this app gains no actor program.
      if (
        observed !== undefined &&
        canonical?.valueSha256 === valueDigest(observed) &&
        isDeepStrictEqual(
          JSON.parse(observed),
          // oxlint-disable-next-line unicorn/prefer-structured-clone, react-doctor/no-json-parse-stringify-clone -- Project the exact provider JSON wire representation, omitting absent optional fields.
          JSON.parse(
            JSON.stringify({
              ...realmLinkConfig,
              browserSessionCapture: {
                path: "/api/hosted-operator/realm-browser-session",
                sender: realmLinkConfig.identityHandoff.sender,
              },
            }),
          ),
        )
      ) {
        return observed;
      }
      return fallback;
    };
    const expectedValues = async (
      rows: ProviderRow[],
      observedValues?: ReadonlyMap<string, string>,
    ): Promise<GatewayValues> => {
      await guard();
      observation.at("runtime_binding");
      const runtimeUrl = await deps.readAuthRuntimeUrl(input);
      await guard();
      assertRuntimeUrl(runtimeUrl, input);
      const oldPolicy = rows.find((row) => row.key === "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS");
      let protectedApplicationIds = [...new Set(gateway.catalogAppIds)].toSorted((a, b) =>
        a.localeCompare(b),
      );
      if (oldPolicy) {
        observation.at("prior_policy");
        const oldValue = providerValue.parse(
          await request(
            `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(oldPolicy.id)}`,
          ),
        ).value;
        const parsed: unknown = JSON.parse(oldValue);
        const oldIds = z.array(z.string().min(1)).safeParse(parsed);
        if (!oldIds.success || new Set(oldIds.data).size !== oldIds.data.length) {
          throw unavailable();
        }
        const existingIds = oldIds.data;
        // Keep sibling apps already trusted by this managed Gateway policy.
        protectedApplicationIds = [
          ...new Set([...existingIds, ...protectedApplicationIds]),
        ].toSorted((a, b) => a.localeCompare(b));
      }
      const oldProjection = rows.find((row) => row.key === "PLATFORM_GATEWAY_PROJECT_BINDINGS");
      let priorBindings: z.infer<typeof appBinding>[] = [];
      if (oldProjection !== undefined) {
        observation.at("prior_projection");
        const stored = providerValue.parse(
          await request(
            `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(oldProjection.id)}`,
          ),
        );
        const prior = projectionSchema.parse(JSON.parse(stored.value));
        const expectedSource = { ...gateway.sourceWorkload, publicOrigin: gateway.publicOrigin };
        if (
          JSON.stringify(prior.source) !==
          JSON.stringify(projectionSchema.shape.source.parse(expectedSource))
        ) {
          throw unavailable();
        }
        priorBindings = prior.bindings;
      }
      observation.at("app_candidate");
      const selectedId =
        input.plan.stage === "auth-bootstrap"
          ? undefined
          : input.deliveryCandidates?.find(
              (candidate) =>
                candidate.readyState === "READY" && candidate.operationRef === input.operationRef,
            )?.deploymentId;
      const selected = input.deliveryCandidates?.find(
        (candidate) => candidate.deploymentId === selectedId,
      );
      if (input.plan.stage !== "auth-bootstrap" && selected === undefined) {
        throw unavailable();
      }
      if (selected !== undefined) {
        if (
          selected.projectName === undefined ||
          selected.scopeSlug === undefined ||
          selected.projectId !== input.target.projectId ||
          selected.branch !== plannedAppBranch(input.plan)
        ) {
          throw unavailable();
        }
        const targetScope = {
          deploymentId: selected.deploymentId,
          deploymentUrl: selected.origin,
          environment: "preview" as const,
          ownerId: input.target.scopeId,
          projectId: selected.projectId,
          projectName: selected.projectName,
          scopeSlug: selected.scopeSlug,
        };
        const bound = appBinding.parse({
          appId: input.target.appId,
          approved: targetScope,
          observation: { ...targetScope, readyState: "READY" },
        });
        priorBindings = [
          ...priorBindings.filter((binding) => binding.appId !== input.target.appId),
          bound,
        ];
      }
      observation.at("desired_values");
      const projection = projectionSchema.parse({
        bindings: priorBindings,
        provenance: "trusted-operator-published-provider-projection",
        source: { ...gateway.sourceWorkload, publicOrigin: gateway.publicOrigin },
        version: 1,
      });
      return {
        AUTH_DATABASE_RESOURCE: JSON.stringify(authResource(input)),
        PLATFORM_AUTH_DATABASE_URL: runtimeUrl,
        PLATFORM_GATEWAY_PROJECT_BINDINGS: JSON.stringify(projection),
        PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: JSON.stringify(protectedApplicationIds),
        PLATFORM_REALM_OPERATOR_LINK_CONFIG: expectedRealmLinkValue(rows, observedValues),
      };
    };
    let activeSharedAuth = false;
    const knownRows = async () => {
      observation.at("known_rows");
      let canonical: CanonicalGatewayEnvironmentRow[] = [];
      if (input.plan.authAdoption !== undefined) {
        if (approvedCanonical === undefined || deps.readCanonicalGatewayRows === undefined) {
          throw unavailable();
        }
        await guard();
        const ownership = await deps.readCanonicalGatewayRows(input);
        canonical = canonicalGatewayEnvironmentRowsSchema.parse(ownership.rows);
        activeSharedAuth = ownership.active;
        await guard();
        if (
          canonical.length !== managedKeys.length ||
          new Set(canonical.map((row) => row.id)).size !== canonical.length ||
          new Set(canonical.map((row) => row.key)).size !== canonical.length ||
          !isDeepStrictEqual(canonical, approvedCanonical)
        ) {
          throw unavailable();
        }
      }
      const local = structuredClone(input.gatewayEnvironmentRows ?? []);
      const canonicalById = new Map(canonical.map((row) => [row.id, row]));
      if (
        local.some((row) => {
          const prior = canonicalById.get(row.id);
          return (
            prior !== undefined &&
            (row.key !== prior.key ||
              savedPreviewEnvironmentGitBranch(row) !== savedPreviewEnvironmentGitBranch(prior) ||
              row.operationRef !== prior.operationRef ||
              row.comment !== prior.comment ||
              row.valueSha256 === undefined)
          );
        })
      ) {
        throw unavailable();
      }
      const known: ManagedOperatorEnvironmentRow[] = [
        ...canonical.filter((row) => !local.some((saved) => saved.id === row.id)),
        ...local,
      ];
      if (
        new Set(known.map((row) => row.id)).size !== known.length ||
        new Set(known.map((row) => row.key)).size !== known.length ||
        known.some(
          (row) =>
            row.projectId !== projectId ||
            row.branch !== branch ||
            !managedKeySchema.safeParse(row.key).success ||
            row.comment !== `App Builder protected operator ${row.operationRef}` ||
            (row.pendingOperationRef !== undefined &&
              row.pendingOperationRef !== input.operationRef),
        )
      ) {
        throw unavailable();
      }
      return known;
    };
    const owned = (
      row: ProviderRow,
      known: ManagedOperatorEnvironmentRow[],
      newScope: string | null,
    ) => {
      const saved = known.find((item) => item.id === row.id);
      // Earlier writers could complete a branch-specific POST before checkpointing it.
      // Its current-operation tag and exact desired value still have to prove recovery below.
      const matchesScope =
        saved === undefined
          ? matchesPreviewEnvironmentGitBranch(row.gitBranch, newScope) ||
            matchesPreviewEnvironmentGitBranch(row.gitBranch, branch)
          : matchesPreviewEnvironmentGitBranch(
              row.gitBranch,
              savedPreviewEnvironmentGitBranch(saved),
            );
      return (
        row.target.length === 1 &&
        row.target[0] === "preview" &&
        matchesScope &&
        (row.configurationId === null ||
          row.configurationId === undefined ||
          row.configurationId === "" ||
          row.configurationId === input.target.installationId) &&
        row.type === "encrypted" &&
        (known.some(
          (item) => item.id === row.id && item.key === row.key && item.comment === row.comment,
        ) ||
          (row.comment === comment &&
            !known.some((item) => item.id === row.id || item.key === row.key)))
      );
    };
    const referenceRows = (
      rows: ProviderRow[],
      known: ManagedOperatorEnvironmentRow[],
      values: ReadonlyMap<string, string>,
    ) => {
      const knownById = new Map(known.map((row) => [row.id, row]));
      return rows.map((row) =>
        referenceRow(row, input, knownById, z.string().parse(values.get(row.id))),
      );
    };
    const checkpoint = async (
      rows: ProviderRow[],
      known: ManagedOperatorEnvironmentRow[],
      values: ReadonlyMap<string, string>,
      expected: GatewayValues,
      pending?: { id: string; valueSha256: string },
    ) => {
      await guard();
      const knownById = new Map(known.map((row) => [row.id, row]));
      const saved = rows.map((row) => {
        const value = z.string().parse(values.get(row.id));
        const reference: ManagedOperatorEnvironmentRow = referenceRow(row, input, knownById, value);
        const key = managedKeySchema.parse(row.key);
        // Before ordinary repair, a mismatched fixed value is a row reference, not an approved value snapshot.
        if (
          value !== expected[key] &&
          ![
            "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
            "PLATFORM_GATEWAY_PROJECT_BINDINGS",
          ].includes(key)
        ) {
          delete reference.valueSha256;
        }
        const prior = knownById.get(row.id);
        if (
          prior?.pendingOperationRef === input.operationRef &&
          prior.pendingValueSha256 !== reference.valueSha256
        ) {
          reference.pendingOperationRef = prior.pendingOperationRef;
          reference.pendingValueSha256 = prior.pendingValueSha256;
        }
        if (pending?.id === row.id) {
          reference.pendingOperationRef = input.operationRef;
          reference.pendingValueSha256 = pending.valueSha256;
        }
        return reference;
      });
      observation.at("checkpoint");
      await input.checkpointGatewayEnvironment(saved);
      input.gatewayEnvironmentRows = saved;
      await guard();
    };
    const assertKnownValue = (
      row: ProviderRow,
      value: string,
      known: ManagedOperatorEnvironmentRow[],
      canonicalOnly: boolean,
    ) => {
      const reference: ManagedOperatorEnvironmentRow | undefined = canonicalOnly
        ? approvedCanonical?.find((saved) => saved.id === row.id && saved.key === row.key)
        : known.find((saved) => saved.id === row.id && saved.key === row.key);
      const expectedDigest = canonicalOnly
        ? reference?.valueSha256
        : (acknowledgedValues.get(row.id) ?? reference?.valueSha256);
      if (canonicalOnly && reference === undefined) {
        throw unavailable();
      }
      if (
        input.plan.authAdoption !== undefined &&
        !(
          activeSharedAuth &&
          !canonicalOnly &&
          ["PLATFORM_GATEWAY_PROTECTED_APPLICATIONS", "PLATFORM_GATEWAY_PROJECT_BINDINGS"].includes(
            row.key,
          )
        ) &&
        expectedDigest !== undefined &&
        valueDigest(value) !== expectedDigest &&
        !(
          reference?.pendingOperationRef === input.operationRef &&
          reference.pendingValueSha256 === valueDigest(value) &&
          !canonicalOnly
        )
      ) {
        throw unavailable();
      }
      return reference;
    };
    const inspectOwnership = async (canonicalOnly = false, selectedKey?: keyof GatewayValues) => {
      // oxlint-disable-next-line react-doctor/async-parallel -- Establish source ownership before guarded provider metadata; reuse one resolved physical selector afterward.
      const known = await knownRows();
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Source ownership must be established before provider readback.
      const listed = await list();
      const newScope = await newRowGitBranch();
      observation.at("ownership_readback");
      const rows = listed.filter(
        (row) => managedKeySchema.safeParse(row.key).success && isBranchPreview(row),
      );
      if (
        rows.some((row) => !owned(row, known, newScope)) ||
        new Set(rows.map((row) => row.key)).size !== rows.length ||
        known.some((row) => rows.some((actual) => actual.key === row.key && actual.id !== row.id))
      ) {
        throw unavailable();
      }
      observation.at("managed_values");
      const values = new Map<string, string>();
      for (const row of rows.filter(
        (candidate) => selectedKey === undefined || candidate.key === selectedKey,
      )) {
        const { value } = providerValue.parse(
          await request(
            `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(row.id)}`,
          ),
        );
        const reference = assertKnownValue(row, value, known, canonicalOnly);
        // Unknown POST outcomes can recover only exact current-operation values, never a sibling merge.
        if (reference === undefined) {
          const pristine = await expectedValues([]);
          if (value !== pristine[managedKeySchema.parse(row.key)]) {
            throw unavailable();
          }
        }
        values.set(row.id, value);
      }
      if (
        known.some((saved) => !rows.some((row) => row.id === saved.id && row.key === saved.key))
      ) {
        throw unavailable();
      }
      // Re-read source authorization after provider awaits; a moved checkpoint never grants ownership.
      if (input.plan.authAdoption !== undefined) {
        await knownRows();
      }
      return { known, listed, rows, values };
    };
    const inspect = async (verifyValues: boolean) => {
      const { known, listed, rows, values } = await inspectOwnership();
      await requiredEnvironment(listed);
      const expected = await expectedValues(rows, values);
      if (
        renewal !== undefined &&
        (rows.length !== Object.keys(expected).length ||
          renewal.rows.some(
            (saved) =>
              !rows.some(
                (row) =>
                  row.id === saved.id &&
                  row.key === saved.key &&
                  row.comment === saved.comment &&
                  matchesPreviewEnvironmentGitBranch(
                    row.gitBranch,
                    savedPreviewEnvironmentGitBranch(saved),
                  ),
              ),
          ))
      ) {
        throw unavailable();
      }
      if (
        input.plan.authAdoption !== undefined &&
        rows.some(
          (row) =>
            ![
              "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
              "PLATFORM_GATEWAY_PROJECT_BINDINGS",
            ].includes(row.key) && values.get(row.id) !== expected[managedKeySchema.parse(row.key)],
        )
      ) {
        throw unavailable();
      }
      if (verifyValues) {
        observation.at("final_readback");
        for (const row of rows) {
          const actual = providerValue.parse(
            await request(
              `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(row.id)}`,
            ),
          );
          const key = managedKeySchema.parse(row.key);
          if (actual.value !== expected[key] || actual.value !== values.get(row.id)) {
            throw unavailable();
          }
        }
      }
      return { expected, known, rows, values };
    };
    const inspectIteration = async (
      key: keyof GatewayValues,
      prior: Awaited<ReturnType<typeof inspect>>,
      creatingRows: boolean,
    ) => {
      if (!creatingRows) {
        return await inspect(false);
      }
      // Metadata and the selected row remain fresh around each new-row write.
      // The final full observation checks every value again before completion.
      const selected = await inspectOwnership(false, key);
      const values = new Map(prior.values);
      for (const [id, value] of selected.values) {
        values.set(id, value);
      }
      return { expected: prior.expected, known: selected.known, rows: selected.rows, values };
    };
    const readSelectedValue = async (
      row: ProviderRow,
      values: ReadonlyMap<string, string>,
      creatingRows: boolean,
    ) => {
      if (creatingRows) {
        return values.get(row.id);
      }
      return providerValue.parse(
        await request(
          `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(row.id)}`,
        ),
      ).value;
    };
    const writeRow = async (key: keyof GatewayValues, value: string, existing?: ProviderRow) => {
      if (renewal !== undefined && existing === undefined) {
        throw unavailable();
      }
      const gitBranch = existing === undefined ? await newRowGitBranch() : undefined;
      return await (existing
        ? request(
            `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(existing.id)}`,
            "PATCH",
            { type: "encrypted", value },
          )
        : request(`/v10/projects/${encodeURIComponent(projectId)}/env`, "POST", {
            comment,
            ...(gitBranch === null ? {} : { gitBranch }),
            key,
            target: ["preview"],
            type: "encrypted",
            value,
          }));
    };
    const prepareWrite = async (
      existing: ProviderRow | undefined,
      rows: ProviderRow[],
      known: ManagedOperatorEnvironmentRow[],
      values: ReadonlyMap<string, string>,
      expected: GatewayValues,
      value: string,
      selectedKey?: keyof GatewayValues,
    ) => {
      const fresh = await inspectOwnership(false, selectedKey);
      observation.at("prewrite");
      const selectedValues =
        selectedKey === undefined
          ? values
          : new Map(
              [...values].filter(([id]) =>
                rows.some((row) => row.id === id && row.key === selectedKey),
              ),
            );
      if (
        !isDeepStrictEqual(fresh.rows, rows) ||
        !isDeepStrictEqual(fresh.values, selectedValues)
      ) {
        throw unavailable();
      }
      if (existing !== undefined && input.plan.authAdoption !== undefined) {
        await checkpoint(rows, known, values, expected, {
          id: existing.id,
          valueSha256: valueDigest(value),
        });
        const acknowledged = await inspectOwnership(false, selectedKey);
        if (
          !isDeepStrictEqual(acknowledged.rows, rows) ||
          !isDeepStrictEqual(acknowledged.values, selectedValues)
        ) {
          throw unavailable();
        }
      }
    };
    return {
      acknowledgedValues,
      approvedCanonical,
      branch,
      checkpoint,
      comment,
      fullGuard,
      guard,
      inspect,
      inspectIteration,
      inspectOwnership,
      observeTrustedSources,
      bindTrustedSources,
      prepareWrite,
      projectId,
      readSelectedValue,
      referenceRows,
      request,
      writeRow,
    };
  };

  return {
    async bind(input: GatewayManagedEnvironmentContext) {
      const observation = diagnostic(input, "bind");
      try {
        if (input.effect.kind !== "gateway-bindings") {
          throw unavailable();
        }
        const io = open(input, false, observation);
        observation.at("authority");
        await io.fullGuard();
        let { expected, known, rows, values } = await io.inspect(false);
        if (input.renewalBindingProvenance !== undefined) {
          await io.observeTrustedSources();
        }
        const creatingRows = rows.length === 0;
        await io.checkpoint(rows, known, values, expected);
        // Select work from the fresh initial observation. Each changed key keeps
        // its full prewrite checks, and final readback still verifies every row.
        const changedKeys = Object.entries(expected).flatMap(([key, value]) =>
          rows.some((row) => row.key === key && values.get(row.id) === value) ? [] : [key],
        );
        for (const keyText of changedKeys) {
          const key = managedKeySchema.parse(keyText);
          ({ expected, known, rows, values } = await io.inspectIteration(
            key,
            { expected, known, rows, values },
            creatingRows,
          ));
          const value = expected[key];
          const rowsByKey = new Map(rows.map((row) => [row.key, row]));
          const existing = rowsByKey.get(key);
          const current = existing
            ? await io.readSelectedValue(existing, values, creatingRows)
            : undefined;
          if (existing !== undefined && current !== values.get(existing.id)) {
            throw unavailable();
          }
          if (current === value) {
            continue;
          }
          await io.prepareWrite(
            existing,
            rows,
            known,
            values,
            expected,
            value,
            creatingRows ? key : undefined,
          );
          observation.at("write");
          await io.writeRow(key, value, existing);
          if (existing !== undefined) {
            io.acknowledgedValues.set(existing.id, valueDigest(value));
          }
          ({ expected, known, rows, values } = await io.inspectIteration(
            key,
            { expected, known, rows, values },
            creatingRows,
          ));
          const observed = new Map(rows.map((row) => [row.key, row])).get(key);
          if (!observed) {
            throw unavailable();
          }
          observation.at("write_readback");
          const actual = await io.readSelectedValue(observed, values, creatingRows);
          if (actual !== expected[key]) {
            throw unavailable();
          }
          await io.checkpoint(rows, known, values, expected);
        }
        ({ known, rows, values } = await io.inspect(true));
        await io.bindTrustedSources();
        await io.fullGuard();
        const result = { rows: io.referenceRows(rows, known, values) };
        observation.finish("bound");
        return result;
      } catch (error) {
        observation.finish("failed");
        return rethrowBindingFailure(error);
      }
    },
    async reconcile(
      input: GatewayManagedEnvironmentContext,
    ): Promise<
      | { status: "absent" | "unknown" }
      | { status: "retryable"; resourceVersion: string }
      | { status: "applied"; rows: ManagedOperatorEnvironmentRow[] }
    > {
      const observation = diagnostic(input, "reconcile");
      try {
        const io = open(input, false, observation);
        observation.at("authority");
        await io.fullGuard();
        const observed = await io.inspect(false);
        await io.fullGuard();
        if (hasOwnedGatewayConfigChange(input, observed)) {
          // The diagnostic vocabulary reports unapplied setup as unknown.
          observation.finish("unknown");
          return {
            status: "retryable",
            resourceVersion: valueDigest(
              JSON.stringify(io.referenceRows(observed.rows, observed.known, observed.values)),
            ),
          };
        }
        const { expected, known, rows, values } = await io.inspect(true);
        const protection = await io.observeTrustedSources();
        await io.fullGuard();
        if (protection?.requiresReconciliation === true) {
          observation.finish("unknown");
          return { status: "unknown" };
        }
        if (rows.length === 0) {
          observation.finish("absent");
          return { status: "absent" };
        }
        await io.checkpoint(rows, known, values, expected);
        if (rows.length === Object.keys(expected).length) {
          if (protection !== undefined && protection.missing.length !== 0) {
            observation.finish("unknown");
            return {
              status: "retryable",
              resourceVersion: valueDigest(JSON.stringify(protection.sources)),
            };
          }
          const result = {
            rows: io.referenceRows(rows, known, values),
            status: "applied" as const,
          };
          observation.finish("applied");
          return result;
        }
        observation.finish("unknown");
        return { status: "unknown" };
      } catch {
        observation.finish("unknown");
        return { status: "unknown" };
      }
    },
    /** GET-only proof for the pending credential continuation; no runtime URL or app delivery is needed. */
    async verifyCanonicalOwnership(input: GatewayManagedEnvironmentContext) {
      try {
        const io = open(input, true);
        await io.fullGuard();
        if (io.approvedCanonical === undefined) {
          throw unavailable();
        }
        const { rows } = await io.inspectOwnership(true);
        if (rows.length !== managedKeys.length) {
          throw unavailable();
        }
        await io.fullGuard();
        return { rows: structuredClone(io.approvedCanonical) };
      } catch {
        throw unavailable();
      }
    },
    async verifyForDelivery(input: GatewayManagedEnvironmentContext) {
      const observation = diagnostic(input, "verify");
      try {
        if (input.effect.kind !== "gateway-delivery") {
          throw unavailable();
        }
        const io = open(input, false, observation);
        await io.fullGuard();
        const { rows, known, expected, values } = await io.inspect(true);
        if (rows.length !== Object.keys(expected).length) {
          throw unavailable();
        }
        const protection = await io.observeTrustedSources();
        if (protection !== undefined && protection.missing.length !== 0) {
          throw unavailable();
        }
        await io.fullGuard();
        const result = {
          rows: io.referenceRows(rows, known, values),
        };
        observation.finish("applied");
        return result;
      } catch (error) {
        observation.finish("unknown");
        throw error;
      }
    },
  };
};
