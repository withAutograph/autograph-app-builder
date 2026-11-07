import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import {
  createHostedRuntimeVercelProvider,
  HostedRuntimeProviderError,
} from "./hosted-runtime-provider";
import {
  matchesPreviewEnvironmentGitBranch,
  resolveNativePreviewEnvironmentGitBranch,
} from "./native-preview-environment-scope";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyDeliveryPlanDigest } from "./native-target-auth-only-delivery-plan";
import {
  nativeTargetAuthOnlyPreviewEnvironmentManifestSchema,
  nativeTargetAuthOnlyRecoverySecretSchema,
  recoverySenderApiKey,
  recoverySenderFrom,
} from "./native-target-auth-only-preview-environment";
import type {
  createNativeTargetAuthOnlyPreviewEnvironmentPort,
  NativeTargetAuthOnlyDeliveryEnvironmentInput,
} from "./native-target-auth-only-preview-environment";
import type { HostedRuntimeTarget } from "./hosted-runtime-journal";

export type NativeTargetAuthOnlyPreviewEnvironmentApplyInput = Parameters<
  Parameters<typeof createNativeTargetAuthOnlyPreviewEnvironmentPort>[0]["applyAndVerify"]
>[0];
export interface NativeTargetAuthOnlyGatewayProjectionRow {
  projectId: string;
  physicalBranch: string | null;
  rowId: string;
  value: string;
}

type Credential = { binding: VercelInstallationBinding; token: string };
const senderKeys = [recoverySenderApiKey, recoverySenderFrom] as const;
const appKeys = ["PLATFORM_JWKS_URL", "PLATFORM_ORIGIN", "PLATFORM_PUBLIC_ORIGIN"] as const;
const gatewayKeys = [
  "AUTH_DATABASE_RESOURCE",
  "PLATFORM_AUTH_DATABASE_URL",
  "PLATFORM_GATEWAY_PROJECT_BINDINGS",
  "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
  "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
  "AUTH_REQUIRE_EMAIL_VERIFICATION",
  recoverySenderFrom,
] as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const mismatch = () => new HostedRuntimeProviderError("resource_mismatch");
const unavailable = () => new HostedRuntimeProviderError("provider_unavailable");
const denied = () => new HostedRuntimeProviderError("authorization_required");
const projectSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  framework: z.string().nullable(),
  rootDirectory: z.string().nullable(),
  buildCommand: z.string().nullable().optional(),
  sourceFilesOutsideRootDirectory: z.boolean().optional(),
  link: z
    .object({
      type: z.literal("github"),
      repoId: z.union([z.string(), z.number()]),
      productionBranch: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
const rowSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  value: z.string().optional(),
  comment: z.string().nullable().optional(),
  configurationId: z.string().optional(),
  type: z.string().optional(),
  visibility: z.string().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  system: z.boolean().optional(),
  customEnvironmentIds: z.array(z.string()).optional(),
  target: z.union([z.string(), z.array(z.string())]),
  gitBranch: z.string().nullable().optional(),
});
const listedRowSchema = rowSchema.omit({ value: true });
const rowsSchema = z.union([
  z.array(listedRowSchema),
  z.object({ envs: z.array(listedRowSchema) }).transform((value) => value.envs),
]);
type Row = z.infer<typeof rowSchema>;
const hasPreview = (row: Row) =>
  Array.isArray(row.target) ? row.target.includes("preview") : row.target === "preview";
const exactPreview = (row: Row, branch: string | null) =>
  matchesPreviewEnvironmentGitBranch(row.gitBranch, branch) &&
  (Array.isArray(row.target)
    ? row.target.length === 1 && row.target[0] === "preview"
    : row.target === "preview");
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw mismatch();
  return parsed.data;
};
const listQuery = (branch: string | null): Record<string, string> =>
  branch === null ? {} : { gitBranch: branch };
