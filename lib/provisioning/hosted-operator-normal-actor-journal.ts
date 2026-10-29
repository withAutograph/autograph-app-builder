import { readParticipantSuccessorPredecessor } from "./hosted-operator-participant-successor";
/* oxlint-disable eslint/no-await-in-loop, sonarjs/expression-complexity -- CAS and encrypted capture require each exact approval, scope, nonce, proof and session binding. */
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  decryptVersionedVercelToken,
  encryptVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  hostedOperatorPlanSchema,
  normalActorPreparationSchema,
  normalActorPredecessorSchema,
  operatorPlanDigest,
  operatorRealmIdentityLinkSchema,
  hostedOperatorOwnedOrganizationSpecSchema,
  sameOperatorSelection,
  retainedOperatorAuthSchema,
  operatorDeploymentCandidateSchema,
} from "./hosted-operator-contract";
import {
  assertNormalActorState,
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
  normalActorSessionRefSchema,
} from "./hosted-operator-normal-actor-program";
import type {
  NormalActorCheckpoint,
  NormalActorState,
} from "./hosted-operator-normal-actor-program";
import {
  decryptNormalActorState,
  encryptNormalActorState,
  sealedNormalActorStateSchema,
} from "./hosted-operator-normal-actor-state";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { CompletedParticipantBootstrap } from "./hosted-operator-participant-bootstrap";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const actorKey = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
export const normalActorCaptureCookieSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,256}$/u),
  value: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\u0021\u0023-\u002B\u002D-\u003A\u003C-\u005B\u005D-\u007E]+$/u),
  domain: z.string().min(1).max(256),
  path: z.string().startsWith("/").max(2048),
  expires: z.literal(-1),
  httpOnly: z.literal(true),
  secure: z.literal(true),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  hostOnly: z.boolean(),
});
export type NormalActorCaptureCookie = z.infer<typeof normalActorCaptureCookieSchema>;
const captureReferenceSchema = z
  .strictObject({
    reference: z.uuid(),
    actorKey,
    organizationId: z.string().min(1).max(512).optional(),
    nonceSha256: digest,
    proofSha256: digest,
    expiresAt: z.iso.datetime({ offset: true }),
    normalCookieSha256: digest.optional(),
    sealed: sealedNormalActorStateSchema.optional(),
  })
  .refine(
    (value) => (value.sealed === undefined) === (value.normalCookieSha256 === undefined),
    "Capture completion requires sealed actual cookie bytes.",
  );
export const normalActorPendingCaptureSchema = z.strictObject({
  actorKey,
  organizationId: z.string().min(1).optional(),
  nonceSha256: digest,
  expiresAt: z.iso.datetime({ offset: true }),
});
export type NormalActorPendingCapture = z.infer<typeof normalActorPendingCaptureSchema>;
export const normalActorOrganizationProofSchema = z.strictObject({
  organizationId: z.string().min(1),
  ownerActorKey: actorKey,
  owner: normalActorSessionRefSchema,
  link: operatorRealmIdentityLinkSchema,
  bootstrap: z
    .strictObject({
      auth: retainedOperatorAuthSchema,
      candidate: operatorDeploymentCandidateSchema,
      gateway: retainedOperatorAuthSchema.optional(),
    })
    .optional(),
  transportSource:
    hostedOperatorOwnedOrganizationSpecSchema.shape.identityVerification.shape.transportSource,
});
export type NormalActorOrganizationProof = z.infer<typeof normalActorOrganizationProofSchema>;
type OrganizationProofOwner = Pick<
  NormalActorOrganizationProof,
  "organizationId" | "ownerActorKey" | "owner"
>;
export type NormalActorOrganizationProofBinding = Pick<
  NormalActorOrganizationProof["link"],
  | "audience"
  | "authResourceId"
  | "bootstrapPlanDigest"
  | "browserOrigin"
  | "endpointOrigin"
  | "issuer"
> & { transportSource: NormalActorOrganizationProof["transportSource"] };
export const normalActorAccountPreparationSchema = normalActorPreparationSchema.extend({
  program: normalActorProgramSchema,
  predecessor: normalActorPredecessorSchema.optional(),
  accountPlan: hostedOperatorPlanSchema,
  sealedState: sealedNormalActorStateSchema,
  captures: z.array(captureReferenceSchema),
  organizationProofs: z.array(normalActorOrganizationProofSchema).optional(),
  supersededOrganizationProofs: z.array(normalActorOrganizationProofSchema).optional(),
  pendingCaptures: z.array(normalActorPendingCaptureSchema).optional(),
  accountsCompletedAt: z.iso.datetime({ offset: true }).optional(),
});
export type NormalActorAccountPreparation = z.infer<typeof normalActorAccountPreparationSchema>;
export type NormalActorAccountProvenance = Omit<
  NormalActorAccountPreparation,
  | "sealedState"
  | "captures"
  | "accountsCompletedAt"
  | "organizationProofs"
  | "supersededOrganizationProofs"
  | "pendingCaptures"
