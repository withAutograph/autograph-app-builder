import { isDeepStrictEqual } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Existing Drizzle stores require the full typed schema namespace.
import * as databaseSchema from "../db/schema";
import {
  parseHostedDatabaseUrl,
  hostedRuntimePostgresOptions,
} from "../db/postgres-connection-policy";
import {
  getPreviewOAuthDeploymentAuth,
  getPreviewOAuthDeploymentOrigin,
} from "../auth/preview-oauth-deployment";
import { createHostedOperatorConsentOwner } from "./hosted-operator-consent-owner";
import { createPostgresVercelTokenKeyCustodyStore } from "./postgres-vercel-token-key-custody";
import {
  assertCustodyGrant,
  custodyActorDigest,
  custodyRecordSchema,
  custodyReceiptSchema,
  CustodyUnavailableError,
} from "./vercel-token-key-custody";
import type { CustodyJournalStore, CustodyRecord } from "./vercel-token-key-custody";
import {
  createCustodySourceHandler,
  readCustodySetupConfiguration,
  custodySetupConfigurationSchema,
} from "./vercel-token-key-custody-deployment";
import type { CustodySetupConfiguration } from "./vercel-token-key-custody-deployment";
import { readCustodyJson } from "./vercel-token-key-custody-secret";

export const custodyOwnerInvocationPath = "/api/hosted-operator/key-custody/invoke";
const browserActorSchema = z.strictObject({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
});
export type CustodyBrowserActor = z.infer<typeof browserActorSchema>;
interface CustodyOwnerInvocationDependencies {
  readSetup?: () => Promise<CustodySetupConfiguration>;
  readBrowserActor?: (
    request: Request,
    config: CustodySetupConfiguration,
  ) => Promise<CustodyBrowserActor | undefined>;
  assertOriginalOwner?: (config: CustodySetupConfiguration) => Promise<void>;
  store?: Pick<CustodyJournalStore, "read">;
  createSourceHandler?: typeof createCustodySourceHandler;
  now?: () => number;
}
const noStore = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const html = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const page = (content: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Key custody</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#202020;max-width:840px;margin:48px auto;padding:0 24px}h1{font-size:28px;line-height:1.25}dl{display:grid;grid-template-columns:180px 1fr;gap:12px 24px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}button{font:inherit;padding:10px 18px;cursor:pointer}p{max-width:720px}code{overflow-wrap:anywhere}form{margin-top:28px}</style></head><body><main>${content}</main></body></html>`,
    { headers: noStore, status },
  );
const unavailable = () =>
  page(
    "<h1>Key custody unavailable</h1><p>The saved operation requires a current administrator grant and the original signed-in owner.</p>",
    503,
  );

