import { isDeepStrictEqual } from "node:util";
import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import postgres from "postgres";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The existing Drizzle database contract requires the full schema namespace.
import * as databaseSchema from "../db/schema";
import {
  hostedRuntimePostgresOptions,
  parseHostedDatabaseUrl,
} from "../db/postgres-connection-policy";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { readVercelTokenKeyringEnvironment } from "../integrations/vercel-installation";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import { createHostedOperatorConsentOwner } from "./hosted-operator-consent-owner";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import {
  custodyPlanDigest,
  custodyGrantDigest,
  custodyActorDigest,
  custodyRecordSchema,
  assertCustodyGrant,
  createCustodySourceOperation,
  createCustodyPossessionProof,
  CustodyUnavailableError,
  CustodyReconciliationRequiredError,
} from "./vercel-token-key-custody";
import type { CustodyJournalStore } from "./vercel-token-key-custody";
import { createCustodySecretPort, readCustodyJson } from "./vercel-token-key-custody-secret";

const origin = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.pathname === "/" &&
    ![url.username, url.password, url.search, url.hash].some(Boolean)
  );
});
const workload = z.strictObject({
  audience: z.url().startsWith("https://vercel.com/"),
  environment: z.enum(["production", "preview"]),
  issuer: z.string().regex(/^https:\/\/oidc\.vercel\.com(?:\/[A-Za-z0-9_-]+)?$/u),
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
  subject: z.string().min(1),
});
export const custodySetupConfigurationSchema = z
  .strictObject({
    capturedOwner: operatorOwnerContextSchema,
    grantRef: z.string().min(1),
    operationRef: z.uuid(),
    recipient: z.strictObject({ origin, workload }),
    source: z.strictObject({ origin, workload }),
    version: z.literal(1),
  })
  .superRefine((config, context) => {
    // oxlint-disable-next-line sonarjs/expression-complexity -- Stable custody setup pins all workload boundaries.
    if (
      [
        config.source.workload.environment !== "production",
        config.recipient.workload.environment !== "preview",
        config.source.workload.ownerId !== config.recipient.workload.ownerId,
        config.source.workload.projectId === config.recipient.workload.projectId,
        config.source.origin === config.recipient.origin,
      ].some(Boolean)
    ) {
      context.addIssue({ code: "custom", message: "Custody setup identity mismatch." });
    }
  });
