import type { HostedRuntimeApprovalEnvelope } from "../agent/prepare-app-hosted-runtime-step";
import {
  decryptVersionedVercelToken,
  encryptVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import {
  realmContinuationDispatchId,
  observeRealmContinuationRecord,
} from "./hosted-operator-realm-continuation";
import type { RealmContinuationObservation } from "./hosted-operator-realm-continuation";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { updateHostedRuntimeJournal } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalStore,
} from "./hosted-runtime-journal";

export interface HostedRuntimeIdentityWaitInvocation {
  input: HostedRuntimeApprovalEnvelope;
  adapterSessionId: string;
  callId: string;
}
export interface HostedRuntimeIdentityWaitRegistration extends HostedRuntimeIdentityWaitInvocation {
  token: string;
  identityInput: { browserUrl: string; expiresAt: string };
}
export type HostedRuntimeIdentityWaitState =
  | { status: "waiting"; checkAfter: string }
  | { status: "consumed" | "expired"; eventId: string };

type Wait = NonNullable<HostedRuntimeJournalRecord["realmIdentityWait"]>;
const hookAad = (
  context: HostedOperatorContext,
  wait: Pick<
    Wait,
    "adapterSessionId" | "approvedPlanDigest" | "callId" | "nonceSha256" | "operationRef"
  >,
) =>
  JSON.stringify([
    "autograph-realm-identity-wait-v1",
    context.authority.issuer,
    context.authority.audience,
    context.authority.workspaceId,
    context.authority.ownerUserId,
    context.target.sessionId,
    wait.adapterSessionId,
    wait.operationRef,
    wait.approvedPlanDigest,
    wait.nonceSha256,
    wait.callId,
  ]);
const denial = () => new HostedOperatorError("authorization_required");

const stateFor = (
  observation: RealmContinuationObservation | undefined,
  now: number,
): HostedRuntimeIdentityWaitState =>
  observation === undefined
    ? { status: "waiting", checkAfter: new Date(now + 5000).toISOString() }
    : {
        status: observation.reason.kind === "consumed-proof" ? "consumed" : "expired",
        eventId: realmContinuationDispatchId(observation),
      };

