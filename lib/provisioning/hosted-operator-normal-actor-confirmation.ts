import { createHash } from "node:crypto";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import { operatorPlanDigest, sameOperatorSelection } from "./hosted-operator-contract";
import {
  normalActorCaptureCookieDigest,
  normalActorCapturedPayloadSchema,
} from "./hosted-operator-normal-actor-journal";
import type { NormalActorCapturedPayload } from "./hosted-operator-normal-actor-journal";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import {
  decryptNormalActorState,
  encryptNormalActorState,
} from "./hosted-operator-normal-actor-state";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

export interface NormalActorConfirmationInput {
  context: HostedOperatorContext;
  record: HostedRuntimeJournalRecord;
  nonceSha256: string;
  proofRef: string;
  proofSha256: string;
  /** Decrypted by the private capture journal after native sender and actual GetSession verification. */
  payload: NormalActorCapturedPayload;
  keyring: VercelTokenKeyringConfig;
  now: number;
}
const reject = (): never => {
  throw new Error("normal_actor_confirmation_unavailable");
};

/** Pure atomic update for the canonical human callback. The caller must freshly
 * assert canonical ownership and original approval, then CAS this entire record. */
// oxlint-disable-next-line eslint/complexity -- Every binding belongs to the actual capture, first approval or consumed nonce.
export const confirmNormalActorCapture = (
  input: NormalActorConfirmationInput,
): HostedRuntimeJournalRecord => {
  try {
    const { context, record, now } = input;
    const preparation = record.accountPreparation;
    const { operator } = record;
    const link = operator?.identityLink;
    const payload = normalActorCapturedPayloadSchema.parse(input.payload);
    if (preparation === undefined || operator === undefined || link === undefined) {
      return reject();
    }
    const capture = preparation.captures.find(
      (entry) => entry.reference === payload.session.reference,
    );
    if (capture === undefined) {
      return reject();
    }
    const actor = preparation.program.actors.find((entry) => entry.actorKey === payload.actorKey);
    const originHost = new URL(preparation.program.origin).hostname;
    const domainHost = payload.normalCookie.domain.replace(/^\./u, "");
    const sameOrganization = capture?.organizationId === payload.organizationId;
    const valid = [
      record.leaseId === undefined,
      operator.pendingEffectId === undefined,
      operator.pendingEffectAttempt === undefined,
      sameOperatorSelection(record.request, context.target),
      sameOperatorSelection(preparation.accountPlan.selection, context.target),
      preparation.program.appId === context.target.appId,
      preparation.accountPlan.stage === "auth-participants",
      preparation.accountPlanDigest === operatorPlanDigest(preparation.accountPlan),
      preparation.programDigest === normalActorProgramDigest(preparation.program),
      preparation.accountPlan.normalActorProgram !== undefined &&
        normalActorProgramDigest(preparation.accountPlan.normalActorProgram) ===
          preparation.programDigest,
      link.browserSession?.operationRef === preparation.accountOperationRef,
      link.browserSession?.participantProgramDigest === preparation.programDigest,
      link.bootstrapPlanDigest === preparation.accountPlanDigest,
      link.ownerSessionId === context.target.sessionId,
      link.browserOrigin === preparation.program.origin,
      link.nonceSha256 === input.nonceSha256,
      payload.nonceSha256 === input.nonceSha256,
      payload.proofSha256 === input.proofSha256,
      createHash("sha256").update(payload.proof).digest("hex") === input.proofSha256,
      input.proofRef ===
        `_protected-operator/artifacts/realm-identity-proof/${context.target.appId}/${input.proofSha256}`,
      actor?.account === "capture-existing",
      capture !== undefined && capture.sealed !== undefined,
      capture?.actorKey === payload.actorKey,
      sameOrganization,
      // Participant proof authenticates the account before target organizations exist.
      // The approved target organization is correlated privately by capture metadata.
      link.organizationId === null,
      capture?.nonceSha256 === input.nonceSha256,
      capture?.proofSha256 === input.proofSha256,
      capture?.normalCookieSha256 === normalActorCaptureCookieDigest(payload.normalCookie),
      payload.session.origin === preparation.program.origin,
      payload.normalCookie.hostOnly
        ? domainHost === originHost && !payload.normalCookie.domain.startsWith(".")
        : originHost === domainHost || originHost.endsWith(`.${domainHost}`),
      payload.organizationId === undefined ||
        preparation.program.memberships.some(
          (membership) =>
            membership.actorKey === payload.actorKey &&
            membership.organizationId === payload.organizationId,
        ),
    ].every(Boolean);
    if (!valid) {
      return reject();
    }
    const scope = {
      authority: context.authority,
      ownerSessionId: context.target.sessionId,
      operationRef: preparation.accountOperationRef,
      program: preparation.program,
      config: input.keyring,
    };
    const state = decryptNormalActorState({ ...scope, sealed: preparation.sealedState });
    const checkpoint = state.actors.find((entry) => entry.actorKey === payload.actorKey);
    if (
      checkpoint === undefined ||
      (checkpoint.session !== undefined && checkpoint.session.actorId !== payload.session.actorId)
    ) {
      return reject();
    }
    if (link.consumedAt !== undefined) {
      if (link.proofRef !== input.proofRef || link.proofSha256 !== input.proofSha256) {
        return reject();
      }
      return record;
    }
    if (
      ![link.expiresAt, capture.expiresAt, payload.session.expiresAt].every(
        (expiresAt) => Date.parse(expiresAt) > now,
      )
    ) {
      return reject();
    }
    const { hostOnly, ...cookie } = payload.normalCookie;
    const storageState = {
      cookies: [{ ...cookie, domain: hostOnly ? cookie.domain : `.${domainHost}` }],
      origins: [],
    };
    if (payload.organizationId === undefined) {
      checkpoint.signup = "complete";
      checkpoint.session = payload.session;
      checkpoint.storageState = storageState;
    } else {
      if (checkpoint.session === undefined) {
        return reject();
      }
      state.organizationSessions = [
        ...(state.organizationSessions ?? []).filter(
          (entry) =>
            entry.actorKey !== payload.actorKey || entry.organizationId !== payload.organizationId,
        ),
        {
          actorKey: payload.actorKey,
          organizationId: payload.organizationId,
          selection: "pending",
          session: payload.session,
          storageState,
        },
      ];
    }
    const consumedLink = { ...link };
    delete consumedLink.sealedNonce;
    return {
      ...record,
      operator: {
        ...operator,
        identityLink: {
          ...consumedLink,
          consumedAt: new Date(now).toISOString(),
          proofRef: input.proofRef,
          proofSha256: input.proofSha256,
        },
      },
      accountPreparation: {
        ...preparation,
        sealedState: encryptNormalActorState({ ...scope, state }),
      },
    };
  } catch {
    // Parser and ciphertext failures must not expose captured cookies or identities.
    // oxlint-disable-next-line eslint/preserve-caught-error -- Private capture diagnostics are intentionally discarded.
    return reject();
  }
};