export type CustodySetupConfiguration = z.infer<typeof custodySetupConfigurationSchema>;
export const readCustodySetupConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  try {
    return custodySetupConfigurationSchema.parse(
      JSON.parse(environment.PROTECTED_VERCEL_TOKEN_KEY_CUSTODY_CONFIGURATION ?? ""),
    );
  } catch {
    throw new CustodyUnavailableError();
  }
};
export const readCustodyActiveKey = (environment: Readonly<Record<string, string | undefined>>) => {
  try {
    // Explicit projection prevents reading or propagating any previous keyring.
    const ring = readVercelTokenKeyringEnvironment({
      VERCEL_INTEGRATION_TOKEN_KEY: environment.VERCEL_INTEGRATION_TOKEN_KEY,
      VERCEL_INTEGRATION_TOKEN_KEY_VERSION: environment.VERCEL_INTEGRATION_TOKEN_KEY_VERSION,
    });
    if (ring.tokenKeyVersion !== "v1") {
      throw new CustodyUnavailableError();
    }
    return ring.tokenKey;
  } catch {
    throw new CustodyUnavailableError();
  }
};
export const custodyPossessionPath = "/v1/key-custody/possession";
const selectorSchema = z.strictObject({ operationRef: z.uuid() });
const parseSelector = async (request: Request) => {
  if (
    request.method !== "POST" ||
    request.headers.get("content-type")?.startsWith("application/json") !== true
  ) {
    throw new CustodyUnavailableError();
  }
  return selectorSchema.parse(await readCustodyJson(new Response(request.body)));
};
const assertLocalDeployment = async (
  environment: Readonly<Record<string, string | undefined>>,
  config: CustodySetupConfiguration,
  side: "source" | "recipient",
  deploymentId: string,
) => {
  const policy = config[side].workload;
  // oxlint-disable-next-line sonarjs/expression-complexity -- The current process must match the exact trusted deployment workload.
  if (
    [
      environment.VERCEL_DEPLOYMENT_ID !== deploymentId,
      environment.VERCEL_PROJECT_ID !== policy.projectId,
      environment.VERCEL_ORG_ID !== policy.ownerId,
      (environment.VERCEL_TARGET_ENV ?? environment.VERCEL_ENV) !== policy.environment,
    ].some(Boolean)
  ) {
    throw new CustodyUnavailableError();
  }
  const token = await getVercelOidcToken();
  await verifyVercelOidcToken(token, {
    environment: policy.environment,
    ownerId: policy.ownerId,
    projectId: policy.projectId,
  });
  await createOperatorWorkloadVerifier(policy)(
    new Request(config[side].origin, { headers: { authorization: `Bearer ${token}` } }),
  );
};
interface CustodyCompositionDependencies {
  readSetup?: () => Promise<CustodySetupConfiguration>;
  store?: CustodyJournalStore;
  assertLocal?: typeof assertLocalDeployment;
  verifyCaller?: (request: Request, config: CustodySetupConfiguration) => Promise<void>;
  currentOwner?: (config: CustodySetupConfiguration) => Promise<void>;
}
/** Narrow setup requires no runtime apps, Realm callback, OAuth signing secret or full operator configuration. */
const openComposition = async (
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: CustodyCompositionDependencies,
) => {
  const readSetup =
    dependencies.readSetup ??
    (async () => {
      await Promise.resolve();
      return readCustodySetupConfiguration(environment);
    });
  const config = custodySetupConfigurationSchema.parse(await readSetup());
  const databaseUrl = parseHostedDatabaseUrl(environment.DATABASE_URL);
  const client = postgres(databaseUrl, hostedRuntimePostgresOptions);
  const database = drizzle(client, { schema: databaseSchema });
  const { createPostgresVercelTokenKeyCustodyStore } =
    await import("./postgres-vercel-token-key-custody");
  const store = dependencies.store ?? createPostgresVercelTokenKeyCustodyStore(database);
  const owner = createHostedOperatorConsentOwner(config.source.workload, environment);
  const currentSetup = async () => {
    const current = custodySetupConfigurationSchema.parse(await readSetup());
    if (!isDeepStrictEqual(current, config)) {
      throw new CustodyUnavailableError();
    }
    const row = await store.read({
      authority: current.capturedOwner.authority,
      operationRef: current.operationRef,
    });
    if (!row) {
      throw new CustodyUnavailableError();
    }
    const record = custodyRecordSchema.parse(row.record);
    const { plan } = record;
    const { setupGrant: grant } = record;
    // oxlint-disable-next-line sonarjs/expression-complexity -- The saved administrator grant must bind all stable setup identities.
    if (
      [
        record.grantRevokedAt !== undefined,
        grant.grantRef !== current.grantRef,
        plan.operationRef !== current.operationRef,
        plan.ownerSessionId !== current.capturedOwner.sessionId,
        custodyActorDigest(current.capturedOwner.authority) !== plan.actorAuthorityDigest,
        current.source.workload.projectId !== plan.source.projectId,
        current.source.workload.ownerId !== plan.source.teamId,
        current.recipient.workload.projectId !== plan.destination.projectId,
        current.recipient.workload.ownerId !== plan.destination.teamId,
      ].some(Boolean)
    ) {
      throw new CustodyUnavailableError();
    }
    assertCustodyGrant(plan, grant, current.capturedOwner.authority, Date.now());
    // oxlint-disable-next-line unicorn/prefer-ternary -- The real owner recheck and test port have different input contracts.
    if (dependencies.currentOwner === undefined) {
      await owner.assertCurrent({
        authority: current.capturedOwner.authority,
        ownerContext: current.capturedOwner,
      });
    } else {
      await dependencies.currentOwner(current);
    }
    return { actor: current.capturedOwner.authority, grant, plan };
  };
  return {
    close: async () => {
      await client.end({ timeout: 0 });
    },
    config,
    currentSetup,
    database,
    databaseUrl,
    store,
  };
};
type CustodyPrivateResponse =
  | Awaited<ReturnType<ReturnType<typeof createCustodySourceOperation>>>
  | { error: string }
  | { operationRef: string; proof: string };