>;
export const normalActorCapturedPayloadSchema = z.strictObject({
  version: z.literal(1),
  actorKey,
  organizationId: z.string().min(1).max(512).optional(),
  nonceSha256: digest,
  proofSha256: digest,
  proof: z.string().min(1).max(16_384),
  session: normalActorSessionRefSchema,
  normalCookie: normalActorCaptureCookieSchema,
});
export type NormalActorCapturedPayload = z.infer<typeof normalActorCapturedPayloadSchema>;
export interface NormalActorJournalPorts {
  store: Pick<HostedRuntimeJournalStore, "read" | "compareAndSet">;
  keyring: VercelTokenKeyringConfig;
  assertAuthorized: (context: HostedOperatorContext) => Promise<void>;
  assertAccountApproval: (
    context: HostedOperatorContext,
    preparation: NormalActorAccountProvenance,
  ) => Promise<void>;
  /** Recheck the active effect lease/fence, or canonical idle owner-callback authority, for this actual row. */
  assertMutationAuthority: (
    context: HostedOperatorContext,
    row: HostedRuntimeJournalRow,
  ) => Promise<void>;
  now: () => number;
}
const provenance = (preparation: NormalActorAccountPreparation): NormalActorAccountProvenance => ({
  program: preparation.program,
  ...(preparation.predecessor === undefined ? {} : { predecessor: preparation.predecessor }),
  programDigest: preparation.programDigest,
  accountOperationRef: preparation.accountOperationRef,
  accountPlan: preparation.accountPlan,
  accountPlanDigest: preparation.accountPlanDigest,
  accountApprovalId: preparation.accountApprovalId,
  accountApprovedByCallId: preparation.accountApprovedByCallId,
});
const validateProvenance = (
  context: HostedOperatorContext,
  input: NormalActorAccountProvenance,
) => {
  if (
    input.programDigest !== normalActorProgramDigest(input.program) ||
    input.accountPlanDigest !== operatorPlanDigest(input.accountPlan) ||
    input.accountPlan.stage !== "auth-participants" ||
    !isDeepStrictEqual(input.predecessor, input.accountPlan.normalActorPredecessor) ||
    input.accountPlan.normalActorProgram === undefined ||
    normalActorProgramDigest(input.accountPlan.normalActorProgram) !== input.programDigest ||
    !sameOperatorSelection(input.accountPlan.selection, context.target) ||
    input.program.appId !== context.target.appId ||
    input.accountPlan.action !== "prepare"
  ) {
    throw new Error("normal_actor_journal_authority_mismatch");
  }
};
const stateScope = (context: HostedOperatorContext, preparation: NormalActorAccountProvenance) => ({
  authority: context.authority,
  ownerSessionId: context.target.sessionId,
  operationRef: preparation.accountOperationRef,
  program: preparation.program,
});
const captureAad = (
  context: HostedOperatorContext,
  preparation: NormalActorAccountProvenance,
  capture: z.infer<typeof captureReferenceSchema>,
) =>
  JSON.stringify({
    ...context.authority,
    ownerSessionId: context.target.sessionId,
    appId: preparation.program.appId,
    accountOperationRef: preparation.accountOperationRef,
    programDigest: preparation.programDigest,
    origin: preparation.program.origin,
    nonceSha256: capture.nonceSha256,
    proofSha256: capture.proofSha256,
    actorKey: capture.actorKey,
    ...(capture.organizationId === undefined ? {} : { organizationId: capture.organizationId }),
    reference: capture.reference,
    purpose: "normal-auth-capture-v1",
  });
export const normalActorCaptureCookieDigest = (
  cookie: Pick<NormalActorCaptureCookie, "name" | "value">,
) => createHash("sha256").update(`${cookie.name}=${cookie.value}`).digest("hex");

const sameCarriedActor = (original: NormalActorCheckpoint, current: NormalActorCheckpoint) => {
  const { session: originalSession, ...originalCheckpoint } = original;
  const { session: currentSession, ...currentCheckpoint } = current;
  if (originalSession === undefined || currentSession === undefined) {
    return false;
  }
  const { activeOrganizationId: originalOrganization, ...originalIdentity } = originalSession;
  const { activeOrganizationId: currentOrganization, ...currentIdentity } = currentSession;
  return [
    (originalOrganization ?? null) === null,
    (currentOrganization ?? null) === null,
    isDeepStrictEqual(originalIdentity, currentIdentity),
    isDeepStrictEqual(originalCheckpoint, currentCheckpoint),
  ].every(Boolean);
};

