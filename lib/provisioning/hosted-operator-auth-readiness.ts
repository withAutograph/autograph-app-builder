import { createHash } from "node:crypto";
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
}) => ({
  async verify(input: Input) {
    try {
      await input.assertCurrent?.();
      await deps.assertAuthorized(input);
      const approved = input.plan.authSchema;
      if (approved === undefined) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const approvedBytes = await deps.readAuthPlan(input);
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
        observed.readiness.targetDigest === approved.targetDigest,
        observed.readiness.assetSha256 === asset.sha256,
        observed.readiness.publishedFingerprint === observed.readiness.observedFingerprint,
      ].every(Boolean);
      if (!matches) {
        throw new HostedOperatorError("resource_mismatch");
      }
      await input.assertCurrent?.();
      await deps.assertAuthorized(input);
      return {
        assetSha256: asset.sha256,
        catalogFingerprint: observed.readiness.observedFingerprint,
        database: resource.database,
        observedAt: new Date().toISOString(),
        runtimeRole: resource.runtimeRole,
        targetDigest: approved.targetDigest,
      };
    } catch {
      throw new HostedOperatorError("operator_unavailable");
    }
  },
});