const privateResponse = (value: CustodyPrivateResponse, status = 200) =>
  Response.json(value, { headers: { "cache-control": "no-store" }, status });
const failedResponse = (reconciliationRequired: boolean) =>
  privateResponse(
    {
      error: reconciliationRequired ? "reconciliation_required" : "key_custody_unavailable",
    },
    reconciliationRequired ? 409 : 503,
  );
export const createCustodySourceHandler =
  (
    environment: Readonly<Record<string, string | undefined>> = process.env,
    dependencies: CustodyCompositionDependencies = {},
  ) =>
  // oxlint-disable-next-line eslint/complexity -- The private boundary validates and rechecks each saved possession prerequisite before key use.
  async (request: Request) => {
    let close: (() => Promise<void>) | undefined;
    try {
      const config = custodySetupConfigurationSchema.parse(
        await (dependencies.readSetup?.() ??
          Promise.resolve(readCustodySetupConfiguration(environment))),
      );
      // oxlint-disable-next-line unicorn/prefer-ternary -- The configured verifier and test port accept different signatures.
      if (dependencies.verifyCaller === undefined) {
        await createOperatorWorkloadVerifier(config.source.workload)(request);
      } else {
        await dependencies.verifyCaller(request, config);
      }
      const { operationRef } = await parseSelector(request);
      if (operationRef !== config.operationRef) {
        throw new CustodyUnavailableError();
      }
      const composition = await openComposition(environment, dependencies);
      ({ close } = composition);
      const { plan, grant } = await composition.currentSetup();
      const assertSourceCurrent = async () => {
        await (dependencies.assertLocal ?? assertLocalDeployment)(
          environment,
          config,
          "source",
          plan.source.deploymentId,
        );
        return await composition.currentSetup();
      };
      await assertSourceCurrent();
      const readInstallationToken = async () => {
        await assertSourceCurrent();
        const key = readCustodyActiveKey(environment);
        try {
          const credential = await readActiveVercelInstallationToken({
            authority: config.capturedOwner.authority,
            config: { tokenKey: key, tokenKeyVersion: "v1" },
            database: composition.database,
            installationId: plan.installationId,
          });
          if (credential === undefined) {
            throw new CustodyUnavailableError();
          }
          if (
            [
              !credential.binding.active,
              credential.binding.installationId !== plan.installationId,
              credential.binding.scopeType !== "team",
              credential.binding.scopeId !== plan.destination.teamId,
            ].some(Boolean)
          ) {
            throw new CustodyUnavailableError();
          }
          return credential.token;
        } finally {
          key.fill(0);
        }
      };
      const { createPostgresPhysicalResourceLease } =
        await import("./postgres-physical-resource-lease");
      const physicalLease = createPostgresPhysicalResourceLease({
        openLockClient: (onclose) =>
          postgres(composition.databaseUrl, { ...hostedRuntimePostgresOptions, max: 1, onclose }),
      });
      const operation = createCustodySourceOperation({
        currentSetup: assertSourceCurrent,
        physicalLease,
        readActiveKey: async () => {
          await Promise.resolve();
          return readCustodyActiveKey(environment);
        },
        requestPossession: async (savedOperationRef, recipientOrigin) => {
          await composition.currentSetup();
          await (dependencies.assertLocal ?? assertLocalDeployment)(
            environment,
            config,
            "source",
            plan.source.deploymentId,
          );
          const token = await getVercelOidcToken();
          const response = await fetch(new URL(custodyPossessionPath, recipientOrigin), {
            body: JSON.stringify({ operationRef: savedOperationRef }),
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-vercel-trusted-oidc-idp-token": token,
            },
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) {
            try {
              await response.body?.cancel();
            } catch {
              /* Discard transport errors without retaining response bodies. */
            }
            throw new CustodyUnavailableError();
          }
          return z
            .strictObject({
              operationRef: z.literal(savedOperationRef),
              proof: z.string().regex(/^[a-f0-9]{64}$/u),
            })
            .parse(await readCustodyJson(response)).proof;
        },
        secret: createCustodySecretPort({
          grantDigest: custodyGrantDigest(grant),
          plan,
          planDigest: custodyPlanDigest(plan),
          readInstallationToken,
          recipientOrigin: config.recipient.origin,
        }),
        store: composition.store,
      });
      return privateResponse(await operation(operationRef));
    } catch (error) {
      return failedResponse(error instanceof CustodyReconciliationRequiredError);
    } finally {
      await close?.();
    }
  };
