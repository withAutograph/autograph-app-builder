/* oxlint-disable eslint/no-await-in-loop, sonarjs/expression-complexity, sonarjs/no-nested-functions, react-doctor/async-await-in-loop -- Provider writes and their durable readbacks are deliberately sequential. */
import { z } from "zod";
import type { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { ManagedOperatorEnvironmentRow } from "./hosted-operator-contract";
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
const unavailable = () => new HostedOperatorError("operator_unavailable");
const managedKeys = [
  "AUTH_DATABASE_RESOURCE",
  "PLATFORM_AUTH_DATABASE_URL",
  "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
  "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
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

const validGatewayInput = (input: GatewayManagedEnvironmentContext) => {
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
    ["gateway-bindings", "gateway-delivery"].includes(input.effect.kind),
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
) => ({
  branch: input.gateway.branch,
  comment: z.string().min(1).parse(row.comment),
  id: row.id,
  key: row.key,
  operationRef: knownById.get(row.id)?.operationRef ?? input.operationRef,
  projectId: input.gateway.projectId,
});

export const createHostedOperatorGatewayBindings = (deps: {
  assertAuthorized: ProtectedHostedOperatorDependencies["assertAuthorized"];
  readCredential: CredentialReader;
  readAuthRuntimeUrl: (input: GatewayManagedEnvironmentContext) => Promise<string>;
  fetch?: typeof fetch;
}) => {
  const open = (input: GatewayManagedEnvironmentContext) => {
    if (!validGatewayInput(input)) {
      throw unavailable();
    }
    const { gateway, target } = input;
    const { branch, projectId } = gateway;
    const comment = `App Builder protected operator ${input.operationRef}`;
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
      return {
        AUTH_DATABASE_RESOURCE: JSON.stringify(authResource(input)),
        PLATFORM_AUTH_DATABASE_URL: runtimeUrl,
        PLATFORM_GATEWAY_PROTECTED_APPLICATIONS: JSON.stringify(protectedApplicationIds),
        PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify({
          browserOrigin: exactHttpsOrigin(gateway.authBrowserOrigin),
          builderCallbackOrigin: exactHttpsOrigin(gateway.builderCallbackOrigin),
          builderCallbackPath: "/api/hosted-operator/realm-identity",
          operatorOrigin: exactHttpsOrigin(gateway.operatorOrigin),
        }),
      };
    };
    const knownRows = () => {
      const known = input.gatewayEnvironmentRows ?? [];
      if (
        new Set(known.map((row) => row.id)).size !== known.length ||
        new Set(known.map((row) => row.key)).size !== known.length ||
        known.some(
          (row) =>
            row.projectId !== projectId ||
            row.branch !== branch ||
            !managedKeySchema.safeParse(row.key).success ||
            row.comment !== `App Builder protected operator ${row.operationRef}`,
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
      (row.comment === comment ||
        known.some(
          (item) => item.id === row.id && item.key === row.key && item.comment === row.comment,
        ));
    const checkpoint = async (rows: ProviderRow[], known: ManagedOperatorEnvironmentRow[]) => {
      await guard();
      const knownById = new Map(known.map((row) => [row.id, row]));
      await input.checkpointGatewayEnvironment(
        rows.map((row) => referenceRow(row, input, knownById)),
      );
      await guard();
    };
    const inspect = async (verifyValues: boolean) => {
      const known = knownRows();
      const listed = await list();
      await requiredEnvironment(listed);
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
      const expected = await expectedValues(rows);
      if (verifyValues) {
        for (const row of rows) {
          const actual = providerValue.parse(
            await request(
              `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(row.id)}`,
            ),
          );
          const key = managedKeySchema.parse(row.key);
          if (actual.value !== expected[key]) {
            throw unavailable();
          }
        }
      }
      return { expected, known, rows };
    };
    return { checkpoint, comment, guard, inspect, projectId, request };
  };

  return {
    async bind(input: GatewayManagedEnvironmentContext) {
      try {
        if (input.effect.kind !== "gateway-bindings") {
          throw unavailable();
        }
        const io = open(input);
        let { expected, known, rows } = await io.inspect(false);
        await io.checkpoint(rows, known);
        for (const [keyText, value] of Object.entries(expected)) {
          const key = managedKeySchema.parse(keyText);
          const rowsByKey = new Map(rows.map((row) => [row.key, row]));
          const existing = rowsByKey.get(key);
          const current = existing
            ? providerValue.parse(
                await io.request(
                  `/v1/projects/${encodeURIComponent(io.projectId)}/env/${encodeURIComponent(existing.id)}`,
                ),
              ).value
            : undefined;
          if (current === value) {
            continue;
          }
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
          ({ expected, known, rows } = await io.inspect(false));
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
          await io.checkpoint(rows, known);
        }
        ({ rows } = await io.inspect(true));
        const knownById = new Map(known.map((row) => [row.id, row]));
        return { rows: rows.map((row) => referenceRow(row, input, knownById)) };
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
        const { expected, known, rows } = await io.inspect(true);
        if (rows.length === 0) {
          return { status: "absent" };
        }
        await io.checkpoint(rows, known);
        const knownById = new Map(known.map((row) => [row.id, row]));
        return rows.length === Object.keys(expected).length
          ? {
              rows: rows.map((row) => referenceRow(row, input, knownById)),
              status: "applied",
            }
          : { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
    },
    async verifyForDelivery(input: GatewayManagedEnvironmentContext) {
      if (input.effect.kind !== "gateway-delivery") {
        throw unavailable();
      }
      const io = open(input);
      const { rows, known, expected } = await io.inspect(true);
      if (rows.length !== Object.keys(expected).length) {
        throw unavailable();
      }
      await io.guard();
      return {
        rows: rows.map((row) =>
          referenceRow(row, input, new Map(known.map((item) => [item.id, item]))),
        ),
      };
    },
  };
};
