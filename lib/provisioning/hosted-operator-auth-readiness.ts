import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import postgres from "postgres";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const targetSchema = z.object({
  schemaPlan: z.object({
    effects: z.array(z.object({ owner: z.string(), sha256: digest, sql: z.string() })),
    planDigest: digest,
    targetDigest: digest,
  }),
});
const migrationSchema = z.object({
  version: z.literal(1),
  resource: z.json(),
  proposal: z.literal("new-empty").optional(),
  schemaPlan: z.looseObject({
    ...targetSchema.shape.schemaPlan.shape,
    effects: z.array(z.looseObject({ owner: z.string(), sha256: digest, sql: z.string() })),
    beforeSchemaHash: digest,
  }),
});
const snapshotSchema = z.object({
  database: z.string(),
  login: z.string(),
  readiness: z.object({
    algorithm: z.literal("pg-jsonb-catalog-sha256-v1"),
    assetSha256: digest,
    database: z.string(),
    observedFingerprint: digest,
    publishedFingerprint: digest,
    status: z.literal("verified"),
    targetDigest: digest,
    version: z.literal(1),
  }),
  role: z.string(),
});
type Input = HostedOperatorContext & {
  plan: HostedOperatorPlan;
  assertCurrent?: () => Promise<void>;
};
const readSnapshot = async (url: string) => {
  const sql = postgres(url, {
    connect_timeout: 15,
    max: 1,
    onnotice: () => {
      /* Private database notices are never forwarded. */
    },
    ssl: "verify-full",
  });
  try {
    return await sql.begin("read only", async (transaction) => {
      const rows =
        await transaction`select current_database() as database,current_user as role,session_user as login,_auth_schema_readiness.read_current() as readiness`;
      return rows.at(0);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
};

/** Fixed runtime catalog publication read. It proves schema/ACL metadata, never human login or app access. */
export const createHostedOperatorAuthReadiness = (deps: {
  assertAuthorized: (input: Input) => Promise<void>;
  readRuntimeUrl: (input: Input) => Promise<string>;
  readAuthPlan: (input: Input) => Promise<Buffer>;
  readSnapshot?: typeof readSnapshot;
}) => {
  const verify = async (supplied: Input, matchApprovedTarget: boolean) => {
    try {
      const input = {
        ...supplied,
        authority: structuredClone(supplied.authority),
        ownerContext: structuredClone(supplied.ownerContext),
        plan: structuredClone(supplied.plan),
        target: structuredClone(supplied.target),
      };
      await input.assertCurrent?.();
      await deps.assertAuthorized(input);
      const approved = input.plan.authSchema;
      if (approved === undefined) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const approvedBytes = Buffer.from(await deps.readAuthPlan(input));
      await input.assertCurrent?.();
      await deps.assertAuthorized(input);
      const frame = targetSchema.parse(JSON.parse(approvedBytes.toString("utf-8")));
      const effects = frame.schemaPlan.effects.filter((effect) => effect.owner === "readiness");
      const asset = effects.at(0);
      if (effects.length !== 1 || asset === undefined) {
        throw new HostedOperatorError("resource_mismatch");
      }
      if (
        frame.schemaPlan.planDigest !== approved.planDigest ||
        frame.schemaPlan.targetDigest !== approved.targetDigest ||
        createHash("sha256").update(asset.sql).digest("hex") !== asset.sha256
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const url = await deps.readRuntimeUrl(input);
      await input.assertCurrent?.();
      await deps.assertAuthorized(input);
      const parsed = new URL(url);
      const resource = input.plan.authDatabase;
      const exactRuntime = [
        ["postgres:", "postgresql:"].includes(parsed.protocol),
        parsed.hostname === input.plan.neon.endpoint,
        decodeURIComponent(parsed.pathname.slice(1)) === resource.database,
        decodeURIComponent(parsed.username) === resource.runtimeRole,
        parsed.password !== "",
        parsed.hash === "",
        ["", "5432"].includes(parsed.port),
        parsed.searchParams.getAll("sslmode").length === 1,
        parsed.searchParams.get("sslmode") === "verify-full",
        [...parsed.searchParams.keys()].every((key) =>
          ["sslmode", "channel_binding"].includes(key),
        ),
        parsed.searchParams.getAll("channel_binding").length <= 1,
        !parsed.searchParams.has("channel_binding") ||
          parsed.searchParams.get("channel_binding") === "require",
      ].every(Boolean);
      if (!exactRuntime) {
        throw new HostedOperatorError("resource_mismatch");
      }
      await input.assertCurrent?.();
      await deps.assertAuthorized(input);
      const observed = snapshotSchema.parse(await (deps.readSnapshot ?? readSnapshot)(url));
      const matches = [
        observed.database === resource.database,
        observed.role === resource.runtimeRole,
        observed.login === resource.runtimeRole,
        observed.readiness.database === resource.database,
        !matchApprovedTarget || observed.readiness.targetDigest === approved.targetDigest,
        !matchApprovedTarget || observed.readiness.assetSha256 === asset.sha256,
        observed.readiness.publishedFingerprint === observed.readiness.observedFingerprint,
      ].every(Boolean);
      if (!matches) {
        throw new HostedOperatorError("resource_mismatch");
      }
      await input.assertCurrent?.();
      await deps.assertAuthorized(input);
      return {
        assetSha256: observed.readiness.assetSha256,
        catalogFingerprint: observed.readiness.observedFingerprint,
        database: resource.database,
        observedAt: new Date().toISOString(),
        runtimeRole: resource.runtimeRole,
        targetDigest: observed.readiness.targetDigest,
      };
    } catch {
      throw new HostedOperatorError("operator_unavailable");
    }
  };
  return {
    verify: async (input: Input) => await verify(input, true),
    /** Actual current publication; this never claims the newly approved target is installed. */
    verifyPublication: async (input: Input) => await verify(input, false),
    async reconcileMigration(supplied: Input, repropose: (input: Input) => Promise<Buffer>) {
      const input = {
        ...supplied,
        authority: structuredClone(supplied.authority),
        ownerContext: structuredClone(supplied.ownerContext),
        plan: structuredClone(supplied.plan),
        target: structuredClone(supplied.target),
      };
      try {
        const observed = await verify(input, true);
        return { status: "applied" as const, observed };
      } catch {
        if (input.plan.authAdoption !== undefined) {
          return { status: "unknown" as const };
        }
      }
      try {
        const prior = await verify(input, false);
        const approved = input.plan.authSchema;
        if (approved === undefined || prior.targetDigest === approved.targetDigest) {
          return { status: "unknown" as const };
        }
        const frozenBytes = await deps.readAuthPlan(input);
        const frozen = migrationSchema.parse(JSON.parse(frozenBytes.toString("utf-8")));
        const resource = {
          version: 1,
          environment: "preview",
          hostname: input.plan.neon.endpoint,
          port: 5432,
          database: input.plan.authDatabase.database,
          schema: "public",
          runtimeRole: input.plan.authDatabase.runtimeRole,
          migratorRole: input.plan.authDatabase.migratorRole,
          neon: { branchId: input.plan.neon.branchId, projectId: input.plan.neon.projectId },
        };
        if (
          frozen.proposal !== undefined ||
          !isDeepStrictEqual(frozen.resource, resource) ||
          frozen.schemaPlan.planDigest !== approved.planDigest ||
          frozen.schemaPlan.targetDigest !== approved.targetDigest
        ) {
          return { status: "unknown" as const };
        }
        await input.assertCurrent?.();
        await deps.assertAuthorized(input);
        const proposedBytes = await repropose(input);
        const proposed = migrationSchema.parse(JSON.parse(proposedBytes.toString("utf-8")));
        if (
          proposed.proposal !== undefined ||
          !isDeepStrictEqual(proposed.resource, frozen.resource) ||
          !isDeepStrictEqual(proposed.schemaPlan, frozen.schemaPlan)
        ) {
          return { status: "unknown" as const };
        }
        const after = await verify(input, false);
        const samePublication = [
          "assetSha256",
          "catalogFingerprint",
          "database",
          "runtimeRole",
          "targetDigest",
        ] as const;
        if (!samePublication.every((field) => prior[field] === after[field])) {
          return { status: "unknown" as const };
        }
        return {
          status: "retryable" as const,
          resourceVersion: createHash("sha256")
            .update(
              JSON.stringify({
                planDigest: approved.planDigest,
                publication: samePublication.map((field) => after[field]),
              }),
            )
            .digest("hex"),
        };
      } catch {
        return { status: "unknown" as const };
      }
    },
  };
};
