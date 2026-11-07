import {
  PublicReleasePrerequisiteError,
  publicReleasePrerequisiteResponse,
} from "./public-release-prerequisite";
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

type PublicReleaseResponseBody =
  | { code: string }
  | {
      operationRef: string;
      plan: Awaited<ReturnType<PublicReleasePorts["resolve"]>>;
      planDigest: string;
    }
  | Awaited<ReturnType<ReturnType<typeof createPublicReleaseHandler>["observe"]>>
  | Awaited<ReturnType<ReturnType<typeof createPublicReleaseHandler>["release"]>>;

const response = (value: PublicReleaseResponseBody, status = 200) =>
  Response.json(value, {
    headers: { "cache-control": "no-store" },
    status,
  });

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
      const { ownerContext } = input;
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
      const ports = await dependencies.createPorts({ assertCurrentOwner, input, request });
      await assertCurrentOwner();
      const invocation = {
        authority: ownerContext.authority,
        callId: input.callId,
        sessionId: ownerContext.sessionId,
        signal: request.signal,
      };
      const handler = createPublicReleaseHandler(ports);
      if (input.action === "public-release-plan") {
        const result = await handler.plan(invocation, appId);
        await assertCurrentOwner();
        return response(result);
      }
      // Both effect and observation requests must match the independently owner-scoped stored plan.
      const current = await ports.store.read(invocation.authority, input.input.operationRef);
      await assertCurrentOwner();
      if (!current || !isDeepStrictEqual(current.record.plan, input.input.plan)) {
        return response({ code: "public_release_unavailable" }, 403);
      }
      const { operationRef, planDigest } = input.input;
      const result =
        input.action === "public-release-observe"
          ? await handler.observe(invocation, operationRef, planDigest)
          : await handler.release(invocation, operationRef, planDigest);
      await assertCurrentOwner();
      return response(result);
    } catch (error) {
      if (error instanceof PublicReleasePrerequisiteError) {
        return response(publicReleasePrerequisiteResponse(error), 409);
      }
      // Private transport, credentials, histories and provider messages never cross this boundary.
      return response({ code: "public_release_unavailable" }, 403);
    }
  };