/** An authored Workflow wait is tied to the existing approved invocation, never a human reply. */
export const createHostedOperatorRealmIdentityWait = (ports: {
  store: HostedRuntimeJournalStore;
  config: VercelTokenKeyringConfig;
  assertAuthorized: (context: HostedOperatorContext) => Promise<void>;
  observe: (context: HostedOperatorContext) => Promise<RealmContinuationObservation | undefined>;
  now?: () => number;
}) => {
  const now = ports.now ?? Date.now;
  const assertInvocation = (
    context: HostedOperatorContext,
    record: HostedRuntimeJournalRecord,
    invocation: HostedRuntimeIdentityWaitInvocation,
  ) => {
    const { operator } = record;
    if (operator === undefined || operator.identityLink === undefined) {
      throw denial();
    }
    if (
      ![
        invocation.callId.length > 0,
        context.ownerContext?.adapterSessionId === invocation.adapterSessionId,
        operator.operationRef === invocation.input.operationRef,
        operator.planDigest === invocation.input.planDigest,
        operatorPlanDigest(operator.plan) === invocation.input.planDigest,
        operatorPlanDigest(hostedOperatorPlanSchema.parse(invocation.input.plan)) ===
          invocation.input.planDigest,
        sameOperatorSelection(operator.plan.selection, {
          appId: invocation.input.appId,
          branch: invocation.input.branch,
          environment: invocation.input.environment,
          projectId: invocation.input.projectId,
          sessionId: context.target.sessionId,
        }),
      ].every(Boolean)
    ) {
      throw denial();
    }
    return operator.identityLink;
  };
  const read = async (context: HostedOperatorContext) => {
    await ports.assertAuthorized(context);
    const [observation, current] = await Promise.all([
      ports.observe(context),
      ports.store.read(context),
    ]);
    if (current === undefined) {
      throw denial();
    }
    if (
      observation !== undefined &&
      (observation.operationRef !== current.record.operator?.operationRef ||
        observation.approvedPlanDigest !== current.record.operator?.planDigest ||
        observation.nonceSha256 !== current.record.operator?.identityLink?.nonceSha256)
    ) {
      throw new HostedOperatorError("operation_in_progress");
    }
    return { current, observation };
  };
  const decrypt = (context: HostedOperatorContext, wait: Wait) =>
    decryptVersionedVercelToken({
      ...wait.hook,
      config: ports.config,
      associatedData: hookAad(context, wait),
    });

  return {
    async register(
      context: HostedOperatorContext,
      invocation: HostedRuntimeIdentityWaitRegistration,
    ) {
      const { current, observation } = await read(context);
      const link = assertInvocation(context, current.record, invocation);
      const url = new URL(invocation.identityInput.browserUrl);
      if (
        ![
          invocation.token.length > 0,
          url.origin === link.browserOrigin,
          url.pathname === "/api/auth/platform/operator-link",
          url.username === "",
          url.password === "",
          url.hash === "",
          realmIdentityNonceSha256(url.searchParams.get("nonce") ?? "") === link.nonceSha256,
          url.searchParams.get("ownerSessionId") === link.ownerSessionId,
          url.searchParams.get("bootstrapPlanDigest") === link.bootstrapPlanDigest,
          url.searchParams.get("authResourceId") === link.authResourceId,
          url.searchParams.get("organizationId") === link.organizationId,
          invocation.identityInput.expiresAt === link.expiresAt,
        ].every(Boolean)
      ) {
        throw denial();
      }
      const coordinates = {
        adapterSessionId: invocation.adapterSessionId,
        approvedPlanDigest: invocation.input.planDigest,
        callId: invocation.callId,
        nonceSha256: link.nonceSha256,
        operationRef: invocation.input.operationRef,
      };
      const prior = current.record.realmIdentityWait;
      if (prior?.nonceSha256 === link.nonceSha256) {
        if (prior.callId !== invocation.callId || decrypt(context, prior) !== invocation.token) {
          throw denial();
        }
        return stateFor(observation, now());
      }
      const wait: Wait = {
        ...coordinates,
        hook: {
          ...encryptVercelToken({
            associatedData: hookAad(context, coordinates),
            key: ports.config.tokenKey,
            token: invocation.token,
          }),
          keyVersion: ports.config.tokenKeyVersion,
        },
        registeredAt: new Date(now()).toISOString(),
      };
      const saved = await ports.store.compareAndSet({
        ...context,
        expectedRevision: current.revision,
        now: new Date(now()),
        record: { ...current.record, realmIdentityWait: wait },
      });
      if (saved === undefined) {
        throw new HostedOperatorError("operation_in_progress");
      }
      return stateFor(await ports.observe(context), now());
    },
    async acknowledge(
      context: HostedOperatorContext,
      invocation: HostedRuntimeIdentityWaitInvocation & { eventId: string },
    ) {
      const { current, observation } = await read(context);
      const link = assertInvocation(context, current.record, invocation);
      const state = stateFor(observation, now());
      const wait = current.record.realmIdentityWait;
      if (state.status === "waiting" || wait === undefined) {
        throw denial();
      }
      if (
        ![
          state.eventId === invocation.eventId,
          wait.callId === invocation.callId,
          wait.nonceSha256 === link.nonceSha256,
          wait.adapterSessionId === invocation.adapterSessionId,
        ].every(Boolean)
      ) {
        throw denial();
      }
      await updateHostedRuntimeJournal({
        ...context,
        now,
        store: ports.store,
        update: (record) => {
          const currentLink = assertInvocation(context, record, invocation);
          if (currentLink.nonceSha256 !== wait.nonceSha256) {
            throw denial();
          }
          if (observation === undefined) {
            throw denial();
          }
          const currentObservation = observeRealmContinuationRecord({
            context,
            record,
            initiator: observation.initiator,
            now: now(),
          });
          if (
            currentObservation === undefined ||
            realmContinuationDispatchId(currentObservation) !== state.eventId
          ) {
            throw denial();
          }
          if (JSON.stringify(record.realmIdentityWait) !== JSON.stringify(wait)) {
            throw denial();
          }
          return {
            ...record,
            realmIdentityWait: {
              ...wait,
              eventId: state.eventId,
              observedAt: wait.observedAt ?? new Date(now()).toISOString(),
            },
          };
        },
      });
      return state;
    },
    async delivery(
      context: HostedOperatorContext,
    ): Promise<{ token: string; eventId: string; observed: boolean } | undefined> {
      const { current, observation } = await read(context);
      const wait = current.record.realmIdentityWait;
      if (wait === undefined || observation === undefined) {
        return undefined;
      }
      if (
        ![
          wait.adapterSessionId === observation.adapterSessionId,
          wait.operationRef === observation.operationRef,
          wait.approvedPlanDigest === observation.approvedPlanDigest,
          wait.nonceSha256 === observation.nonceSha256,
        ].every(Boolean)
      ) {
        return undefined;
      }
      return {
        token: decrypt(context, wait),
        eventId: realmContinuationDispatchId(observation),
        observed:
          wait.eventId === realmContinuationDispatchId(observation) &&
          wait.observedAt !== undefined,
      };
    },
  };
};