export const createCustodyPossessionHandler =
  (
    environment: Readonly<Record<string, string | undefined>> = process.env,
    dependencies: CustodyCompositionDependencies = {},
  ) =>
  // oxlint-disable-next-line eslint/complexity -- The private boundary validates and rechecks each saved possession prerequisite before key use.
  async (request: Request) => {
    let close: (() => Promise<void>) | undefined;
    try {
      const config = custodySetupConfigurationSchema.parse(
        await (dependencies.readSetup?.() ??
          Promise.resolve(readCustodySetupConfiguration(environment))),
      );
      // oxlint-disable-next-line unicorn/prefer-ternary -- The configured verifier and test port accept different signatures.
      if (dependencies.verifyCaller === undefined) {
        await createOperatorWorkloadVerifier(config.source.workload)(request);
      } else {
        await dependencies.verifyCaller(request, config);
      }
      const { operationRef } = await parseSelector(request);
      if (operationRef !== config.operationRef) {
        throw new CustodyUnavailableError();
      }
      const composition = await openComposition(environment, dependencies);
      ({ close } = composition);
      const { plan, grant } = await composition.currentSetup();
      const before = await composition.store.read({
        authority: config.capturedOwner.authority,
        operationRef,
      });
      if (!before) {
        throw new CustodyUnavailableError();
      }
      const record = custodyRecordSchema.parse(before.record);
      // oxlint-disable-next-line sonarjs/expression-complexity -- Possession requires the exact pending, unexpired, unconsumed saved checkpoint.
      if (
        [
          record.grantRevokedAt !== undefined,
          record.phase !== "possession-pending",
          record.nonceConsumedAt !== undefined,
          record.planDigest !== custodyPlanDigest(plan),
          record.grantDigest !== custodyGrantDigest(grant),
          record.grantRef !== grant.grantRef,
          record.approvalRef !== grant.approvalRef,
          record.leaseExpiresAt === undefined,
          Date.parse(z.iso.datetime({ offset: true }).parse(record.leaseExpiresAt)) <= Date.now(),
          record.nonceExpiresAt === undefined,
          Date.parse(z.iso.datetime({ offset: true }).parse(record.nonceExpiresAt)) <= Date.now(),
        ].some(Boolean)
      ) {
        throw new CustodyUnavailableError();
      }
      await (dependencies.assertLocal ?? assertLocalDeployment)(
        environment,
        config,
        "recipient",
        z.string().min(1).parse(record.receivingDeploymentId),
      );
      const key = readCustodyActiveKey(environment);
      let proof: string;
      try {
        proof = createCustodyPossessionProof(record, key);
      } finally {
        key.fill(0);
      }
      await composition.currentSetup();
      const after = await composition.store.read({
        authority: config.capturedOwner.authority,
        operationRef,
      });
      if (
        [
          after?.revision !== before.revision,
          !isDeepStrictEqual(after?.record, record),
          Date.parse(z.iso.datetime({ offset: true }).parse(record.nonceExpiresAt)) <= Date.now(),
          Date.parse(z.iso.datetime({ offset: true }).parse(record.leaseExpiresAt)) <= Date.now(),
        ].some(Boolean)
      ) {
        throw new CustodyUnavailableError();
      }
      return privateResponse({ operationRef, proof });
    } catch (error) {
      return failedResponse(error instanceof CustodyReconciliationRequiredError);
    } finally {
      await close?.();
    }
  };
