import { z } from "zod";
import {
  custodySecretKey,
  custodyVersionKey,
  custodySecretMetadataSchema,
  CustodyReconciliationRequiredError,
  CustodyUnavailableError,
} from "./vercel-token-key-custody";
import type { CustodyPlan, CustodySecretMetadata } from "./vercel-token-key-custody";

export interface CustodySecretPort {
  inspect: (owned?: CustodySecretMetadata) => Promise<CustodySecretMetadata | undefined>;
  create: (key: Buffer, assertCurrent: () => Promise<void>) => Promise<CustodySecretMetadata>;
  observeReceiver: (
    attemptedAt: string,
    savedDeploymentId?: string,
  ) => Promise<{ deploymentId: string; origin: string } | undefined>;
}
const providerRow = z.object({
  comment: z.string().optional(),
  gitBranch: z.string().nullable().optional(),
  id: z.string().min(1),
  key: z.string(),
  target: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return [];
      }
      return Array.isArray(value) ? value : [value];
    }),
  type: z.string(),
  value: z.unknown().optional(),
  visibility: z.enum(["secret", "config"]).optional(),
});
const listSchema = z.object({
  envs: z.array(
    z.looseObject({
      key: z.string(),
      target: z.union([z.string(), z.array(z.string())]).optional(),
    }),
  ),
});
const previewRelevant = (row: z.infer<typeof listSchema>["envs"][number]) =>
  row.target === undefined ||
  (Array.isArray(row.target) ? row.target.includes("preview") : row.target === "preview");
const isConfig = (row: z.infer<typeof providerRow>) =>
  row.visibility === "config" ||
  (row.visibility === undefined && ["plain", "encrypted"].includes(row.type));
const isSecret = (row: z.infer<typeof providerRow>) =>
  row.visibility === "secret" || (row.visibility === undefined && row.type === "sensitive");
const marker = (plan: CustodyPlan, planDigest: string, grantDigest: string) =>
  `autograph:key-custody:v1:${plan.operationRef}:${planDigest}:${grantDigest}`;
