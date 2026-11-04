import {
  IntegrationProviderError,
  integrationProviderHttpError,
} from "./app-integration-provider-diagnostic";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  AppIntegrationCapabilityWorker,
  AppIntegrationCapabilityEffectContext,
} from "./app-integration-capability-ports";
import {
  integrationProviderDestinationReceiptSchema,
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityPlanDigest,
} from "./app-integration-capability-contract";
import type {
  createAppIntegrationPrivateCustody,
  IntegrationPrivateAppScope,
  IntegrationPrivateScope,
} from "./app-integration-private-custody";

const id = z.string().min(1).max(256);
const acceptedSchema = z.strictObject({
  destinationId: id,
  name: id,
  url: z.url(),
  acceptedBy: z.uuid(),
});
export const integrationProviderDestinationKeySchema = z.strictObject({
  destinationId: id,
  name: id,
  url: z.url(),
  signingSecret: z.string().min(1).max(4096),
});
const responseSchema = z.object({
  id,
  name: id,
  type: z.literal("webhook"),
  metadata: z.object({ url: z.url() }),
  secrets: z.object({ webhookSigningKey: z.string().min(1).max(4096) }).optional(),
});
const fail = () => new Error("app_integration_provider_destination_required");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const providerDestinationCustodyScopes = (
  app: IntegrationPrivateAppScope,
  projectId: string,
  name: string,
  url: string,
) => {
  const scope: IntegrationPrivateScope = {
    app,
    purpose: "provider-destination",
    version: 1,
    checkpoint: sha(JSON.stringify([projectId, name, url])),
  };
  return { scope, keyScope: { ...scope, purpose: "provider-destination-key" as const } };
};
/** Only named resources in the exact isolated provider project. No list/adopt/retarget or uncertain POST replay. */
export const createAppIntegrationProviderDestinationWorker = (input: {
  custody: Pick<ReturnType<typeof createAppIntegrationPrivateCustody>, "read" | "reserve">;
  appScope: IntegrationPrivateAppScope;
  readApiKey: (assertCurrent: () => Promise<void>) => Promise<string>;
  fetch?: typeof fetch;
}) => {
  const scopes = (projectId: string, name: string, url: string) =>
    providerDestinationCustodyScopes(input.appScope, projectId, name, url);
  const prepare = async (context: AppIntegrationCapabilityEffectContext) => {
    await context.assertCurrent();
    const { plan } = context;
    const target = plan.providerDestination;
    const matches = [
      plan.version === 2,
      target !== undefined,
      context.effect === "prepare-provider-destination",
      context.planDigest === appIntegrationCapabilityPlanDigest(plan),
      context.operationRef === appIntegrationCapabilityOperationRef(plan),
      isDeepStrictEqual(input.appScope.authority, plan.authority),
      input.appScope.appId === plan.selection.appId,
      input.appScope.projectId === plan.project.projectId,
    ];
    if (matches.includes(false) || target === undefined) {
      throw fail();
    }
    const url = new URL(target.path, target.origin).href;
    const { scope, keyScope } = scopes(plan.provider.projectId, target.name, url);
    return { plan, target, url, scope, keyScope };
  };
  const request = async (
    context: { projectId: string; signal: AbortSignal; assertCurrent: () => Promise<void> },
    name: string,
    method: "GET" | "POST",
    body?: { name: string; type: "webhook"; metadata: { url: string } },
  ) => {
    const key = await input.readApiKey(context.assertCurrent);
    await context.assertCurrent();
    if (!key) {
      throw fail();
    }
    const base = `https://api.withampersand.com/v1/projects/${encodeURIComponent(context.projectId)}/destinations`;
    const response = await (input.fetch ?? fetch)(
      method === "GET" ? `${base}/${encodeURIComponent(name)}?includeSecrets=true` : base,
      {
        method,
        headers: { "X-Api-Key": key, "content-type": "application/json" },
        signal: context.signal,
        redirect: "error",
        cache: "no-store",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    await context.assertCurrent();
    if (method === "GET" && response.status === 404) {
      await response.body?.cancel();
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Named destination absence is a supported read result, never success.
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw integrationProviderHttpError(response);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw fail();
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve stream backpressure within the bounded provider response.
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        size += chunk.value.byteLength;
        if (size > 32_768) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel this same bounded reader before rejecting excess bytes.
          await reader.cancel();
          throw fail();
        }
        parts.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return responseSchema.parse(JSON.parse(Buffer.concat(parts).toString("utf-8")));
  };
  const inspect = async (context: AppIntegrationCapabilityEffectContext) => {
    const current = await prepare(context);
    const stored = await input.custody.read(current.scope);
    await context.assertCurrent();
    if (stored === undefined) {
      return { status: "unknown" as const };
    }
    const accepted = acceptedSchema.parse(stored.value);
    if (accepted.acceptedBy !== context.operationRef && current.target.existing === undefined) {
      throw fail();
    }
    if (accepted.name !== current.target.name || accepted.url !== current.url) {
      throw fail();
    }
    const remote = await request(
      {
        projectId: context.plan.provider.projectId,
        signal: context.invocation.signal,
        assertCurrent: context.assertCurrent,
      },
      current.target.name,
      "GET",
    );
    if (remote === undefined || remote.secrets === undefined) {
      throw fail();
    }
    const remoteMatches = [
      remote.id === accepted.destinationId,
      remote.name === accepted.name,
      remote.metadata.url === accepted.url,
    ];
    if (remoteMatches.includes(false)) {
      throw fail();
    }
    const material = integrationProviderDestinationKeySchema.parse({
      destinationId: remote.id,
      name: remote.name,
      url: remote.metadata.url,
      signingSecret: remote.secrets.webhookSigningKey,
    });
    const key = await input.custody.reserve(current.keyScope, () => material);
    await context.assertCurrent();
    if (!isDeepStrictEqual(key.value, material)) {
      throw fail();
    }
    const receipt = integrationProviderDestinationReceiptSchema.parse({
      effect: "prepare-provider-destination",
      destinationId: remote.id,
      name: remote.name,
      url: remote.metadata.url,
      secretRef: key.reference,
      secretSha256: sha(material.signingSecret),
    });
    if (
      current.target.existing !== undefined &&
      !isDeepStrictEqual(current.target.existing, {
        destinationId: receipt.destinationId,
        secretRef: receipt.secretRef,
        secretSha256: receipt.secretSha256,
      })
    ) {
      throw fail();
    }
    const prior = await context.checkpoint.read();
    if (prior !== undefined && !isDeepStrictEqual(prior, receipt)) {
      throw fail();
    }
    return { status: "applied" as const, receipt };
  };
  const worker: AppIntegrationCapabilityWorker = {
    reconcile: async (context) => {
      try {
        return await inspect(context);
      } catch (error) {
        context.invocation.signal.throwIfAborted();
        return {
          status: "unknown",
          ...(error instanceof IntegrationProviderError ? { diagnostic: error.diagnostic } : {}),
        };
      }
    },
    execute: async (context) => {
      try {
        const current = await prepare(context);
        const stored = await input.custody.read(current.scope);
        await context.assertCurrent();
        if (stored === undefined) {
          // An acknowledged ID in private custody is the only recovery identity. A matching URL alone is never ownership.
          if (
            context.priorPhase !== "idle" ||
            current.target.existing !== undefined ||
            (await request(
              {
                projectId: context.plan.provider.projectId,
                signal: context.invocation.signal,
                assertCurrent: context.assertCurrent,
              },
              current.target.name,
              "GET",
            )) !== undefined
          ) {
            throw fail();
          }
          await context.assertCurrent();
          const created = await request(
            {
              projectId: context.plan.provider.projectId,
              signal: context.invocation.signal,
              assertCurrent: context.assertCurrent,
            },
            current.target.name,
            "POST",
            {
              name: current.target.name,
              type: "webhook",
              metadata: { url: current.url },
            },
          );
          if (
            created === undefined ||
            created.name !== current.target.name ||
            created.metadata.url !== current.url
          ) {
            throw fail();
          }
          const accepted = acceptedSchema.parse({
            destinationId: created.id,
            name: created.name,
            url: created.metadata.url,
            acceptedBy: context.operationRef,
          });
          const saved = await input.custody.reserve(current.scope, () => accepted);
          await context.assertCurrent();
          if (!isDeepStrictEqual(saved.value, accepted)) {
            throw fail();
          }
        }
        const observed = await inspect(context);
        if (observed.status !== "applied") {
          throw fail();
        }
        await context.checkpoint.recordAccepted(observed.receipt);
        await context.assertCurrent();
        return observed.receipt;
      } catch (error) {
        context.invocation.signal.throwIfAborted();
        throw error instanceof IntegrationProviderError ? error : fail();
      }
    },
  };
  return {
    ...worker,
    readOwnedDestination: async (target: {
      projectId: string;
      name: string;
      origin: string;
      path: string;
      signal: AbortSignal;
      assertCurrent: () => Promise<void>;
    }) => {
      await target.assertCurrent();
      const url = new URL(target.path, target.origin).href;
      const { scope, keyScope } = scopes(target.projectId, target.name, url);
      const [acceptedRow, keyRow] = await Promise.all([
        input.custody.read(scope),
        input.custody.read(keyScope),
      ]);
      if (acceptedRow === undefined && keyRow === undefined) {
        if ((await request(target, target.name, "GET")) !== undefined) {
          throw fail();
        }
        // oxlint-disable-next-line unicorn/no-useless-undefined -- No owned provider resource exists; planning may propose a fresh create.
        return undefined;
      }
      if (acceptedRow === undefined || keyRow === undefined) {
        throw fail();
      }
      const accepted = acceptedSchema.parse(acceptedRow.value);
      const material = integrationProviderDestinationKeySchema.parse(keyRow.value);
      const remote = await request(target, target.name, "GET");
      await target.assertCurrent();
      const same = [
        remote !== undefined,
        accepted.name === target.name,
        accepted.url === url,
        remote?.id === accepted.destinationId,
        remote?.name === target.name,
        remote?.metadata.url === url,
        remote?.secrets?.webhookSigningKey === material.signingSecret,
        material.destinationId === accepted.destinationId,
        material.name === target.name,
        material.url === url,
      ];
      if (same.includes(false)) {
        throw fail();
      }

      return {
        destinationId: accepted.destinationId,
        secretRef: keyRow.reference,
        secretSha256: sha(material.signingSecret),
      };
    },
  };
};
