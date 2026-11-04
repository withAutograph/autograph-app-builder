import { IntegrationProviderError } from "./app-integration-provider-diagnostic";
import {
  AppIntegrationCapabilityPrerequisiteError,
  appIntegrationCapabilityPrerequisiteResponse,
} from "./app-integration-capability-prerequisite";
import { isDeepStrictEqual } from "node:util";
import { createAppIntegrationCapabilityHandler } from "./app-integration-capability-handler";
import type { AppIntegrationCapabilityPorts } from "./app-integration-capability-handler";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import { appIntegrationCapabilityTransportRequestSchema } from "./app-integration-capability-transport";
import type { z } from "zod";

export interface AppIntegrationCapabilityRequestAuthority {
  verifyWorkload: (request: Request) => Promise<void>;
  assertCanonicalAppOwner: (input: {
    authority: OperatorOwnerContext["authority"];
    ownerContext: OperatorOwnerContext;
    target: { appId: string; sessionId: string };
  }) => Promise<void>;
}
export type AppIntegrationCapabilityRequest = z.infer<
  typeof appIntegrationCapabilityTransportRequestSchema
>;

/** A separate Production exposure contract; never cast into a frozen Preview selection. */
export const createAppIntegrationCapabilityDispatcher =
  (dependencies: {
    owner: AppIntegrationCapabilityRequestAuthority;
    createPorts: (input: {
      request: Request;
      input: AppIntegrationCapabilityRequest;
      assertCurrentOwner: () => Promise<void>;
    }) => Promise<AppIntegrationCapabilityPorts>;
  }) =>
  async (request: Request): Promise<Response> => {
    // oxlint-disable-next-line anti-slop/no-object-parameters -- The HTTP JSON boundary serializes only closed parsed plan/results or bounded codes.
    const response = (value: object, status = 200) =>
      Response.json(value, {
        status,
        headers: { "cache-control": "no-store" },
      });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/app-integrations") {
      return response({ code: "not_found" }, 404);
    }
    try {
      request.signal.throwIfAborted();
      // Signature/audience verification precedes request-owned identity or database reads.
      await dependencies.owner.verifyWorkload(request);
      const input = appIntegrationCapabilityTransportRequestSchema.parse(await request.json());
      const appId =
        input.action === "app-integration-capability-plan"
          ? input.appId
          : input.input.plan.selection.appId;
      const ownerContext = input.ownerContext;
      const assertCurrentOwner = async () => {
        request.signal.throwIfAborted();
        await dependencies.owner.assertCanonicalAppOwner({
          authority: ownerContext.authority,
          ownerContext,
          target: { appId, sessionId: ownerContext.sessionId },
        });
        request.signal.throwIfAborted();
      };
      await assertCurrentOwner();
      const ports = await dependencies.createPorts({ request, input, assertCurrentOwner });
      await assertCurrentOwner();
      const invocation = {
        authority: ownerContext.authority,
        sessionId: ownerContext.sessionId,
        callId: input.callId,
        signal: request.signal,
      };
      const handler = createAppIntegrationCapabilityHandler(ports);
      if (input.action === "app-integration-capability-plan") {
        const result = await handler.plan(invocation, appId);
        await assertCurrentOwner();
        return response(result);
      }
      // The independently owner-scoped stored frozen plan, not a caller-supplied replacement,
      // is the authority for effects. Reject even a digest-consistent alternate payload.
      const current = await ports.store.read(invocation.authority, input.input.operationRef);
      await assertCurrentOwner();
      if (!current || !isDeepStrictEqual(current.record.plan, input.input.plan)) {
        return response({ code: "app_integration_capability_unavailable" }, 403);
      }
      const result = await handler.prepare(
        invocation,
        input.input.operationRef,
        input.input.planDigest,
      );
      await assertCurrentOwner();
      return response(result);
    } catch (error) {
      if (error instanceof AppIntegrationCapabilityPrerequisiteError) {
        return response(appIntegrationCapabilityPrerequisiteResponse(error), 409);
      }
      if (error instanceof IntegrationProviderError) {
        return response({code:"app_integration_provider_rejected",diagnostic:error.diagnostic},503);
      }
      // Private transport, credentials, histories and provider messages never cross this boundary.
      return response({ code: "app_integration_capability_unavailable" }, 403);
    }
  };