/** Bounded in-memory response; parser/provider failures never retain a body or exception. */
export const readCustodyJson = async (
  response: Response,
): Promise<z.infer<ReturnType<typeof z.json>>> => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new CustodyUnavailableError();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The bounded stream must be consumed sequentially.
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > 262_144) {
        throw new CustodyUnavailableError();
      }
      chunks.push(value);
    }
    return z.json().parse(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
  } catch {
    throw new CustodyUnavailableError();
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Discard transport state without retaining body errors. */
    }
    reader.releaseLock();
  }
};
/** This port exposes one fixed create-only sensitive row, never a general environment map. */
export const createCustodySecretPort = (input: {
  plan: CustodyPlan;
  planDigest: string;
  grantDigest: string;
  readInstallationToken: () => Promise<string>;
  recipientOrigin: string;
  fetch?: typeof fetch;
}): CustodySecretPort => {
  const { plan } = input;
  const fetcher = input.fetch ?? fetch;
  const request = async (path: string, init?: RequestInit, assertCurrent?: () => Promise<void>) => {
    const token = await input.readInstallationToken();
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", plan.destination.teamId);
    await assertCurrent?.();
    const response = await fetcher(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* Ignore transport disposal errors. */
      }
      throw new CustodyUnavailableError();
    }
    return await readCustodyJson(response);
  };
  const assertProject = async () => {
    const result = z
      .object({ accountId: z.string(), id: z.string() })
      .parse(await request(`/v9/projects/${encodeURIComponent(plan.destination.projectId)}`));
    if (result.id !== plan.destination.projectId || result.accountId !== plan.destination.teamId) {
      throw new CustodyUnavailableError();
    }
  };
  const safeRow = (row: z.infer<typeof providerRow>) => {
    if (!isSecret(row)) {
      throw new CustodyReconciliationRequiredError();
    }
    return custodySecretMetadataSchema.parse({
      gitBranch: row.gitBranch ?? null,
      id: row.id,
      key: row.key,
      projectId: plan.destination.projectId,
      target: row.target,
      teamId: plan.destination.teamId,
      type: "sensitive",
    });
  };
  const previewConfig = (row: z.infer<typeof providerRow>) =>
    [
      row.gitBranch === null || row.gitBranch === undefined,
      row.target.length === 1,
      row.target[0] === "preview",
      isConfig(row),
    ].every(Boolean);
  const inspect: CustodySecretPort["inspect"] = async (owned) => {
    try {
      await assertProject();
      const rows = listSchema.parse(
        await request(`/v10/projects/${encodeURIComponent(plan.destination.projectId)}/env`),
      ).envs;
      const versionRows = rows.filter(
        (row) => row.key === custodyVersionKey && previewRelevant(row),
      );
      if (versionRows.length !== 1) {
        throw new CustodyUnavailableError();
      }
      const version = providerRow.parse(versionRows[0]);
      if (!previewConfig(version)) {
        throw new CustodyUnavailableError();
      }
      let versionValue = version.value;
      if (version.type === "encrypted") {
        // Read only the already validated Config VERSION row. Never bulk decrypt environment values.
        const decrypted = providerRow.parse(
          await request(
            `/v1/projects/${encodeURIComponent(plan.destination.projectId)}/env/${encodeURIComponent(version.id)}`,
          ),
        );
        if (
          decrypted.id !== version.id ||
          decrypted.key !== custodyVersionKey ||
          !previewConfig(decrypted)
        ) {
          throw new CustodyUnavailableError();
        }
        versionValue = decrypted.value;
      }
      if (versionValue !== "v1") {
        throw new CustodyUnavailableError();
      }
      const keys = rows.filter((row) => row.key === custodySecretKey && previewRelevant(row));
      if (keys.length === 0) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicit absence shares the metadata-returning function contract.
        return undefined;
      }
      if (keys.length !== 1) {
        throw new CustodyReconciliationRequiredError();
      }
      const row = providerRow.parse(keys[0]);
      if (
        row.comment !== marker(plan, input.planDigest, input.grantDigest) ||
        (owned !== undefined && row.id !== owned.id)
      ) {
        throw new CustodyReconciliationRequiredError();
      }
      return safeRow(row);
    } catch (error) {
      if (error instanceof CustodyReconciliationRequiredError) {
        throw error;
      }
      throw new CustodyUnavailableError();
    }
  };
  return {
    async create(key, assertCurrent) {
      try {
        if (key.length !== 32) {
          throw new CustodyUnavailableError();
        }
        await assertCurrent();
        // upsert=false preserves create-only semantics, including a late competing create.
        const result = z
          .object({
            created: z.union([providerRow, z.array(providerRow)]),
            failed: z.array(z.unknown()).optional(),
          })
          .parse(
            await request(
              `/v10/projects/${encodeURIComponent(plan.destination.projectId)}/env?upsert=false`,
              {
                body: JSON.stringify({
                  comment: marker(plan, input.planDigest, input.grantDigest),
                  gitBranch: null,
                  key: custodySecretKey,
                  target: ["preview"],
                  type: "sensitive",
                  value: key.toString("base64"),
                }),
                method: "POST",
              },
              assertCurrent,
            ),
          );
        if ((result.failed?.length ?? 0) > 0) {
          throw new CustodyReconciliationRequiredError();
        }
        const rows = Array.isArray(result.created) ? result.created : [result.created];
        if (
          rows.length !== 1 ||
          rows[0].comment !== marker(plan, input.planDigest, input.grantDigest)
        ) {
          throw new CustodyReconciliationRequiredError();
        }
        return safeRow(rows[0]);
      } catch {
        throw new CustodyReconciliationRequiredError();
      }
    },
    inspect,
    async observeReceiver(attemptedAt, savedDeploymentId) {
      try {
        let selected = savedDeploymentId;
        if (selected === undefined) {
          const { hostname } = new URL(input.recipientOrigin);
          const alias = z
            .object({
              alias: z.string(),
              deploymentId: z.string(),
              projectId: z.string(),
              redirect: z.string().nullable().optional(),
            })
            .parse(await request(`/v4/aliases/${encodeURIComponent(hostname)}`));
          if (
            [
              alias.alias !== hostname,
              alias.projectId !== plan.destination.projectId,
              Boolean(alias.redirect),
            ].some(Boolean)
          ) {
            throw new CustodyUnavailableError();
          }
          selected = alias.deploymentId;
        }
        const row = z
          .object({
            createdAt: z.number(),
            id: z.string(),
            ownerId: z.string(),
            projectId: z.string(),
            readyState: z.string(),
            target: z.null(),
            url: z.string(),
          })
          .parse(await request(`/v13/deployments/${encodeURIComponent(selected)}`));
        // oxlint-disable-next-line sonarjs/expression-complexity -- Provider readback must bind each selected deployment identity.
        if (
          [
            row.projectId !== plan.destination.projectId,
            row.ownerId !== plan.destination.teamId,
            row.target !== null,
            row.readyState !== "READY",
            savedDeploymentId !== undefined && row.id !== savedDeploymentId,
          ].some(Boolean)
        ) {
          throw new CustodyUnavailableError();
        }
        if (row.createdAt <= Date.parse(attemptedAt)) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- The approved refreshed deployment has not been observed yet.
          return undefined;
        }
        const { origin } = new URL(`https://${row.url}`);
        if (`https://${row.url}` !== origin) {
          throw new CustodyUnavailableError();
        }
        return { deploymentId: row.id, origin };
      } catch {
        throw new CustodyUnavailableError();
      }
    },
  };
};
