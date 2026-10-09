/* oxlint-disable eslint/no-await-in-loop, sonarjs/expression-complexity, sonarjs/no-nested-functions, react-doctor/async-await-in-loop -- Provider writes and their durable readbacks are deliberately sequential. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import {
  canonicalGatewayEnvironmentRowsSchema,
  HostedOperatorError,
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
const providerValue = z.object({ value: z.string() });
const valueDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new HostedOperatorError("operator_unavailable");
const managedKeys = [
  "AUTH_DATABASE_RESOURCE",
  "PLATFORM_AUTH_DATABASE_URL",
  "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
  "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
  "PLATFORM_GATEWAY_PROJECT_BINDINGS",
] as const;
const managedKeySchema = z.enum(managedKeys);
const requiredSecretKeys = [
  "PLATFORM_GATEWAY_IDENTITY_KEY_ID",
  "PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY",
] as const;

type GatewayValues = Record<(typeof managedKeys)[number], string>;
type CredentialReader = (
  authority: GatewayManagedEnvironmentContext["authority"],
  installationId: string,
) => ReturnType<typeof readActiveVercelInstallationToken>;

const exactHttpsOrigin = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw unavailable();
  }
  return value;
};

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
) => ({
  branch: input.gateway.branch,
  comment: z.string().min(1).parse(row.comment),
  id: row.id,
  key: row.key,
  operationRef: knownById.get(row.id)?.operationRef ?? input.operationRef,
  projectId: input.gateway.projectId,
  valueSha256: valueDigest(value),
});

export const createHostedOperatorGatewayBindings = (deps: {
  assertAuthorized: ProtectedHostedOperatorDependencies["assertAuthorized"];
  readCredential: CredentialReader;
  readAuthRuntimeUrl: (input: GatewayManagedEnvironmentContext) => Promise<string>;
  /** Reauthorize and reread the approved source journal; never infer ownership from provider comments. */
  readCanonicalGatewayRows?: (
    input: GatewayManagedEnvironmentContext,
  ) => Promise<CanonicalGatewayEnvironmentRow[]>;
  fetch?: typeof fetch;
}) => {
  const open = (liveInput: GatewayManagedEnvironmentContext, readonlyCanonical = false) => {
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
    const { branch, projectId } = gateway;
    const comment = `App Builder protected operator ${input.operationRef}`;
    const approvedCanonical = structuredClone(input.plan.authAdoption?.gatewayEnvironment);
    // Written values are accepted only for writes acknowledged by this invocation, until checkpointed.
    const acknowledgedValues = new Map<string, string>();
    const guard = async () => {
      await input.assertCurrent();
      await deps.assertAuthorized(input);
    };
    const request = async (
      route: string,
      method = "GET",
      body?: {
        comment?: string;
        gitBranch?: string;
        key?: string;
        target?: string[];
        type: "encrypted";
        value: string;
      },
    ) => {
      await guard();
      const credential = await deps.readCredential(input.authority, target.installationId);
      if (
        credential?.binding.active !== true ||
        credential.binding.installationId !== target.installationId ||
        credential.binding.scopeId !== target.scopeId ||
        credential.binding.scopeType !== target.scopeType
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      await guard();
      const url = new URL(route, "https://api.vercel.com");
      url.searchParams.set("teamId", target.scopeId);
      const options: RequestInit = {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.token}`,
          "Content-Type": "application/json",
        },
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      const response = await (deps.fetch ?? fetch)(url, options);
      try {
        await guard();
        if (!response.ok) {
          throw unavailable();
        }
        if (response.status === 204) {
          return null;
        }
        const value: unknown = await response.json();
        await guard();
        return value;
      } finally {
        if (!response.bodyUsed) {
          await response.body?.cancel();
        }
      }
    };
    const list = async () =>
      z
        .object({ envs: z.array(providerRow) })
        .parse(await request(`/v10/projects/${encodeURIComponent(projectId)}/env`)).envs;
    const isBranchPreview = (row: ProviderRow) =>
      row.target.includes("preview") &&
      (row.gitBranch === null || row.gitBranch === undefined || row.gitBranch === branch);
    const requiredEnvironment = async (rows: ProviderRow[]) => {
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
      for (const [key, expected] of [
        ["BETTER_AUTH_URL", `${gateway.publicOrigin}/api/auth`],
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
      if (
        !trustedOriginValues.has(gateway.gatewayOrigin) ||
        !trustedOriginValues.has(gateway.publicOrigin) ||
        !trustedOriginValues.has(gateway.authBrowserOrigin)
      ) {
        throw unavailable();
      }
    };
    const expectedValues = async (rows: ProviderRow[]): Promise<GatewayValues> => {
      await guard();
      const runtimeUrl = await deps.readAuthRuntimeUrl(input);
      await guard();
      assertRuntimeUrl(runtimeUrl, input);
      const oldPolicy = rows.find((row) => row.key === "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS");
      let protectedApplicationIds = [...new Set(gateway.catalogAppIds)].toSorted((a, b) =>
        a.localeCompare(b),
      );
      if (oldPolicy) {
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
          selected.branch !== input.target.branch
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
        PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify({
          browserOrigin: exactHttpsOrigin(gateway.authBrowserOrigin),
          builderCallbackOrigin: exactHttpsOrigin(gateway.builderCallbackOrigin),
          builderCallbackPath: "/api/hosted-operator/realm-identity",
          operatorOrigin: exactHttpsOrigin(gateway.operatorOrigin),
          readonlyAttesters: input.plan.gatewayBindings?.readonlyAttesters,
        }),
      };
    };
    const knownRows = async () => {
      let canonical: CanonicalGatewayEnvironmentRow[] = [];
      if (input.plan.authAdoption !== undefined) {
        if (approvedCanonical === undefined || deps.readCanonicalGatewayRows === undefined) {
          throw unavailable();
        }
        await guard();
        canonical = canonicalGatewayEnvironmentRowsSchema.parse(
          await deps.readCanonicalGatewayRows(input),
        );
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
    const owned = (row: ProviderRow, known: ManagedOperatorEnvironmentRow[]) =>
      row.target.length === 1 &&
      row.target[0] === "preview" &&
      row.gitBranch === branch &&
      (row.configurationId === null ||
        row.configurationId === undefined ||
        row.configurationId === "") &&
      row.type === "encrypted" &&
      (known.some(
        (item) => item.id === row.id && item.key === row.key && item.comment === row.comment,
      ) ||
        (row.comment === comment &&
          !known.some((item) => item.id === row.id || item.key === row.key)));
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
    const inspectOwnership = async (canonicalOnly = false) => {
      const known = await knownRows();
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Source ownership must be established before provider readback.
      const listed = await list();
      const rows = listed.filter(
        (row) => managedKeySchema.safeParse(row.key).success && isBranchPreview(row),
      );
      if (
        rows.some((row) => !owned(row, known)) ||
        new Set(rows.map((row) => row.key)).size !== rows.length ||
        known.some((row) => rows.some((actual) => actual.key === row.key && actual.id !== row.id))
      ) {
        throw unavailable();
      }
      const values = new Map<string, string>();
      for (const row of rows) {
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
      const expected = await expectedValues(rows);
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
    const prepareWrite = async (
      existing: ProviderRow | undefined,
      rows: ProviderRow[],
      known: ManagedOperatorEnvironmentRow[],
      values: ReadonlyMap<string, string>,
      expected: GatewayValues,
      value: string,
    ) => {
      const fresh = await inspectOwnership();
      if (!isDeepStrictEqual(fresh.rows, rows) || !isDeepStrictEqual(fresh.values, values)) {
        throw unavailable();
      }
      if (existing !== undefined && input.plan.authAdoption !== undefined) {
        await checkpoint(rows, known, values, expected, {
          id: existing.id,
          valueSha256: valueDigest(value),
        });
        const acknowledged = await inspectOwnership();
        if (
          !isDeepStrictEqual(acknowledged.rows, rows) ||
          !isDeepStrictEqual(acknowledged.values, values)
        ) {
          throw unavailable();
        }
      }
    };
    return {
      acknowledgedValues,
      approvedCanonical,
      checkpoint,
      comment,
      guard,
      inspect,
      inspectOwnership,
      prepareWrite,
      projectId,
      request,
    };
  };

  return {
    async bind(input: GatewayManagedEnvironmentContext) {
      try {
        if (input.effect.kind !== "gateway-bindings") {
          throw unavailable();
        }
        const io = open(input);
        let { expected, known, rows, values } = await io.inspect(false);
        await io.checkpoint(rows, known, values, expected);
        for (const keyText of Object.keys(expected)) {
          ({ expected, known, rows, values } = await io.inspect(false));
          const key = managedKeySchema.parse(keyText);
          const value = expected[key];
          const rowsByKey = new Map(rows.map((row) => [row.key, row]));
          const existing = rowsByKey.get(key);
          const current = existing
            ? providerValue.parse(
                await io.request(
                  `/v1/projects/${encodeURIComponent(io.projectId)}/env/${encodeURIComponent(existing.id)}`,
                ),
              ).value
            : undefined;
          if (existing !== undefined && current !== values.get(existing.id)) {
            throw unavailable();
          }
          if (current === value) {
            continue;
          }
          await io.prepareWrite(existing, rows, known, values, expected, value);
          const effect = existing
            ? io.request(
                `/v9/projects/${encodeURIComponent(io.projectId)}/env/${encodeURIComponent(existing.id)}`,
                "PATCH",
                { type: "encrypted", value },
              )
            : io.request(`/v10/projects/${encodeURIComponent(io.projectId)}/env`, "POST", {
                comment: io.comment,
                gitBranch: input.gateway.branch,
                key,
                target: ["preview"],
                type: "encrypted",
                value,
              });
          await effect;
          if (existing !== undefined) {
            io.acknowledgedValues.set(existing.id, valueDigest(value));
          }
          ({ expected, known, rows, values } = await io.inspect(false));
          const observed = new Map(rows.map((row) => [row.key, row])).get(key);
          if (!observed) {
            throw unavailable();
          }
          const actual = providerValue.parse(
            await io.request(
              `/v1/projects/${encodeURIComponent(io.projectId)}/env/${encodeURIComponent(observed.id)}`,
            ),
          );
          if (actual.value !== expected[key]) {
            throw unavailable();
          }
          await io.checkpoint(rows, known, values, expected);
        }
        ({ known, rows, values } = await io.inspect(true));
        const knownById = new Map(known.map((row) => [row.id, row]));
        return {
          rows: rows.map((row) =>
            referenceRow(row, input, knownById, z.string().parse(values.get(row.id))),
          ),
        };
      } catch {
        throw unavailable();
      }
    },
    async reconcile(
      input: GatewayManagedEnvironmentContext,
    ): Promise<
      | { status: "absent" | "unknown" }
      | { status: "applied"; rows: ManagedOperatorEnvironmentRow[] }
    > {
      try {
        const io = open(input);
        const { expected, known, rows, values } = await io.inspect(true);
        if (rows.length === 0) {
          return { status: "absent" };
        }
        await io.checkpoint(rows, known, values, expected);
        const knownById = new Map(known.map((row) => [row.id, row]));
        return rows.length === Object.keys(expected).length
          ? {
              rows: rows.map((row) =>
                referenceRow(row, input, knownById, z.string().parse(values.get(row.id))),
              ),
              status: "applied",
            }
          : { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
    },
    /** GET-only proof for the pending credential continuation; no runtime URL or app delivery is needed. */
    async verifyCanonicalOwnership(input: GatewayManagedEnvironmentContext) {
      try {
        const io = open(input, true);
        if (io.approvedCanonical === undefined) {
          throw unavailable();
        }
        const { rows } = await io.inspectOwnership(true);
        if (rows.length !== managedKeys.length) {
          throw unavailable();
        }
        await io.guard();
        return { rows: structuredClone(io.approvedCanonical) };
      } catch {
        throw unavailable();
      }
    },
    async verifyForDelivery(input: GatewayManagedEnvironmentContext) {
      if (input.effect.kind !== "gateway-delivery") {
        throw unavailable();
      }
      const io = open(input);
      const { rows, known, expected, values } = await io.inspect(true);
      if (rows.length !== Object.keys(expected).length) {
        throw unavailable();
      }
      await io.guard();
      return {
        rows: rows.map((row) =>
          referenceRow(
            row,
            input,
            new Map(known.map((item) => [item.id, item])),
            z.string().parse(values.get(row.id)),
          ),
        ),
      };
    },
  };
};
