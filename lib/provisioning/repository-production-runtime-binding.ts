/* oxlint-disable sonarjs/expression-complexity -- Credential adoption requires every owner, environment and dispatch identity to match. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { repositoryProductionOperationRef } from "./repository-production-contract";
import type {
  RepositoryProductionEffectContext,
  RepositoryProductionObservation,
} from "./repository-production-setup";

interface RuntimeRequestHeaders extends Record<string, string> {
  authorization: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const rowSchema = z.object({
  id: z.string(),
  key: z.string(),
  type: z.string(),
  target: z.array(z.string()),
  comment: z.string().optional(),
  gitBranch: z.string().nullable().optional(),
  configurationId: z.string().nullable().optional(),
  customEnvironmentIds: z.array(z.string()).optional(),
});
const checkpointSchema = z.object({
  kind: z.literal("repository-production-runtime-binding"),
  key: z.string(),
  marker: z.string(),
  valueSha256: z.string(),
  rowId: z.string().optional(),
});
export const createRepositoryProductionRuntimeBinding = (input: {
  teamId: string;
  readCredential: (context: RepositoryProductionEffectContext) => Promise<string>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}) => {
  const request = async (
    context: RepositoryProductionEffectContext,
    path: string,
    body?: Record<string, string | string[]>,
  ) => {
    await context.assertCurrent();
    const token = await input.readCredential(context);
    await context.assertCurrent();
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", input.teamId);
    const fetchRequest = input.fetch ?? fetch;
    const initial: Pick<RequestInit, "method" | "cache" | "redirect" | "signal"> = {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      redirect: "error",
      signal: input.signal,
    };
    const headers: RuntimeRequestHeaders = {
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const options: RequestInit = { ...initial, headers };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const response = await fetchRequest(url, options);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("repository_production_runtime_provider_failed");
    }
    const value: unknown = await response.json();
    await context.assertCurrent();
    return value;
  };
  const metadata = (context: RepositoryProductionEffectContext, runtimeUrl: string) => {
    const { intent, scope } = context.row.record;
    if (intent.storage.kind !== "postgres") {
      throw new Error("repository_production_storage_unavailable");
    }
    return {
      kind: "repository-production-runtime-binding" as const,
      key: intent.storage.databaseEnvironment,
      marker: `autograph:repository-production:${repositoryProductionOperationRef(scope)}`,
      valueSha256: hash(runtimeUrl),
    };
  };
  const inspect = async (context: RepositoryProductionEffectContext, runtimeUrl: string) => {
    const expected = metadata(context, runtimeUrl);
    const project = encodeURIComponent(context.row.record.scope.projectId);
    const rows = z
      .object({ envs: z.array(rowSchema) })
      .parse(await request(context, `/v10/projects/${project}/env`)).envs;
    const matches = rows.filter(
      (row) => row.key === expected.key && row.target.includes("production"),
    );
    if (matches.length > 1) {
      throw new Error("repository_production_runtime_binding_conflict");
    }
    const [row] = matches;
    const checkpoints = context.row.record.workerCheckpoints.flatMap((value) => {
      const parsed = checkpointSchema.safeParse(value);
      if (!parsed.success) {
        return [];
      }
      const entry = parsed.data;
      return entry.key === expected.key &&
        entry.marker === expected.marker &&
        entry.valueSha256 === expected.valueSha256
        ? [entry]
        : [];
    });
    if (row === undefined) {
      return { expected, row: undefined, dispatched: checkpoints.length > 0 };
    }
    if (
      row.comment !== expected.marker ||
      row.type !== "encrypted" ||
      row.target.length !== 1 ||
      (row.gitBranch !== undefined && row.gitBranch !== null) ||
      (row.configurationId !== undefined && row.configurationId !== null) ||
      (row.customEnvironmentIds?.length ?? 0) > 0 ||
      checkpoints.some((entry) => entry.rowId !== undefined && entry.rowId !== row.id) ||
      checkpoints.length === 0
    ) {
      throw new Error("repository_production_runtime_binding_conflict");
    }
    const detail = rowSchema
      .extend({ value: z.string() })
      .parse(await request(context, `/v1/projects/${project}/env/${encodeURIComponent(row.id)}`));
    if (
      detail.id !== row.id ||
      detail.key !== row.key ||
      detail.comment !== expected.marker ||
      hash(detail.value) !== expected.valueSha256
    ) {
      throw new Error("repository_production_runtime_binding_conflict");
    }
    return { expected, row, dispatched: true };
  };
  return {
    async apply(context: RepositoryProductionEffectContext, runtimeUrl: string) {
      const current = await inspect(context, runtimeUrl);
      if (current.row !== undefined) {
        return;
      }
      if (current.dispatched) {
        throw new Error("repository_production_runtime_reconciliation_required");
      }
      await context.checkpoint(current.expected);
      // The provider response is acknowledgement only; independent readback proves the binding.
      await request(
        context,
        `/v10/projects/${encodeURIComponent(context.row.record.scope.projectId)}/env`,
        {
          key: current.expected.key,
          value: runtimeUrl,
          type: "encrypted",
          target: ["production"],
          comment: current.expected.marker,
        },
      );
    },
    async reconcile(
      context: RepositoryProductionEffectContext,
      runtimeUrl: string,
    ): Promise<RepositoryProductionObservation> {
      const current = await inspect(context, runtimeUrl);
      if (current.row !== undefined) {
        return { state: "applied", receipt: { ...current.expected, rowId: current.row.id } };
      }
      return { state: current.dispatched ? "unknown" : "not-applied" };
    },
  };
};
