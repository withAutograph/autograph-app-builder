import { isDeepStrictEqual } from "node:util";
import { createCentralHostService } from "./central-integration-host-service";
import type { CentralHostServicePorts } from "./central-integration-host-service";
import type { AppIntegrationCapabilityRequestAuthority } from "./app-integration-capability-dispatcher";
import { centralHostTransportRequestSchema } from "./central-integration-host-transport";
import {
  CentralHostPrerequisiteError,
  centralHostPrerequisiteResponse,
} from "./central-integration-host-prerequisite";
import type { z } from "zod";
export type CentralHostTransportRequest = z.infer<typeof centralHostTransportRequestSchema>;
/** The protected operator composes real ports; no fallback profile or synthetic readiness is allowed. */
export const createCentralHostDispatcher =
  (dependencies: {
    owner: AppIntegrationCapabilityRequestAuthority;
    createPorts: (input: {
      request: Request;
      input: CentralHostTransportRequest;
      assertCurrentOwner: () => Promise<void>;
    }) => Promise<CentralHostServicePorts>;
  }) =>
  async (request: Request): Promise<Response> => {
    // oxlint-disable-next-line anti-slop/no-object-parameters -- Closed parsed service results or bounded transport errors only.
    const response = (value: object, status = 200) =>
      Response.json(value, { status, headers: { "cache-control": "no-store" } });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/central-integrations")
      return response({ code: "not_found" }, 404);
    try {
      request.signal.throwIfAborted();
      await dependencies.owner.verifyWorkload(request);
      const input = centralHostTransportRequestSchema.parse(await request.json());
      const appId =
        input.action === "central-integration-host-prepare"
          ? input.input.plan.selection.initiatingAppId
          : input.input.appId;
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
      const service = createCentralHostService(ports);
      const invocation = {
        authority: ownerContext.authority,
        sessionId: ownerContext.sessionId,
        callId: input.callId,
        signal: request.signal,
      };
      if (input.action === "central-integration-host-plan") {
        const result = await service.plan(invocation, input.input);
        await assertCurrentOwner();
        return response(result);
      }
      const current = await ports.store.read(invocation.authority, input.input.operationRef);
      await assertCurrentOwner();
      if (!current) {
        throw new Error("central_host_unavailable");
      }
      if (
        current.record.plan.selection.initiatingAppId !== appId ||
        current.record.plan.selection.sessionId !== ownerContext.sessionId ||
        current.record.planDigest !== input.input.planDigest
      ) {
        throw new Error("central_host_unavailable");
      }
      if (
        input.action === "central-integration-host-prepare" &&
        !isDeepStrictEqual(current.record.plan, input.input.plan)
      ) {
        throw new Error("central_host_unavailable");
      }
      const selection = {
        operationRef: input.input.operationRef,
        planDigest: input.input.planDigest,
      };
      const result =
        input.action === "central-integration-host-prepare"
          ? await service.prepare(invocation, selection)
          : await service.read(invocation, selection);
      await assertCurrentOwner();
      return response(result);
    } catch (error) {
      if (error instanceof CentralHostPrerequisiteError)
        return response(centralHostPrerequisiteResponse(error), 409);
      return response({ code: "central_host_unavailable" }, 403);
    }
  };