const assertCarriedActors = (
  context: HostedOperatorContext,
  row: HostedRuntimeJournalRow,
  preparation: NormalActorAccountPreparation,
  state: NormalActorState,
  config: VercelTokenKeyringConfig,
  now: number,
) => {
  if (preparation.predecessor === undefined) {
    return;
  }
  const prior = readParticipantSuccessorPredecessor(row.record, preparation.accountPlan, now);
  if (prior === undefined) {
    throw new Error("normal_actor_journal_authority_mismatch");
  }
  const original = decryptNormalActorState({
    ...stateScope(context, prior.preparation),
    config,
    sealed: prior.preparation.sealedState,
  });
  if (
    !original.actors.every((actor) => state.actors.some((entry) => sameCarriedActor(actor, entry)))
  ) {
    throw new Error("normal_actor_journal_authority_mismatch");
  }
};

const captureReference = (
  preparation: NormalActorAccountPreparation,
  nonceSha256: string,
): string => {
  const capture = preparation.captures.find((entry) => entry.nonceSha256 === nonceSha256);
  if (capture === undefined) {
    throw new Error("normal_actor_capture_unavailable");
  }
  return capture.reference;
};

const hasOrganizationAccountSessions = (
  preparation: NormalActorAccountPreparation,
  state: NormalActorState,
) => {
  const accountActorIds = new Map(
    state.actors.map((actor) => [actor.actorKey, actor.session?.actorId]),
  );
  return preparation.program.memberships.every(
    (membership) =>
      state.organizationSessions?.some(
        (candidate) =>
          candidate.actorKey === membership.actorKey &&
          candidate.organizationId === membership.organizationId &&
          accountActorIds.get(candidate.actorKey) === candidate.session.actorId,
      ) === true,
  );
};

const organizationProofAad = (
  context: HostedOperatorContext,
  preparation: NormalActorAccountPreparation,
  input: OrganizationProofOwner,
) =>
  JSON.stringify({
    ...stateScope(context, preparation),
    organizationId: input.organizationId,
    ownerActorKey: input.ownerActorKey,
    realmSessionId: input.owner.realmSessionId,
    purpose: "normal-actor-organization-proof-nonce-v1",
  });
const assertOrganizationProofOwner = (
  preparation: NormalActorAccountPreparation,
  state: NormalActorState,
  input: OrganizationProofOwner,
) => {
  const organization = preparation.program.organizations.find(
    (entry) => entry.organizationId === input.organizationId,
  );
  const candidate = state.organizationSessions?.find(
    (entry) =>
      entry.actorKey === input.ownerActorKey && entry.organizationId === input.organizationId,
  );
  if (
    ![
      organization?.ownerActorKey === input.ownerActorKey,
      candidate?.session.actorId === input.owner.actorId,
      candidate?.session.realmSessionId === input.owner.realmSessionId,
      candidate?.session.reference === input.owner.reference,
      input.owner.origin === preparation.program.origin,
    ].every(Boolean)
  ) {
    throw new Error("normal_actor_organization_proof_mismatch");
  }
};
const assertOrganizationProofBinding = (
  current: NormalActorAccountPreparation,
  binding: NormalActorOrganizationProofBinding,
  bootstrap: CompletedParticipantBootstrap | undefined,
  selected: CompletedParticipantBootstrap | undefined,
) => {
  if (
    binding.browserOrigin !== current.program.origin ||
    binding.issuer !== current.program.origin ||
    binding.authResourceId !== current.accountPlan.authDatabase.resourceId
  ) {
    throw new Error("normal_actor_organization_proof_mismatch");
  }
  if (bootstrap === undefined) {
    return;
  }
  if (
    selected === undefined ||
    !isDeepStrictEqual(selected, bootstrap) ||
    binding.endpointOrigin !== selected.candidate.origin ||
    binding.bootstrapPlanDigest !== current.accountPlanDigest ||
    selected.auth.plan.authDatabase.resourceId !== current.accountPlan.authDatabase.resourceId ||
    selected.auth.plan.normalActorProgram === undefined ||
    normalActorProgramDigest(selected.auth.plan.normalActorProgram) !== current.programDigest
  ) {
    throw new Error("normal_actor_organization_proof_mismatch");
  }
};
const sameOrganizationProofBinding = (
  existing: NormalActorOrganizationProof,
  input: OrganizationProofOwner & { binding: NormalActorOrganizationProofBinding },
) =>
  [
    existing.ownerActorKey === input.ownerActorKey,
    existing.owner.actorId === input.owner.actorId,
    existing.owner.realmSessionId === input.owner.realmSessionId,
    existing.link.audience === input.binding.audience,
    existing.link.authResourceId === input.binding.authResourceId,
    existing.link.bootstrapPlanDigest === input.binding.bootstrapPlanDigest,
    existing.link.browserOrigin === input.binding.browserOrigin,
    existing.link.issuer === input.binding.issuer,
    existing.transportSource.audience === input.binding.transportSource.audience,
    existing.transportSource.issuer === input.binding.transportSource.issuer,
    existing.transportSource.ownerId === input.binding.transportSource.ownerId,
    existing.transportSource.projectId === input.binding.transportSource.projectId,
    existing.transportSource.environment === input.binding.transportSource.environment,
  ].every(Boolean);
