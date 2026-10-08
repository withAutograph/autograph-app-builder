/* oxlint-disable eslint/no-await-in-loop, sonarjs/expression-complexity, sonarjs/no-nested-functions, react-doctor/async-await-in-loop, react-doctor/js-cache-property-access -- Provider effects and durable checkpoints are intentionally sequential. */
import { z } from "zod";
import type { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { HostedOperatorError, restrictedOperatorEnvironment } from "./hosted-operator-contract";
import type {
  ProtectedAppEnvironment,
  ManagedOperatorEnvironmentRow,
} from "./hosted-operator-contract";
import type {
  HostedOperatorManagedEnvironmentContext,
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
const unavailable = () => new HostedOperatorError("operator_unavailable");
export const createHostedOperatorEnvironmentBindings = (deps: {
  readCredential: (
    authority: HostedOperatorManagedEnvironmentContext["authority"],
    installationId: string,
  ) => ReturnType<typeof readActiveVercelInstallationToken>;
  assertAuthorized: ProtectedHostedOperatorDependencies["assertAuthorized"];
  fetch?: typeof fetch;
}) => {
  const open = (
    input: HostedOperatorManagedEnvironmentContext,
    values: ProtectedAppEnvironment,
  ) => {
    const expected = restrictedOperatorEnvironment(input.plan, values, input.authority);
    const { target } = input;
    const boundary = input.plan.deploymentBoundary;
    if (
      !boundary ||
      target.environment !== "preview" ||
      target.projectId !== boundary.app.projectId ||
      target.branch !== boundary.app.branch ||
      target.scopeId !== boundary.teamId ||
      target.scopeType !== "team"
    ) {
      throw unavailable();
    }
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
        !credential ||
        !credential.binding.active ||
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
          Authorization: `Bearer ${credential.token}`,
          "Content-Type": "application/json",
        },
        method,
        redirect: "error",
      };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      const response = await (deps.fetch ?? fetch)(url, options);
      await guard();
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable();
      }
      if (response.status === 204) {
        return null;
      }
      const result: unknown = await response.json();
      await guard();
      return result;
    };
    const list = async () =>
      z
        .object({ envs: z.array(providerRow) })
        .parse(await request(`/v10/projects/${encodeURIComponent(target.projectId)}/env`)).envs;
    const relevant = (row: ProviderRow) =>
      row.target.includes("preview") &&
      (row.gitBranch === null || row.gitBranch === undefined || row.gitBranch === target.branch) &&
      Object.hasOwn(expected, row.key);
    const owned = (row: ProviderRow) =>
      row.target.length === 1 &&
      row.target[0] === "preview" &&
      row.gitBranch === target.branch &&
      (row.configurationId === undefined ||
        row.configurationId === null ||
        row.configurationId === "") &&
      row.type === "encrypted" &&
      (row.comment === comment ||
        (input.managedEnvironment ?? []).some(
          (known) => known.id === row.id && known.key === row.key && known.comment === row.comment,
        ));
    const reference = (row: ProviderRow): ManagedOperatorEnvironmentRow => ({
      branch: target.branch,
      comment: z.string().min(1).parse(row.comment),
      id: row.id,
      key: row.key,
      operationRef:
        (input.managedEnvironment ?? []).find((known) => known.id === row.id)?.operationRef ??
        input.operationRef,
      projectId: target.projectId,
    });
    const validateKnown = () => {
      const known = input.managedEnvironment ?? [];
      if (
        new Set(known.map((row) => row.id)).size !== known.length ||
        new Set(known.map((row) => row.key)).size !== known.length ||
        known.some(
          (row) =>
            row.branch !== target.branch ||
            row.projectId !== target.projectId ||
            row.comment !== `App Builder protected operator ${row.operationRef}` ||
            !Object.hasOwn(expected, row.key),
        )
      ) {
        throw unavailable();
      }
      return known;
    };
    const inspect = async (verifyValues = true) => {
      const known = validateKnown();
      const listed = await list();
      const rows = listed.filter(relevant);
      if (
        rows.some((row) => !owned(row)) ||
        new Set(rows.map((row) => row.key)).size !== rows.length ||
        known.some((row) => rows.some((actual) => actual.key === row.key && actual.id !== row.id))
      ) {
        throw unavailable();
      }
      for (const row of verifyValues ? rows : []) {
        const plaintext = z
          .object({ value: z.string() })
          .parse(
            await request(
              `/v1/projects/${encodeURIComponent(target.projectId)}/env/${encodeURIComponent(row.id)}`,
            ),
          );
        if (plaintext.value !== expected[row.key]) {
          throw unavailable();
        }
      }
      return rows;
    };
    const checkpoint = async (rows: ProviderRow[]) => {
      await guard();
      await input.checkpointManagedEnvironment(rows.map(reference));
      await guard();
    };
    return { checkpoint, comment, expected, guard, inspect, reference, request, target };
  };
  return {
    async bind(input: HostedOperatorManagedEnvironmentContext, values: ProtectedAppEnvironment) {
      try {
        if (input.plan.action !== "prepare" || input.effect.kind !== "bindings") {
          throw unavailable();
        }
        const io = open(input, values);
        let rows = await io.inspect(false);
        await io.checkpoint(rows);
        for (const [key, value] of Object.entries(io.expected)) {
          const existing = rows.find((row) => row.key === key);
          if (existing) {
            const plaintext = z
              .object({ value: z.string() })
              .parse(
                await io.request(
                  `/v1/projects/${encodeURIComponent(io.target.projectId)}/env/${encodeURIComponent(existing.id)}`,
                ),
              );
            if (plaintext.value === value) {
              continue;
            }
            await io.request(
              `/v9/projects/${encodeURIComponent(io.target.projectId)}/env/${encodeURIComponent(existing.id)}`,
              "PATCH",
              { type: "encrypted", value },
            );
          } else {
            await io.request(
              `/v10/projects/${encodeURIComponent(io.target.projectId)}/env`,
              "POST",
              {
                comment: io.comment,
                gitBranch: io.target.branch,
                key,
                target: ["preview"],
                type: "encrypted",
                value,
              },
            );
          }
          rows = await io.inspect(false);
          const observed = rows.find((row) => row.key === key);
          if (!observed) {
            throw unavailable();
          }
          const plaintext = z
            .object({ value: z.string() })
            .parse(
              await io.request(
                `/v1/projects/${encodeURIComponent(io.target.projectId)}/env/${encodeURIComponent(observed.id)}`,
              ),
            );
          if (plaintext.value !== value) {
            throw unavailable();
          }
          await io.checkpoint(rows);
        }
        await io.inspect();
        return { rows: rows.map(io.reference) };
      } catch {
        throw unavailable();
      }
    },
    async reconcile(
      input: HostedOperatorManagedEnvironmentContext,
      values: ProtectedAppEnvironment,
    ): Promise<
      | { status: "absent" | "unknown" }
      | { status: "applied"; rows: ManagedOperatorEnvironmentRow[] }
    > {
      try {
        const io = open(input, values);
        const rows = await io.inspect();
        if (rows.length === 0) {
          return { status: "absent" };
        }
        await io.checkpoint(rows);
        return rows.length === Object.keys(io.expected).length
          ? { rows: rows.map(io.reference), status: "applied" }
          : { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
    },
    async remove(input: HostedOperatorManagedEnvironmentContext, values: ProtectedAppEnvironment) {
      try {
        if (input.plan.action !== "cleanup" || input.effect.kind !== "remove-bindings") {
          throw unavailable();
        }
        const io = open(input, values);
        let rows = await io.inspect(false);
        const known = input.managedEnvironment ?? [];
        if (rows.some((row) => !known.some((item) => item.id === row.id && item.key === row.key))) {
          throw unavailable();
        }
        for (const row of rows) {
          // Re-observe exact ownership/value before each deletion; never delete by key.
          const current = await io.inspect(false);
          if (!current.some((item) => item.id === row.id)) {
            continue;
          }
          await io.request(
            `/v9/projects/${encodeURIComponent(io.target.projectId)}/env/${encodeURIComponent(row.id)}`,
            "DELETE",
          );
          rows = await io.inspect(false);
          if (rows.some((item) => item.id === row.id)) {
            throw unavailable();
          }
          await io.checkpoint(rows);
        }
        const emptyRows: ManagedOperatorEnvironmentRow[] = [];
        return { rows: emptyRows };
      } catch {
        throw unavailable();
      }
    },
  };
};
