import { isDeepStrictEqual } from "node:util";
import { resolveHostedOperatorOwnerContext } from "./hosted-operator-owner-context";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";
import { HostedOperatorError, operatorOwnerContextSchema } from "./hosted-operator-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";

interface ConsentForwardedAttributes {
  "autograph:source-handoff-id"?: string;
  "mcp:audience": string;
  "mcp:scopes": string[];
  "mcp:workspace-id": string;
}

export interface HostedOperatorConsentOwner {
  authority: OperatorOwnerContext["authority"];
  ownerContext: OperatorOwnerContext;
}

/** Consent belongs to the current canonical owner; app resource/project authorization is a later operation. */
export const createHostedOperatorConsentOwner = (
  workloadPolicy: OperatorWorkloadPolicy,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies?: {
    resolveOwner: typeof resolveHostedOperatorOwnerContext;
    verifyWorkload: (request: Request) => Promise<void>;
  },
) => {
  const verifyWorkload =
    dependencies?.verifyWorkload ?? createOperatorWorkloadVerifier(workloadPolicy);
  const resolveOwner = dependencies?.resolveOwner ?? resolveHostedOperatorOwnerContext;
  const currentOwner = async (hint: OperatorOwnerContext | undefined) => {
    const owner = operatorOwnerContextSchema.parse(hint);
    const attributes: ConsentForwardedAttributes = {
      "mcp:audience": owner.principal.audience,
      "mcp:scopes": owner.principal.scopes,
      "mcp:workspace-id": owner.principal.workspaceId,
    };
    if (owner.kind === "handoff") {
      attributes["autograph:source-handoff-id"] = owner.sourceHandoffId;
    }
    const auth = {
      attributes,
      authenticator: "mcp-oauth-jwks",
      issuer: owner.principal.issuer,
      principalId: owner.principal.ownerUserId,
      principalType: "user",
      subject: owner.principal.ownerUserId,
    };
    const resolved = await resolveOwner({
      adapterSessionId: owner.adapterSessionId,
      authority: owner.authority,
      environment,
      principal: owner.principal,
      sessionAuth: { current: auth, initiator: auth },
    });
    if (
      !isDeepStrictEqual(
        {
          ...resolved,
          principal: { ...resolved.principal, scopes: resolved.principal.scopes.toSorted() },
        },
        { ...owner, principal: { ...owner.principal, scopes: owner.principal.scopes.toSorted() } },
      )
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    return { authority: resolved.authority, ownerContext: resolved };
  };
  return {
    assertCurrent: async (context: HostedOperatorConsentOwner) => {
      const current = await currentOwner(context.ownerContext);
      if (!isDeepStrictEqual(current.authority, context.authority)) {
        throw new HostedOperatorError("authorization_required");
      }
    },
    authorize: async (
      request: Request,
      sessionId: string,
      hint: OperatorOwnerContext | undefined,
    ): Promise<HostedOperatorConsentOwner> => {
      await verifyWorkload(request);
      const current = await currentOwner(hint);
      if (current.ownerContext.sessionId !== sessionId) {
        throw new HostedOperatorError("authorization_required");
      }
      return current;
    },
  };
};