const isDirectSender = (row: Row) =>
  (row.configurationId ?? "") === "" &&
  row.system !== true &&
  row.type !== "system" &&
  (row.customEnvironmentIds?.length ?? 0) === 0;
const hasLegacySecretType = (row: Row) => row.type === "secret" || row.type === "sensitive";
const isSecret = (row: Row) =>
  row.visibility === undefined ? hasLegacySecretType(row) : row.visibility === "secret";
const isReadableSender = (row: Row) =>
  isDirectSender(row) &&
  !hasLegacySecretType(row) &&
  (row.visibility === undefined || row.visibility === "config");
const ownsExpectedRow = (row: Row, runtimeId: string) =>
  row.key === recoverySenderFrom
    ? isReadableSender(row)
    : (row.configurationId ?? "") === "" && row.comment === `App Builder runtime ${runtimeId}`;
const assertGatewayEmailVerification = (values: Readonly<Record<string, string>>) => {
  if (
    values.AUTH_REQUIRE_EMAIL_VERIFICATION !== "true" ||
    !z.email().safeParse(values[recoverySenderFrom]).success
  ) {
    throw mismatch();
  }
};
const selectSenderRow = (rows: Row[], key: string, physicalBranch: string | null) => {
  const matches = rows.filter(
    (row) =>
      row.key === key &&
      hasPreview(row) &&
      matchesPreviewEnvironmentGitBranch(row.gitBranch, physicalBranch),
  );
  const row = matches[0];
  if (
    matches.length !== 1 ||
    row === undefined ||
    !exactPreview(row, physicalBranch) ||
    !isDirectSender(row)
  ) {
    throw mismatch();
  }
  return row;
};
const secretMetadata = (rows: Row[], projectId: string, physicalBranch: string | null) => {
  const row = selectSenderRow(rows, recoverySenderApiKey, physicalBranch);
  if (!isSecret(row)) {
    throw mismatch();
  }
  return parse(nativeTargetAuthOnlyRecoverySecretSchema, {
    id: row.id,
    key: row.key,
    projectId,
    target: "preview",
    physicalBranch,
    type: row.type,
    ...(row.visibility === undefined ? {} : { visibility: row.visibility }),
    ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
    ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
  });
};
const exactKeys = (values: Readonly<Record<string, string>>, keys: readonly string[]) => {
  if (
    !isDeepStrictEqual(Object.keys(values).toSorted(), [...keys].toSorted()) ||
    Object.values(values).some((value) => typeof value !== "string" || value.length === 0)
  )
    throw mismatch();
};