/** Actual owner journal CAS; raw normal sessions are decrypted only in this private capability. */
export const createNormalActorJournal = (ports: NormalActorJournalPorts) => {
  const guarded = async <T>(action: () => Promise<T>, guard?: () => Promise<void>) => {
    await guard?.();
    const result = await action();
    await guard?.();
    return result;
  };
  const assertPredecessorApprovals = async (
    context: HostedOperatorContext,
    prior: NonNullable<HostedRuntimeJournalRow["record"]["participantPreparationHistory"]>[number],
  ) => {
    const approvalId = prior.operator.approvalId;
    if (approvalId === undefined) {
      throw new Error("normal_actor_journal_authority_mismatch");
    }
    validateProvenance(context, prior.preparation);
    await ports.assertAccountApproval(context, provenance(prior.preparation));
    await ports.assertAccountApproval(context, {
      ...provenance(prior.preparation),
      accountOperationRef: prior.operator.operationRef,
      accountPlan: prior.operator.plan,
      accountPlanDigest: prior.operator.planDigest,
      accountApprovalId: approvalId,
      accountApprovedByCallId: prior.approvedByCallId,
    });
  };
  const read = async (context: HostedOperatorContext, guard?: () => Promise<void>) => {
    await guarded(() => ports.assertAuthorized(context), guard);
    const row = await guarded(() => ports.store.read(context), guard);
    if (row === undefined) {
      throw new Error("normal_actor_journal_unavailable");
    }
    const preparation = row.record.accountPreparation;
    if (preparation === undefined) {
      return { row, preparation: undefined, state: undefined };
    }
    validateProvenance(context, preparation);
    await guarded(() => ports.assertAccountApproval(context, provenance(preparation)), guard);
    if (preparation.predecessor !== undefined) {
      const prior = readParticipantSuccessorPredecessor(
        row.record,
        preparation.accountPlan,
        ports.now(),
      );
      if (prior === undefined) {
        throw new Error("normal_actor_journal_authority_mismatch");
      }
      await guarded(() => assertPredecessorApprovals(context, prior), guard);
    }
    const state = decryptNormalActorState({
      ...stateScope(context, preparation),
      config: ports.keyring,
      sealed: preparation.sealedState,
    });
    assertCarriedActors(context, row, preparation, state, ports.keyring, ports.now());
    await guarded(() => ports.assertAuthorized(context), guard);
    const latest = await guarded(() => ports.store.read(context), guard);
    if (latest?.revision !== row.revision) {
      throw new Error("normal_actor_journal_changed");
    }
    return { row, preparation, state };
  };
  const mutate = async (
    context: HostedOperatorContext,
    change: (row: HostedRuntimeJournalRow) => NormalActorAccountPreparation,
    guard?: () => Promise<void>,
  ) => {
    for (;;) {
      const { row } = await read(context, guard);
      await guarded(() => ports.assertMutationAuthority(context, row), guard);
      const preparation = normalActorAccountPreparationSchema.parse(change(row));
      validateProvenance(context, preparation);
      await guarded(() => ports.assertAccountApproval(context, provenance(preparation)), guard);
      await guarded(() => ports.assertAuthorized(context), guard);
      await guarded(() => ports.assertMutationAuthority(context, row), guard);
      if (JSON.stringify(preparation) === JSON.stringify(row.record.accountPreparation)) {
        const latest = await guarded(() => ports.store.read(context), guard);
        if (latest?.revision === row.revision) {
          return preparation;
        }
        continue;
      }
      const saved = await guarded(
        () =>
          ports.store.compareAndSet({
            ...context,
            record: { ...row.record, accountPreparation: preparation },
            expectedRevision: row.revision,
            now: new Date(ports.now()),
          }),
        guard,
      );
      if (saved !== undefined) {
        return preparation;
      }
    }
  };
  return {
    async initializeSuccessor(
      context: HostedOperatorContext,
      input: NormalActorAccountProvenance,
      assertCurrent: () => Promise<void>,
      verifyOriginal: (
        preparation: NormalActorAccountPreparation,
        state: NormalActorState,
      ) => Promise<NormalActorState>,
    ) {
      validateProvenance(context, input);
      await assertCurrent();
      const original = await read(context, assertCurrent);
      const prior = readParticipantSuccessorPredecessor(
        original.row.record,
        input.accountPlan,
        ports.now(),
      );
      if (
        prior === undefined ||
        original.preparation === undefined ||
        original.state === undefined ||
        !isDeepStrictEqual(original.preparation, prior.preparation) ||
        input.accountOperationRef === prior.preparation.accountOperationRef ||
        input.accountOperationRef === prior.operator.operationRef
      ) {
        throw new Error("normal_actor_journal_authority_mismatch");
      }
      const guard = async () => {
        await assertCurrent();
        await assertPredecessorApprovals(context, prior);
        await assertCurrent();
      };
      await guard();
      const verified = await verifyOriginal(original.preparation, original.state);
      if (!isDeepStrictEqual(verified, original.state)) {
        throw new Error("normal_actor_journal_authority_mismatch");
      }
      await assertCurrent();
      await ports.assertAccountApproval(context, input);
      const carriedActors = new Map(verified.actors.map((actor) => [actor.actorKey, actor]));
      return await mutate(
        context,
        (row) => {
          const current = row.record.operator;
          if (
            !isDeepStrictEqual(row.record.accountPreparation, original.preparation) ||
            readParticipantSuccessorPredecessor(row.record, input.accountPlan, ports.now()) ===
              undefined ||
            current?.operationRef !== input.accountOperationRef ||
            current.planDigest !== input.accountPlanDigest ||
            current.approvalId !== input.accountApprovalId ||
            row.record.approvedByCallId !== input.accountApprovedByCallId
          ) {
            throw new Error("normal_actor_journal_authority_mismatch");
          }
          const state = initialNormalActorState(input.program, input.accountOperationRef);
          state.actors = state.actors.map((actor) =>
            structuredClone(carriedActors.get(actor.actorKey) ?? actor),
          );
          return {
            ...input,
            sealedState: encryptNormalActorState({
              ...stateScope(context, input),
              config: ports.keyring,
              state,
            }),
            captures: [],
          };
        },
        guard,
      );
    },
    async retain(context: HostedOperatorContext, input: NormalActorAccountProvenance) {
      validateProvenance(context, input);
      await ports.assertAccountApproval(context, input);
      return await mutate(context, (row) => {
        if (row.record.accountPreparation !== undefined) {
          const existing = row.record.accountPreparation;
          if (
            ![
              existing.accountOperationRef === input.accountOperationRef,
              existing.programDigest === input.programDigest,
              existing.accountPlanDigest === input.accountPlanDigest,
              existing.accountApprovalId === input.accountApprovalId,
              existing.accountApprovedByCallId === input.accountApprovedByCallId,
            ].every(Boolean)
          ) {
            throw new Error("normal_actor_journal_authority_mismatch");
          }
          return row.record.accountPreparation;
        }
        const { operator } = row.record;
        if (
          operator?.operationRef !== input.accountOperationRef ||
          operator.planDigest !== input.accountPlanDigest ||
          operator.approvalId !== input.accountApprovalId ||
          row.record.approvedByCallId !== input.accountApprovedByCallId
        ) {
          throw new Error("normal_actor_journal_authority_mismatch");
        }
        return {
          ...input,
          sealedState: encryptNormalActorState({
            ...stateScope(context, input),
            config: ports.keyring,
            state: initialNormalActorState(input.program, input.accountOperationRef),
          }),
          captures: [],
        };
      });
    },
    async read(context: HostedOperatorContext) {
      const result = await read(context);
      return result.preparation === undefined || result.state === undefined
        ? undefined
        : { preparation: result.preparation, state: result.state };
    },
    async registerPendingCapture(context: HostedOperatorContext, input: NormalActorPendingCapture) {
      const pending = normalActorPendingCaptureSchema.parse(input);
      const preparation = await mutate(context, (row) => {
        const current = row.record.accountPreparation;
        const link = row.record.operator?.identityLink;
        if (current === undefined || link === undefined) {
          throw new Error("normal_actor_capture_pending_mismatch");
        }
        const actor = current.program.actors.find(
          (entry) => entry.actorKey === pending.actorKey && entry.account === "capture-existing",
        );
        const matches = [
          actor !== undefined,
          pending.organizationId === undefined ||
            current.program.memberships.some(
              (member) =>
                member.actorKey === pending.actorKey &&
                member.organizationId === pending.organizationId,
            ),
          link.consumedAt === undefined,
          link.nonceSha256 === pending.nonceSha256,
          link.ownerSessionId === context.target.sessionId,
          link.browserSession?.operationRef === current.accountOperationRef,
          link.browserSession?.participantProgramDigest === current.programDigest,
          link.bootstrapPlanDigest === current.accountPlanDigest,
          Date.parse(pending.expiresAt) > ports.now(),
          Date.parse(pending.expiresAt) <= Date.parse(link.expiresAt),
        ].every(Boolean);
        if (!matches) {
          throw new Error("normal_actor_capture_pending_mismatch");
        }
        const existing = current.pendingCaptures?.find(
          (entry) => entry.nonceSha256 === pending.nonceSha256,
        );
        if (existing !== undefined) {
          if (
            existing.actorKey !== pending.actorKey ||
            existing.organizationId !== pending.organizationId ||
            existing.expiresAt !== pending.expiresAt
          ) {
            throw new Error("normal_actor_capture_pending_mismatch");
          }
          return current;
        }
        return {
          ...current,
          pendingCaptures: [
            ...(current.pendingCaptures ?? []).filter(
              (entry) => Date.parse(entry.expiresAt) > ports.now(),
            ),
            pending,
          ],
        };
      });
      const retained = preparation.pendingCaptures?.find(
        (entry) => entry.nonceSha256 === pending.nonceSha256,
      );
      if (retained === undefined) {
        throw new Error("normal_actor_capture_pending_mismatch");
      }
      return retained;
    },
    async readPendingCapture(context: HostedOperatorContext, nonceSha256: string) {
      const current = await read(context);
      const pending = current.preparation?.pendingCaptures?.find(
        (entry) => entry.nonceSha256 === digest.parse(nonceSha256),
      );
      const link = current.row.record.operator?.identityLink;
      if (pending === undefined || link === undefined || current.preparation === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing pending correlation is an explicit optional capability result.
        return undefined;
      }
      const matches = [
        link.consumedAt === undefined,
        link.nonceSha256 === pending.nonceSha256,
        link.ownerSessionId === context.target.sessionId,
        link.browserSession?.operationRef === current.preparation.accountOperationRef,
        link.browserSession?.participantProgramDigest === current.preparation.programDigest,
        Date.parse(pending.expiresAt) > ports.now(),
        Date.parse(link.expiresAt) > ports.now(),
      ].every(Boolean);
      return matches ? pending : undefined;
    },
    async prepareOrganizationProof(
      context: HostedOperatorContext,
      input: OrganizationProofOwner & {
        binding: NormalActorOrganizationProofBinding;
        bootstrap?: CompletedParticipantBootstrap;
        assertBootstrapCurrent?: () => Promise<void>;
      },
    ) {
      if ((input.bootstrap === undefined) !== (input.assertBootstrapCurrent === undefined)) {
        throw new Error("normal_actor_organization_proof_mismatch");
      }
      // The runtime journal imports this schema; resolve its selector after module initialization.
      const bootstrapInspector =
        input.bootstrap === undefined
          ? undefined
          : await guarded(
              () => import("./hosted-operator-participant-bootstrap"),
              input.assertBootstrapCurrent,
            );
      const preparation = await mutate(
        context,
        (row) => {
          const current = row.record.accountPreparation;
          if (current === undefined) {
            throw new Error("normal_actor_journal_unavailable");
          }
          const state = decryptNormalActorState({
            ...stateScope(context, current),
            config: ports.keyring,
            sealed: current.sealedState,
          });
          assertOrganizationProofOwner(current, state, input);
          const selected =
            row.record.operator === undefined
              ? undefined
              : bootstrapInspector?.inspectPlanningParticipantBootstrap(
                  row.record.operator.plan,
                  row.record,
                );
          assertOrganizationProofBinding(current, input.binding, input.bootstrap, selected);
          const existing = current.organizationProofs?.find(
            (entry) => entry.organizationId === input.organizationId,
          );
          const changedEndpoint =
            existing !== undefined && existing.link.endpointOrigin !== input.binding.endpointOrigin;
          if (existing !== undefined) {
            const same = sameOrganizationProofBinding(existing, input);
            if (!same || (changedEndpoint && input.bootstrap === undefined)) {
              throw new Error("normal_actor_organization_proof_mismatch");
            }
            if (
              !changedEndpoint &&
              (existing.link.consumedAt !== undefined ||
                Date.parse(existing.link.expiresAt) > ports.now())
            ) {
              return current;
            }
          }
          const nonce = randomBytes(32).toString("hex");
          const expiresAt = new Date(
            Math.min(ports.now() + 240_000, Date.parse(input.owner.expiresAt)),
          ).toISOString();
          if (Date.parse(expiresAt) <= ports.now()) {
            throw new Error("normal_actor_session_required");
          }
          const { transportSource, ...linkBinding } = input.binding;
          const next = normalActorOrganizationProofSchema.parse({
            transportSource,
            ...(input.bootstrap === undefined ? {} : { bootstrap: input.bootstrap }),
            organizationId: input.organizationId,
            ownerActorKey: input.ownerActorKey,
            owner: input.owner,
            link: {
              ...linkBinding,
              organizationId: null,
              ownerSessionId: context.target.sessionId,
              nonceSha256: createHash("sha256").update(nonce).digest("hex"),
              expiresAt,
              sealedNonce: {
                ...encryptVercelToken({
                  associatedData: organizationProofAad(context, current, input),
                  key: ports.keyring.tokenKey,
                  token: nonce,
                }),
                keyVersion: ports.keyring.tokenKeyVersion,
              },
            },
          });
          return {
            ...current,
            ...(changedEndpoint && existing !== undefined
              ? {
                  supersededOrganizationProofs: [
                    ...(current.supersededOrganizationProofs ?? []),
                    existing,
                  ],
                }
              : {}),
            organizationProofs: [
              ...(current.organizationProofs ?? []).filter(
                (entry) => entry.organizationId !== input.organizationId,
              ),
              next,
            ],
          };
        },
        input.assertBootstrapCurrent,
      );
      const retained = preparation.organizationProofs?.find(
        (entry) => entry.organizationId === input.organizationId,
      );
      if (retained === undefined) {
        throw new Error("normal_actor_organization_proof_mismatch");
      }
      if (retained.link.consumedAt !== undefined) {
        return { record: retained };
      }
      if (retained.link.sealedNonce === undefined) {
        throw new Error("normal_actor_organization_proof_mismatch");
      }
      const nonce = digest.parse(
        decryptVersionedVercelToken({
          ...retained.link.sealedNonce,
          associatedData: organizationProofAad(context, preparation, retained),
          config: ports.keyring,
        }),
      );
      if (createHash("sha256").update(nonce).digest("hex") !== retained.link.nonceSha256) {
        throw new Error("normal_actor_organization_proof_mismatch");
      }
      return { record: retained, nonce };
    },
    async completeOrganizationProof(
      context: HostedOperatorContext,
      input: {
        organizationId: string;
        nonceSha256: string;
        proofRef: string;
        proofSha256: string;
        actorId: string;
        realmSessionId: string;
        capturedAt: string;
      },
    ) {
      const preparation = await mutate(context, (row) => {
        const current = row.record.accountPreparation;
        const retained = current?.organizationProofs?.find(
          (entry) => entry.organizationId === input.organizationId,
        );
        if (current === undefined || retained === undefined) {
          throw new Error("normal_actor_organization_proof_mismatch");
        }
        const state = decryptNormalActorState({
          ...stateScope(context, current),
          config: ports.keyring,
          sealed: current.sealedState,
        });
        assertOrganizationProofOwner(current, state, retained);
        const same = [
          retained.link.nonceSha256 === input.nonceSha256,
          retained.owner.actorId === input.actorId,
          retained.owner.realmSessionId === input.realmSessionId,
          input.proofRef ===
            `_protected-operator/artifacts/realm-identity-proof/${context.target.appId}/${input.proofSha256}`,
        ].every(Boolean);
        if (!same) {
          throw new Error("normal_actor_organization_proof_mismatch");
        }
        if (retained.link.consumedAt !== undefined) {
          if (
            retained.link.proofRef !== input.proofRef ||
            retained.link.proofSha256 !== input.proofSha256
          ) {
            throw new Error("normal_actor_organization_proof_mismatch");
          }
          return current;
        }
        if (
          Date.parse(input.capturedAt) > ports.now() ||
          Date.parse(retained.link.expiresAt) <= Date.parse(input.capturedAt)
        ) {
          throw new Error("normal_actor_session_required");
        }
        const next = normalActorOrganizationProofSchema.parse({
          ...retained,
          link: {
            ...retained.link,
            consumedAt: input.capturedAt,
            proofRef: input.proofRef,
            proofSha256: input.proofSha256,
          },
        });
        return {
          ...current,
          organizationProofs: current.organizationProofs?.map((entry) =>
            entry.organizationId === input.organizationId ? next : entry,
          ),
        };
      });
      const retained = preparation.organizationProofs?.find(
        (entry) => entry.organizationId === input.organizationId,
      );
      if (retained === undefined) {
        throw new Error("normal_actor_organization_proof_mismatch");
      }
      return retained;
    },
    async checkpoint(context: HostedOperatorContext, state: NormalActorState) {
      return await mutate(context, (row) => {
        const preparation = row.record.accountPreparation;
        if (preparation === undefined) {
          throw new Error("normal_actor_journal_unavailable");
        }
        const checked = assertNormalActorState(
          preparation.program,
          state,
          preparation.accountOperationRef,
        );
        assertCarriedActors(context, row, preparation, checked, ports.keyring, ports.now());
        const baseAccountsComplete = checked.actors.every(
          (actor) =>
            actor.signup === "complete" &&
            actor.session !== undefined &&
            actor.storageState !== undefined,
        );
        const organizationSessionsComplete = hasOrganizationAccountSessions(preparation, checked);
        const complete = baseAccountsComplete && organizationSessionsComplete;
        const next = {
          ...preparation,
          sealedState: encryptNormalActorState({
            ...stateScope(context, preparation),
            config: ports.keyring,
            state: checked,
          }),
          ...(complete
            ? {
                accountsCompletedAt:
                  preparation.accountsCompletedAt ?? new Date(ports.now()).toISOString(),
              }
            : {}),
        };
        if (!complete) {
          delete next.accountsCompletedAt;
        }
        return next;
      });
    },
    async authorizeCapture(
      context: HostedOperatorContext,
      input: {
        actorKey: string;
        organizationId?: string;
        nonceSha256: string;
        proofSha256: string;
        expiresAt: string;
      },
    ) {
      const preparation = await mutate(context, (row) => {
        const prior = row.record.accountPreparation;
        if (
          prior === undefined ||
          !prior.program.actors.some(
            (actor) => actor.actorKey === input.actorKey && actor.account === "capture-existing",
          ) ||
          (input.organizationId !== undefined &&
            !prior.program.memberships.some(
              (member) =>
                member.actorKey === input.actorKey &&
                member.organizationId === input.organizationId,
            ))
        ) {
          throw new Error("normal_actor_capture_unavailable");
        }
        const existing = prior.captures.find(
          (capture) => capture.nonceSha256 === input.nonceSha256,
        );
        if (existing !== undefined) {
          if (
            existing.actorKey !== input.actorKey ||
            existing.organizationId !== input.organizationId ||
            existing.proofSha256 !== input.proofSha256 ||
            Date.parse(existing.expiresAt) <= ports.now()
          ) {
            throw new Error("normal_actor_capture_unavailable");
          }
          return prior;
        }
        if (Date.parse(input.expiresAt) <= ports.now()) {
          throw new Error("normal_actor_capture_unavailable");
        }
        return { ...prior, captures: [...prior.captures, { ...input, reference: randomUUID() }] };
      });
      return captureReference(preparation, input.nonceSha256);
    },
    async capture(context: HostedOperatorContext, payloadInput: NormalActorCapturedPayload) {
      const payload = normalActorCapturedPayloadSchema.parse(payloadInput);
      const cookieDigest = normalActorCaptureCookieDigest(payload.normalCookie);
      const preparation = await mutate(context, (row) => {
        const prior = row.record.accountPreparation;
        const capture = prior?.captures.find((entry) => entry.nonceSha256 === payload.nonceSha256);
        if (
          prior === undefined ||
          capture === undefined ||
          capture.actorKey !== payload.actorKey ||
          capture.organizationId !== payload.organizationId ||
          capture.proofSha256 !== payload.proofSha256 ||
          payload.session.reference !== capture.reference ||
          Date.parse(capture.expiresAt) <= ports.now() ||
          payload.session.origin !== prior.program.origin ||
          createHash("sha256").update(payload.proof).digest("hex") !== payload.proofSha256
        ) {
          throw new Error("normal_actor_capture_unavailable");
        }
        if (capture.sealed !== undefined) {
          if (capture.normalCookieSha256 !== cookieDigest) {
            throw new Error("normal_actor_capture_unavailable");
          }
          return prior;
        }
        const sealed = {
          ...encryptVercelToken({
            associatedData: captureAad(context, prior, capture),
            key: ports.keyring.tokenKey,
            token: JSON.stringify(payload),
          }),
          keyVersion: ports.keyring.tokenKeyVersion,
        };
        return {
          ...prior,
          captures: prior.captures.map((entry) =>
            entry.reference === capture.reference
              ? { ...entry, normalCookieSha256: cookieDigest, sealed }
              : entry,
          ),
        };
      });
      return captureReference(preparation, payload.nonceSha256);
    },
    async readCapture(
      context: HostedOperatorContext,
      reference: string,
    ): Promise<NormalActorCapturedPayload | undefined> {
      const result = await read(context);
      let preparation = result.preparation;
      if (preparation?.captures.some((entry) => entry.reference === reference) !== true) {
        preparation = result.row.record.participantPreparationHistory
          ?.map((entry) => entry.preparation)
          .find((entry) => entry.captures.some((capture) => capture.reference === reference));
        if (preparation !== undefined) {
          validateProvenance(context, preparation);
          await ports.assertAccountApproval(context, provenance(preparation));
          await ports.assertAuthorized(context);
        }
      }
      const capture = preparation?.captures.find((entry) => entry.reference === reference);
      if (
        preparation === undefined ||
        capture?.sealed === undefined ||
        Date.parse(capture.expiresAt) <= ports.now()
      ) {
        return undefined;
      }
      try {
        const payload = normalActorCapturedPayloadSchema.parse(
          JSON.parse(
            decryptVersionedVercelToken({
              ...capture.sealed,
              associatedData: captureAad(context, preparation, capture),
              config: ports.keyring,
            }),
          ),
        );
        if (
          payload.actorKey !== capture.actorKey ||
          payload.organizationId !== capture.organizationId ||
          payload.nonceSha256 !== capture.nonceSha256 ||
          payload.proofSha256 !== capture.proofSha256 ||
          normalActorCaptureCookieDigest(payload.normalCookie) !== capture.normalCookieSha256
        ) {
          throw new Error("normal_actor_capture_unavailable");
        }
        return payload;
      } catch {
        throw new Error("normal_actor_capture_unavailable");
      }
    },
  };
};
export type NormalActorJournal = ReturnType<typeof createNormalActorJournal>;
