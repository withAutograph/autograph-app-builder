/* oxlint-disable sonarjs/expression-complexity -- Credential adoption requires every owner, environment and dispatch identity to match. */
/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Reconcile the credential before publishing the dependent public boundary, checkpointing each write in order. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { repositoryProductionOperationRef } from "./repository-production-contract";
import type { RepositoryProductionRow } from "./repository-production-contract";
import {
  repositoryProductionAppBoundary,
  repositoryProductionAppBoundaryKey,
} from "./repository-production-app-boundary";
import type { RepositoryProductionRuntimeEndpoint } from "./repository-production-app-boundary";
import {
  observeRepositoryProductionPhase,
  reportRepositoryProductionFailure,
} from "./repository-production-diagnostic";
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
const detailSchema = rowSchema.omit({ id: true, target: true }).extend({
  id: z.string().optional(),
  target: z
    .union([z.array(z.string()), z.string()])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  value: z.string(),
  decrypted: z.boolean().optional(),
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
  runtimeEndpoint: RepositoryProductionRuntimeEndpoint;
  readCredential: (context: RepositoryProductionEffectContext) => Promise<string>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}) => {
  const conflict = (phase: "runtime_binding_ownership" | "runtime_binding_value"): never => {
    const error = new Error("repository_production_runtime_binding_conflict");
    reportRepositoryProductionFailure(phase, "binding_unavailable", error, input.signal);
    throw error;
  };
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
      throw Object.assign(new Error("repository_production_runtime_provider_failed"), {
        status: response.status,
      });
    }
    const value: unknown = await response.json();
    await context.assertCurrent();
    return value;
  };
  const metadata = (row: RepositoryProductionRow, runtimeUrl: string) => {
    const { intent, scope } = row.record;
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
  const bindings = (row: RepositoryProductionRow, runtimeUrl: string) => {
    const credential = metadata(row, runtimeUrl);
    const value = JSON.stringify(
      repositoryProductionAppBoundary(row, runtimeUrl, input.runtimeEndpoint),
    );
    const key = repositoryProductionAppBoundaryKey(row.record.scope.appId);
    if (key === credential.key) {
      conflict("runtime_binding_ownership");
    }
    return [
      { expected: credential, value: runtimeUrl, type: "encrypted" },
      { expected: { ...credential, key, valueSha256: hash(value) }, value, type: "plain" },
    ] as const;
  };
  const inspect = async (
    context: RepositoryProductionEffectContext,
    binding: ReturnType<typeof bindings>[number],
  ) => {
    const { expected, type } = binding;
    const project = encodeURIComponent(context.row.record.scope.projectId);
    const { envs: rows } = await observeRepositoryProductionPhase(
      "runtime_binding_list",
      "binding_unavailable",
      async () =>
        z
          .object({ envs: z.array(rowSchema) })
          .parse(await request(context, `/v10/projects/${project}/env`)),
      input.signal,
    );
    const matches = rows.filter(
      (row) => row.key === expected.key && row.target.includes("production"),
    );
    if (matches.length > 1) {
      conflict("runtime_binding_ownership");
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
      return { dispatched: checkpoints.length > 0, expected, row: undefined };
    }
    if (
      row.comment !== expected.marker ||
      row.type !== type ||
      row.target.length !== 1 ||
      (row.gitBranch !== undefined && row.gitBranch !== null) ||
      (row.configurationId !== undefined && row.configurationId !== null) ||
      (row.customEnvironmentIds?.length ?? 0) > 0 ||
      checkpoints.some((entry) => entry.rowId !== undefined && entry.rowId !== row.id) ||
      checkpoints.length === 0
    ) {
      conflict("runtime_binding_ownership");
    }
    const detail = await observeRepositoryProductionPhase(
      "runtime_binding_detail",
      "binding_unavailable",
      async () =>
        detailSchema.parse(
          await request(context, `/v1/projects/${project}/env/${encodeURIComponent(row.id)}`),
        ),
      input.signal,
    );
    if (detail.decrypted === false && type === "encrypted") {
      const error = new Error("repository_production_runtime_value_unavailable");
      reportRepositoryProductionFailure(
        "runtime_binding_value",
        "binding_unavailable",
        error,
        input.signal,
      );
      throw error;
    }
    if (
      (detail.id !== undefined && detail.id !== row.id) ||
      detail.key !== row.key ||
      detail.type !== row.type ||
      (detail.comment !== undefined && detail.comment !== expected.marker) ||
      (detail.target !== undefined &&
        (detail.target.length !== 1 || detail.target[0] !== "production")) ||
      (detail.gitBranch !== undefined && detail.gitBranch !== null) ||
      (detail.configurationId !== undefined && detail.configurationId !== null) ||
      (detail.customEnvironmentIds?.length ?? 0) > 0
    ) {
      conflict("runtime_binding_ownership");
    }
    if (hash(detail.value) !== expected.valueSha256) {
      conflict("runtime_binding_value");
    }
    return { dispatched: true, expected, row };
  };
  return {
    isReady(row: RepositoryProductionRow, runtimeUrl: string) {
      const [credential, boundary] = bindings(row, runtimeUrl);
      const proof = checkpointSchema.extend({ rowId: z.string().min(1) });
      const receipt = proof
        .extend({ boundary: proof })
        .safeParse(row.record.effects["bind-runtime"].receipt);
      return (
        receipt.success &&
        receipt.data.key === credential.expected.key &&
        receipt.data.marker === credential.expected.marker &&
        receipt.data.valueSha256 === credential.expected.valueSha256 &&
        receipt.data.boundary.key === boundary.expected.key &&
        receipt.data.boundary.marker === boundary.expected.marker &&
        receipt.data.boundary.valueSha256 === boundary.expected.valueSha256
      );
    },
    async apply(context: RepositoryProductionEffectContext, runtimeUrl: string) {
      for (const binding of bindings(context.row, runtimeUrl)) {
        const current = await inspect(context, binding);
        if (current.row !== undefined) {
          continue;
        }
        if (current.dispatched) {
          throw new Error("repository_production_runtime_reconciliation_required");
        }
        await context.checkpoint(current.expected);
        // The provider response is acknowledgement only; independent readback proves the binding.
        await observeRepositoryProductionPhase(
          "runtime_binding_write",
          "provider_unavailable",
          () =>
            request(
              context,
              `/v10/projects/${encodeURIComponent(context.row.record.scope.projectId)}/env`,
              {
                key: current.expected.key,
                value: binding.value,
                type: binding.type,
                target: ["production"],
                comment: current.expected.marker,
              },
            ),
          input.signal,
        );
      }
    },
    async reconcile(
      context: RepositoryProductionEffectContext,
      runtimeUrl: string,
    ): Promise<RepositoryProductionObservation> {
      const selected = bindings(context.row, runtimeUrl);
      const credential = await inspect(context, selected[0]);
      if (credential.row === undefined) {
        return { state: credential.dispatched ? "unknown" : "not-applied" };
      }
      const boundary = await inspect(context, selected[1]);
      if (boundary.row === undefined) {
        return { state: boundary.dispatched ? "unknown" : "not-applied" };
      }
      return {
        state: "applied",
        receipt: {
          ...credential.expected,
          rowId: credential.row.id,
          boundary: { ...boundary.expected, rowId: boundary.row.id },
        },
      };
    },
  };
};
