import { isDeepStrictEqual } from "node:util";
import { createPublicReleaseHandler } from "./public-release-handler";
import type { PublicReleasePorts } from "./public-release-handler";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import { publicReleaseTransportRequestSchema } from "./public-release-transport";
import type { z } from "zod";

export interface PublicReleaseRequestAuthority {
  verifyWorkload: (request: Request) => Promise<void>;
  assertCanonicalAppOwner: (input: {
    authority: OperatorOwnerContext["authority"];
    ownerContext: OperatorOwnerContext;
    target: { appId: string; sessionId: string };
  }) => Promise<void>;
}
export type PublicReleaseRequest = z.infer<typeof publicReleaseTransportRequestSchema>;

/** A separate Production exposure contract; never cast into a frozen Preview selection. */
export const createPublicReleaseDispatcher =
  (dependencies: {
    owner: PublicReleaseRequestAuthority;
    createPorts: (input: {
      request: Request;
      input: PublicReleaseRequest;
      assertCurrentOwner: () => Promise<void>;
    }) => Promise<PublicReleasePorts>;
  }) =>
  async (request: Request): Promise<Response> => {
    // oxlint-disable-next-line anti-slop/no-object-parameters -- The HTTP JSON boundary serializes only closed parsed plan/results or bounded codes.
  const response = (value: object, status = 200) =>
      Response.json(value, {
        status,
        headers: { "cache-control": "no-store" },
      });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/public-release") {
      return response({ code: "not_found" }, 404);
    }
    try {
      request.signal.throwIfAborted();
      // Signature/audience verification precedes request-owned identity or database reads.
      await dependencies.owner.verifyWorkload(request);
      const input = publicReleaseTransportRequestSchema.parse(await request.json());
      const appId =
        input.action === "public-release-plan" ? input.appId : input.input.plan.selection.appId;
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
      const handler = createPublicReleaseHandler(ports);
      if (input.action === "public-release-plan") {
        const result = await handler.plan(invocation, appId);
        await assertCurrentOwner();
        return response(result);
      }
      // The independently owner-scoped stored frozen plan, not a caller-supplied replacement,
      // is the authority for effects. Reject even a digest-consistent alternate payload.
      const current = await ports.store.read(invocation.authority, input.input.operationRef);
      await assertCurrentOwner();
      if (!current || !isDeepStrictEqual(current.record.plan, input.input.plan)) {
        return response({ code: "public_release_unavailable" }, 403);
      }
      const result = await handler.release(
        invocation,
        input.input.operationRef,
        input.input.planDigest,
      );
      await assertCurrentOwner();
      return response(result);
    } catch {
      // Private transport, credentials, histories and provider messages never cross this boundary.
      return response({ code: "public_release_unavailable" }, 403);
    }
  };