const readOriginalBrowserActor = async (
  request: Request,
  config: CustodySetupConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const expectedOrigin = new URL(config.capturedOwner.authority.issuer).origin;
  if (
    getPreviewOAuthDeploymentOrigin({ ...environment }) !== expectedOrigin ||
    expectedOrigin !== new URL(config.source.origin).origin
  ) {
    throw new CustodyUnavailableError();
  }
  const auth = getPreviewOAuthDeploymentAuth({ ...environment });
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (session === null) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicit absence shares the authenticated actor return contract.
    return undefined;
  }
  return browserActorSchema.parse({ sessionId: session.session.id, userId: session.user.id });
};
const openReviewStore = (environment: Readonly<Record<string, string | undefined>>) => {
  const client = postgres(
    parseHostedDatabaseUrl(environment.DATABASE_URL),
    hostedRuntimePostgresOptions,
  );
  return {
    close: async () => {
      await client.end({ timeout: 0 });
    },
    store: createPostgresVercelTokenKeyCustodyStore(drizzle(client, { schema: databaseSchema })),
  };
};
/** Native browser forms contain exactly one saved selector. No caller approval, nonce or provider input is accepted. */
const readFormSelector = async (request: Request) => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
    throw new CustodyUnavailableError();
  }
  const reader = request.body?.getReader();
  if (reader === undefined) {
    throw new CustodyUnavailableError();
  }
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The bounded form stream is consumed in order.
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > 4096) {
        throw new CustodyUnavailableError();
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Discard transport errors without reflecting input. */
    }
    reader.releaseLock();
  }
  const entries = [...new URLSearchParams(Buffer.concat(chunks).toString("utf-8")).entries()];
  if (entries.length !== 1 || entries[0][0] !== "operationRef") {
    throw new CustodyUnavailableError();
  }
  return z.uuid().parse(entries[0][1]);
};
const reviewRows = (record: CustodyRecord) => {
  const { plan } = record;
  const entries = [
    ["Operation", plan.operationRef],
    ["Approval", record.approvalRef],
    ["Grant", record.grantRef],
    ["Source", `${plan.source.teamId} / ${plan.source.projectId} / Production`],
    ["Source deployment", plan.source.deploymentId],
    [
      "Destination",
      `${plan.destination.teamId} / ${plan.destination.projectId} / Preview / all branches`,
    ],
    [
      "Secret",
      `${plan.destination.key} · active ${plan.destination.requiredVersion} · create-only`,
    ],
    ["Version Config", `${plan.destination.versionKey}=v1 · validate only`],
    ["Current phase", record.phase],
    ["Approval expires", record.setupGrant.expiresAt],
    ["Plan digest", record.planDigest],
    ["Grant digest", record.grantDigest],
  ];
  const rows = entries
    .map(([label, value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`)
    .join("");
  return `<dl>${rows}</dl>`;
};
const renderReview = (record: CustodyRecord, now: number) => {
  const verified = record.phase === "possession-verified";
  const leased = record.leaseExpiresAt !== undefined && Date.parse(record.leaseExpiresAt) > now;
  const explanations = {
    attempted: "Continue to reconcile the saved Secret write attempt.",
    "possession-pending":
      "Continue the saved operation to check the approved receiving deployment and verify key possession.",
    "possession-verified":
      "The saved receipt confirms key possession by the exact receiving deployment.",
    reserved:
      "This administrator-approved operation creates the missing active v1 key Secret in the fixed Operator Preview slot.",
    "secret-confirmed":
      "Continue the saved operation to check the approved receiving deployment and verify key possession.",
  };
  const explanation = explanations[record.phase];
  let form = "";
  if (!verified) {
    form = leased
      ? `<p>The operation is in progress. Reload after ${html(record.leaseExpiresAt ?? "")} to continue.</p>`
      : `<form method="post" action="${custodyOwnerInvocationPath}"><input type="hidden" name="operationRef" value="${html(record.plan.operationRef)}"><button type="submit">Continue approved key custody</button></form>`;
  }
  const receipt =
    record.receipt === undefined
      ? ""
      : `<p>Possession verified for deployment <code>${html(record.receipt.receivingDeploymentId)}</code> at ${html(record.receipt.verifiedAt)}.</p>`;
  return page(
    `<h1>Review approved key custody</h1><p>${explanation}</p>${reviewRows(record)}${receipt}${form}`,
  );
};

const readCustodyOwnerReview = async (
  store: Pick<CustodyJournalStore, "read">,
  config: CustodySetupConfiguration,
  now: number,
) => {
  const row = await store.read({
    authority: config.capturedOwner.authority,
    operationRef: config.operationRef,
  });
  if (row === undefined) {
    throw new CustodyUnavailableError();
  }
  const record = custodyRecordSchema.parse(row.record);
  const { plan } = record;
  const validRecord = [
    record.grantRevokedAt === undefined,
    record.grantRef === config.grantRef,
    plan.operationRef === config.operationRef,
    plan.ownerSessionId === config.capturedOwner.sessionId,
    custodyActorDigest(config.capturedOwner.authority) === plan.actorAuthorityDigest,
    plan.source.teamId === config.source.workload.ownerId,
    plan.source.projectId === config.source.workload.projectId,
    plan.destination.teamId === config.recipient.workload.ownerId,
    plan.destination.projectId === config.recipient.workload.projectId,
  ].every(Boolean);
  if (!validRecord) {
    throw new CustodyUnavailableError();
  }
  assertCustodyGrant(plan, record.setupGrant, config.capturedOwner.authority, now);
  return record;
};
const renderSourceResult = async (response: Response, operationRef: string) => {
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* Transport disposal cannot expose response bodies. */
    }
    return page(
      `<h1>Key custody needs review</h1><p>The saved operation could not complete. <a href="${custodyOwnerInvocationPath}">Reload its current state</a> before continuing.</p>`,
      response.status === 409 ? 409 : 503,
    );
  }
  const result = z
    .union([
      custodyReceiptSchema,
      z.strictObject({
        operationRef: z.uuid(),
        phase: z.enum([
          "reserved",
          "attempted",
          "secret-confirmed",
          "possession-pending",
          "possession-verified",
        ]),
      }),
    ])
    .parse(await readCustodyJson(response));
  if (result.operationRef !== operationRef) {
    throw new CustodyUnavailableError();
  }
  return page(
    `<h1>Saved operation continued</h1><p>${"possession" in result ? "Key possession is verified for the saved receiving deployment." : "The Secret metadata is confirmed. The separately approved recipient refresh and possession check remain required."}</p><p><a href="${custodyOwnerInvocationPath}">Review the saved operation</a></p>`,
  );
};

/** Closed owner ingress delegates to Source in-process; the external browser never obtains a workload token. */
export const createCustodyOwnerInvocationHandler = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: CustodyOwnerInvocationDependencies = {},
) => {
  const now = dependencies.now ?? Date.now;
  const readSetup =
    dependencies.readSetup ??
    (async () => {
      await Promise.resolve();
      return readCustodySetupConfiguration(environment);
    });
  const readBrowserActor =
    dependencies.readBrowserActor ??
    (async (incoming: Request, setup: CustodySetupConfiguration) =>
      await readOriginalBrowserActor(incoming, setup, environment));
  const assertOriginalOwner =
    dependencies.assertOriginalOwner ??
    (async (setup: CustodySetupConfiguration) => {
      await createHostedOperatorConsentOwner(setup.source.workload, environment).assertCurrent({
        authority: setup.capturedOwner.authority,
        ownerContext: setup.capturedOwner,
      });
    });
  const createSourceHandler = dependencies.createSourceHandler ?? createCustodySourceHandler;
  return async (request: Request) => {
    let close: (() => Promise<void>) | undefined;
    try {
      const config = custodySetupConfigurationSchema.parse(await readSetup());
      const url = new URL(request.url);
      const sourceOrigin = new URL(config.source.origin).origin;
      const validAddress = [
        url.origin === sourceOrigin,
        url.pathname === custodyOwnerInvocationPath,
        url.search === "",
        url.hash === "",
        url.username === "",
        url.password === "",
      ].every(Boolean);
      if (
        !validAddress ||
        request.headers.has("authorization") ||
        !["GET", "POST"].includes(request.method)
      ) {
        throw new CustodyUnavailableError();
      }
      if (request.method === "POST" && request.headers.get("origin") !== sourceOrigin) {
        throw new CustodyUnavailableError();
      }
      const actor = await readBrowserActor(request, config);
      if (actor === undefined) {
        if (request.method === "GET") {
          return new Response(null, {
            headers: {
              ...noStore,
              location: `${sourceOrigin}/auth/sign-in?redirectTo=${encodeURIComponent(custodyOwnerInvocationPath)}`,
            },
            status: 303,
          });
        }
        throw new CustodyUnavailableError();
      }
      const expectedActor = browserActorSchema.parse(actor);
      if (expectedActor.userId !== config.capturedOwner.authority.ownerUserId) {
        throw new CustodyUnavailableError();
      }
      const assertCaller = async (setup: CustodySetupConfiguration) => {
        if (!isDeepStrictEqual(setup, config)) {
          throw new CustodyUnavailableError();
        }
        const current = browserActorSchema.parse(await readBrowserActor(request, setup));
        if (!isDeepStrictEqual(current, expectedActor)) {
          throw new CustodyUnavailableError();
        }
        await assertOriginalOwner(setup);
      };
      await assertCaller(config);
      const opened = dependencies.store === undefined ? openReviewStore(environment) : undefined;
      close = opened?.close;
      const store = dependencies.store ?? opened?.store;
      if (store === undefined) {
        throw new CustodyUnavailableError();
      }
      const record = await readCustodyOwnerReview(store, config, now());
      if (request.method === "GET") {
        return renderReview(record, now());
      }
      const operationRef = await readFormSelector(request);
      if (operationRef !== config.operationRef) {
        throw new CustodyUnavailableError();
      }
      await assertCaller(config);
      const sourceHandler = createSourceHandler(environment, {
        currentOwner: assertCaller,
        verifyCaller: async (_sourceRequest, setup) => {
          await assertCaller(setup);
        },
      });
      // The sole selector becomes an in-process JSON request. Cookies stay in the closed browser-auth recheck.
      const response = await sourceHandler(
        new Request(`${sourceOrigin}/api/hosted-operator/key-custody`, {
          body: JSON.stringify({ operationRef }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      return await renderSourceResult(response, config.operationRef);
    } catch {
      return unavailable();
    } finally {
      await close?.();
    }
  };
};