/** Only the existing Preview environment API writes values; sender rows remain operator-owned and read-only. */
export const createNativeTargetAuthOnlyPreviewEnvironmentAdapter = (deps: {
  readCredential: (
    authority: NativeTargetAuthOnlyDeliveryEnvironmentInput["authority"],
    installationId: string,
  ) => Promise<Credential | undefined>;
  fetch?: typeof fetch;
}) => {
  const connect = async (
    input: Pick<
      NativeTargetAuthOnlyPreviewEnvironmentApplyInput,
      "authority" | "target" | "assertCurrent" | "signal"
    >,
    target: HostedRuntimeTarget,
    write?: {
      values: Readonly<Record<string, string>>;
      runtimeId: string;
      physicalBranch: string | null;
      allowUnlinkedProject: boolean;
      beforeWrite: () => Promise<void>;
    },
  ) => {
    if (
      target.environment !== "preview" ||
      target.scopeType !== "team" ||
      target.scopeId !== input.target.scopeId ||
      target.installationId !== input.target.installationId
    )
      throw mismatch();
    const current = async () => {
      input.signal.throwIfAborted();
      await input.assertCurrent();
      const credential = await deps.readCredential(
        structuredClone(input.authority),
        target.installationId,
      );
      if (
        credential === undefined ||
        !credential.binding.active ||
        credential.binding.installationId !== target.installationId ||
        credential.binding.scopeId !== target.scopeId ||
        credential.binding.scopeType !== "team" ||
        credential.token.length === 0
      )
        throw denied();
      input.signal.throwIfAborted();
      await input.assertCurrent();
      return credential;
    };
    const credential = await current();
    const projectPath = encodeURIComponent(target.projectId);
    const fencedFetch: typeof fetch = async (raw, init) => {
      const url = new URL(raw instanceof Request ? raw.url : String(raw));
      const method = init?.method ?? "GET";
      const paths = [`/v9/projects/${projectPath}`, `/v10/projects/${projectPath}/env`];
      if (
        url.origin !== "https://api.vercel.com" ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.get("teamId") !== target.scopeId ||
        !(
          paths.includes(url.pathname) ||
          url.pathname.startsWith(`/v1/projects/${projectPath}/env/`)
        ) ||
        !["GET", "POST"].includes(method)
      )
        throw mismatch();
      if (method === "GET" && url.pathname === paths[1]) {
        url.searchParams.set("decrypt", "false");
      }
      if (method === "POST") {
        if (
          write === undefined ||
          url.pathname !== paths[1] ||
          url.searchParams.get("upsert") !== "false" ||
          typeof init?.body !== "string"
        )
          throw mismatch();
        const body = parse(
          z
            .array(
              z.strictObject({
                key: z.string(),
                value: z.string(),
                comment: z.string(),
                target: z.tuple([z.literal("preview")]),
                type: z.literal("encrypted"),
                gitBranch: z.string().optional(),
              }),
            )
            .min(1),
          JSON.parse(init.body),
        );
        if (
          new Set(body.map((row) => row.key)).size !== body.length ||
          body.some(
            (row) =>
              !(row.key in write.values) ||
              senderKeys.includes(row.key as (typeof senderKeys)[number]) ||
              row.value !== write.values[row.key] ||
              row.comment !== `App Builder runtime ${write.runtimeId}` ||
              !matchesPreviewEnvironmentGitBranch(row.gitBranch, write.physicalBranch),
          )
        )
          throw mismatch();
      }
      if (method === "POST") {
        await write!.beforeWrite();
        const latestProject = await project();
        if (
          resolveNativePreviewEnvironmentGitBranch(target.branch, latestProject, {
            allowUnlinkedProject: write!.allowUnlinkedProject,
          }) !== write!.physicalBranch
        )
          throw mismatch();
      }
      const fresh = await current();
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${fresh.token}`);
      const response = await (deps.fetch ?? fetch)(url, {
        ...init,
        headers,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
      });
      try {
        await input.assertCurrent();
        input.signal.throwIfAborted();
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      return response;
    };
    const get = async (path: string, query: Record<string, string> = {}) => {
      const url = new URL(path, "https://api.vercel.com");
      url.searchParams.set("teamId", target.scopeId);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      let response: Response;
      try {
        response = await fencedFetch(url, { method: "GET" });
      } catch (error) {
        if (error instanceof HostedRuntimeProviderError) throw error;
        input.signal.throwIfAborted();
        throw unavailable();
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw denied();
        throw unavailable();
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        throw unavailable();
      }
    };
    const project = async () => {
      const observed = parse(projectSchema, await get(`/v9/projects/${projectPath}`));
      if (observed.id !== target.projectId || observed.accountId !== target.scopeId)
        throw mismatch();
      return observed;
    };
    return {
      current,
      get,
      project,
      provider: (physicalBranch: string | null) =>
        createHostedRuntimeVercelProvider({
          target,
          credential,
          fetch: fencedFetch,
          signal: input.signal,
          environmentGitBranch: physicalBranch,
        }),
    };
  };
  const openGatewayProjection = async (input: NativeTargetAuthOnlyDeliveryEnvironmentInput) => {
    const { approval, target, deliveryPlan } = input;
    const gateway = deliveryPlan.delivery.gatewayDelivery;
    const source = deliveryPlan.delivery.publicGateway;
    const digest = nativeTargetAuthOnlyDeliveryPlanDigest(
      Buffer.from(JSON.stringify(deliveryPlan)),
    );
    if (gateway === undefined || source === undefined || input.effect !== "gateway") {
      throw mismatch();
    }
    if (
      gateway.projectId !== source.projectId ||
      gateway.branch !== source.branch ||
      gateway.projectId === target.projectId
    ) {
      throw mismatch();
    }
    if (
      approval.planDigest !== digest ||
      approval.sourceDigest !== digest ||
      approval.outcome !== "approved"
    ) {
      throw denied();
    }
    if (
      approval.publicSessionId !== target.sessionId ||
      approval.responderPrincipalId !== input.authority.ownerUserId
    ) {
      throw denied();
    }
    if (
      !isDeepStrictEqual(target, deliveryPlan.target) ||
      nativeTargetAuthOnlyPlanDigest(input.plan) !== deliveryPlan.authOnlyPlanDigest
    ) {
      throw mismatch();
    }
    if (
      !z.uuid().safeParse(input.operationRef).success ||
      !Number.isSafeInteger(input.fenceGeneration) ||
      input.fenceGeneration <= 0
    ) {
      throw mismatch();
    }
    const gatewayTarget = { ...target, projectId: gateway.projectId, branch: gateway.branch };
    const connection = await connect(input, gatewayTarget);
    const projectPath = encodeURIComponent(gateway.projectId);
    const key = "PLATFORM_GATEWAY_PROJECT_BINDINGS";
    const ownerComment = `App Builder runtime auth-only-preview:${input.operationRef}:${digest}:${gateway.projectId}`;
    const matches = (row: Row, physicalBranch: string | null) =>
      row.key === key &&
      exactPreview(row, physicalBranch) &&
      row.comment === ownerComment &&
      !row.configurationId;
    const read = async (): Promise<NativeTargetAuthOnlyGatewayProjectionRow> => {
      const project = await connection.project();
      if (project.link == null || String(project.link.repoId) !== gateway.repoId) {
        throw mismatch();
      }
      const physicalBranch = resolveNativePreviewEnvironmentGitBranch(gateway.branch, project);
      const rows = parse(
        rowsSchema,
        await connection.get(`/v10/projects/${projectPath}/env`, listQuery(physicalBranch)),
      );
      const scoped = rows.filter(
        (row) =>
          row.key === key &&
          hasPreview(row) &&
          matchesPreviewEnvironmentGitBranch(row.gitBranch, physicalBranch),
      );
      const row = scoped[0];
      if (
        scoped.length !== 1 ||
        row === undefined ||
        row.type !== "encrypted" ||
        !matches(row, physicalBranch)
      ) {
        throw mismatch();
      }
      const detail = parse(
        rowSchema,
        await connection.get(`/v1/projects/${projectPath}/env/${encodeURIComponent(row.id)}`),
      );
      if (detail.id !== row.id || detail.value === undefined || !matches(detail, physicalBranch)) {
        throw mismatch();
      }
      await input.assertCurrent();
      return { projectId: gateway.projectId, physicalBranch, rowId: row.id, value: detail.value };
    };
    return {
      read,
      async patch(
        expected: NativeTargetAuthOnlyGatewayProjectionRow,
        value: string,
        assertAuthorized: () => Promise<void>,
      ) {
        const prior = await read();
        if (!isDeepStrictEqual(prior, expected) || value === prior.value) {
          throw mismatch();
        }
        const credential = await connection.current();
        await assertAuthorized();
        input.signal.throwIfAborted();
        const url = new URL(
          `/v9/projects/${projectPath}/env/${encodeURIComponent(prior.rowId)}`,
          "https://api.vercel.com",
        );
        url.searchParams.set("teamId", target.scopeId);
        const response = await (deps.fetch ?? fetch)(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ type: "encrypted", value }),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
        });
        await response.body?.cancel();
        if (!response.ok) {
          throw unavailable();
        }
        await input.assertCurrent();
      },
    };
  };
  return {
    openGatewayProjection,
    async readRecoverySender(input: NativeTargetAuthOnlyDeliveryEnvironmentInput) {
      const gateway = input.deliveryPlan.delivery.gatewayDelivery;
      if (
        gateway === undefined ||
        gateway.projectId !== input.deliveryPlan.delivery.publicGateway?.projectId ||
        gateway.branch !== input.deliveryPlan.delivery.publicGateway?.branch ||
        gateway.projectId === input.target.projectId
      ) {
        throw mismatch();
      }
      const target = { ...input.target, projectId: gateway.projectId, branch: gateway.branch };
      const connection = await connect(input, target);
      const project = await connection.project();
      if (project.link?.repoId === undefined || String(project.link.repoId) !== gateway.repoId) {
        throw mismatch();
      }
      const physicalBranch = resolveNativePreviewEnvironmentGitBranch(gateway.branch, project);
      const path = `/v10/projects/${encodeURIComponent(target.projectId)}/env`;
      const rows = parse(rowsSchema, await connection.get(path, listQuery(physicalBranch)));
      const apiKey = secretMetadata(rows, target.projectId, physicalBranch);
      const fromRow = selectSenderRow(rows, recoverySenderFrom, physicalBranch);
      if (fromRow.id === apiKey.id || !isReadableSender(fromRow)) {
        throw mismatch();
      }
      const decoded = parse(
        rowSchema,
        await connection.get(
          `/v1/projects/${encodeURIComponent(target.projectId)}/env/${encodeURIComponent(fromRow.id)}`,
        ),
      );
      if (
        decoded.id !== fromRow.id ||
        decoded.key !== recoverySenderFrom ||
        !exactPreview(decoded, physicalBranch) ||
        !isReadableSender(decoded)
      ) {
        throw mismatch();
      }
      const from = parse(z.email(), decoded.value);
      await connection.current();
      return {
        provider: "resend" as const,
        environment: "preview" as const,
        ownerProjectId: target.projectId,
        from,
        apiKey,
      };
    },
    async readProjectEnvironmentValues(
      input: NativeTargetAuthOnlyDeliveryEnvironmentInput,
      target: HostedRuntimeTarget,
      keys: readonly string[],
      allowUnlinkedProject = false,
    ) {
      if (keys.includes(recoverySenderApiKey)) {
        throw mismatch();
      }
      const connection = await connect(input, target);
      const project = await connection.project();
      const physicalBranch = resolveNativePreviewEnvironmentGitBranch(target.branch, project, {
        allowUnlinkedProject,
      });
      const rows = parse(
        rowsSchema,
        await connection.get(
          `/v10/projects/${encodeURIComponent(target.projectId)}/env`,
          listQuery(physicalBranch),
        ),
      );
      const values: Record<string, string> = {};
      for (const key of keys) {
        const previewRows = rows.filter((row) => row.key === key && hasPreview(row));
        const matches = rows.filter(
          (row) =>
            row.key === key &&
            hasPreview(row) &&
            matchesPreviewEnvironmentGitBranch(row.gitBranch, physicalBranch),
        );
        if (matches.length === 0 && previewRows.length > 0) throw mismatch();
        if (matches.length > 1) throw mismatch();
        const row = matches[0];
        if (row === undefined) continue;
        if (!exactPreview(row, physicalBranch) || row.configurationId !== undefined)
          throw mismatch();
        const value = parse(
          rowSchema,
          await connection.get(
            `/v1/projects/${encodeURIComponent(target.projectId)}/env/${encodeURIComponent(row.id)}`,
          ),
        );
        if (
          value.id !== row.id ||
          value.key !== key ||
          !exactPreview(value, physicalBranch) ||
          value.configurationId !== undefined ||
          value.value === undefined
        )
          throw mismatch();
        values[key] = value.value;
      }
      await connection.current();
      return { project, physicalBranch, values };
    },
    async readProjectMetadata(input: NativeTargetAuthOnlyDeliveryEnvironmentInput) {
      const authority = structuredClone(input.authority);
      const delivery = structuredClone(input.deliveryPlan);
      const plan = structuredClone(input.plan);
      if (
        input.target.environment !== "preview" ||
        delivery.authOnlyPlanDigest !== nativeTargetAuthOnlyPlanDigest(plan) ||
        input.target.appId !== plan.appId ||
        input.target.sessionId !== plan.origin.publicSessionId ||
        !isDeepStrictEqual(delivery.source, {
          branch: plan.publishedSource.branch,
          gitSha: plan.publishedSource.gitSha,
          repositoryId: plan.publishedSource.repositoryId,
        }) ||
        !isDeepStrictEqual(input.target, delivery.target) ||
        !isDeepStrictEqual(authority, plan.origin.authority) ||
        input.approval.outcome !== "approved" ||
        input.approval.planDigest !==
          nativeTargetAuthOnlyDeliveryPlanDigest(Buffer.from(JSON.stringify(delivery))) ||
        input.approval.sourceDigest !== input.approval.planDigest ||
        input.approval.responderPrincipalId !== authority.ownerUserId ||
        input.approval.publicSessionId !== input.target.sessionId ||
        !Number.isSafeInteger(input.fenceGeneration) ||
        input.fenceGeneration <= 0
      )
        throw mismatch();
      const app = delivery.delivery.delivery;
      const gateway = delivery.delivery.gatewayDelivery;
      if (
        app === undefined ||
        gateway === undefined ||
        app.projectId !== input.target.projectId ||
        app.branch !== input.target.branch ||
        gateway.projectId !== delivery.delivery.publicGateway?.projectId ||
        app.projectId === gateway.projectId
      )
        throw mismatch();
      const gatewayConnection = await connect(input, {
        ...input.target,
        projectId: gateway.projectId,
        branch: gateway.branch,
      });
      const appConnection = await connect(input, input.target);
      const gatewayProjectMetadata = await gatewayConnection.project();
      const appProjectMetadata = await appConnection.project();
      if (
        gatewayProjectMetadata.link == null ||
        String(gatewayProjectMetadata.link.repoId) !== gateway.repoId
      )
        throw mismatch();
      const settings = plan.project.projectSettings;
      if (
        appProjectMetadata.framework !== settings.framework ||
        appProjectMetadata.rootDirectory !== settings.rootDirectory ||
        (settings.buildCommand !== undefined &&
          (appProjectMetadata.buildCommand ?? null) !== settings.buildCommand) ||
        (settings.sourceFilesOutsideRootDirectory !== undefined &&
          appProjectMetadata.sourceFilesOutsideRootDirectory !==
            settings.sourceFilesOutsideRootDirectory) ||
        (appProjectMetadata.link != null && String(appProjectMetadata.link.repoId) !== app.repoId)
      )
        throw mismatch();
      await input.assertCurrent();
      input.signal.throwIfAborted();
      return { gatewayProjectMetadata, appProjectMetadata };
    },
    async applyAndVerify(input: NativeTargetAuthOnlyPreviewEnvironmentApplyInput): Promise<void> {
      const manifest = parse(
        nativeTargetAuthOnlyPreviewEnvironmentManifestSchema,
        structuredClone(input.manifest),
      );
      const values = { ...input.values };
      const selected = manifest[input.effect];
      if (
        input.target.environment !== "preview" ||
        input.target.scopeType !== "team" ||
        manifest.deliveryPlanDigest !== input.approvedDeliveryDigest ||
        manifest.app.projectId !== input.target.projectId ||
        manifest.app.branch !== input.target.branch ||
        manifest.gateway.projectId === manifest.app.projectId ||
        input.projectId !== selected.projectId ||
        input.branch !== selected.branch ||
        input.physicalBranch !== selected.physicalBranch ||
        !z.uuid().safeParse(input.operationRef).success ||
        !Number.isSafeInteger(input.fenceGeneration) ||
        input.fenceGeneration <= 0
      )
        throw mismatch();
      exactKeys(values, input.effect === "gateway" ? gatewayKeys : appKeys);
      if (
        selected.values.length !== Object.keys(values).length ||
        new Set(selected.values.map((entry) => entry.key)).size !== selected.values.length ||
        selected.values.some((entry) => hash(values[entry.key] ?? "") !== entry.sha256)
      )
        throw mismatch();
      if (input.effect === "gateway") {
        assertGatewayEmailVerification(values);
      }
      const target = { ...input.target, projectId: input.projectId, branch: input.branch };
      const runtimeId = `auth-only-preview:${input.operationRef}:${input.approvedDeliveryDigest}:${input.projectId}`;
      const managed = Object.fromEntries(
        Object.entries(values).filter(
          ([key]) => !senderKeys.includes(key as (typeof senderKeys)[number]),
        ),
      );
      let beforeWrite: () => Promise<void> = async () => {
        throw unavailable();
      };
      const connection = await connect(input, target, {
        values: managed,
        runtimeId,
        physicalBranch: input.physicalBranch,
        allowUnlinkedProject: input.effect === "app",
        beforeWrite: async () => await beforeWrite(),
      });
      const project = await connection.project();
      if (
        resolveNativePreviewEnvironmentGitBranch(input.branch, project, {
          allowUnlinkedProject: input.effect === "app",
        }) !== input.physicalBranch
      )
        throw mismatch();
      const provider = connection.provider(input.physicalBranch);
      const list = async () =>
        parse(
          rowsSchema,
          await connection.get(
            `/v10/projects/${encodeURIComponent(target.projectId)}/env`,
            listQuery(input.physicalBranch),
          ),
        );
      const observe = async (requireAll: boolean) => {
        const rows = await list();
        const ids = new Set<string>();
        if (input.effect === "gateway") {
          const key = secretMetadata(rows, target.projectId, input.physicalBranch);
          if (!isDeepStrictEqual(key, manifest.gateway.recoverySecret)) {
            throw mismatch();
          }
          ids.add(key.id);
        }
        const missing: string[] = [];
        for (const key of Object.keys(values)) {
          const matches = rows.filter(
            (row) =>
              row.key === key &&
              hasPreview(row) &&
              matchesPreviewEnvironmentGitBranch(row.gitBranch, input.physicalBranch),
          );
          if (matches.length > 1) throw mismatch();
          const row = matches[0];
          const sender = key === recoverySenderFrom;
          if (row === undefined) {
            if (sender || requireAll) throw mismatch();
            missing.push(key);
            continue;
          }
          if (
            !exactPreview(row, input.physicalBranch) ||
            ids.has(row.id) ||
            !ownsExpectedRow(row, runtimeId)
          )
            throw mismatch();
          ids.add(row.id);
          const decoded = parse(
            rowSchema,
            await connection.get(
              `/v1/projects/${encodeURIComponent(target.projectId)}/env/${encodeURIComponent(row.id)}`,
            ),
          );
          if (
            decoded.id !== row.id ||
            decoded.key !== key ||
            !exactPreview(decoded, input.physicalBranch) ||
            decoded.value !== values[key] ||
            !ownsExpectedRow(decoded, runtimeId)
          )
            throw mismatch();
        }
        return missing;
      };
      beforeWrite = async () => {
        await observe(false);
      };
      const missing = await observe(false);
      await connection.current();
      if (missing.length > 0)
        await provider.bindEnvironment(
          Object.fromEntries(missing.map((key) => [key, values[key]!])),
          { runtimeId },
        );
      await provider.assertEnvironmentBindings(managed, { runtimeId });
      await observe(true);
      await connection.current();
    },
  };
};
