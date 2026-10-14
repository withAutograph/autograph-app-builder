/* oxlint-disable eslint/no-await-in-loop, sonarjs/expression-complexity -- CAS and encrypted capture require each exact approval, scope, nonce, proof and session binding. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  decryptVersionedVercelToken,
  encryptVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import {
  hostedOperatorPlanSchema,
  normalActorPreparationSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import {
  assertNormalActorState,
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
  normalActorSessionRefSchema,
} from "./hosted-operator-normal-actor-program";
import type { NormalActorState } from "./hosted-operator-normal-actor-program";
import {
  decryptNormalActorState,
  encryptNormalActorState,
  sealedNormalActorStateSchema,
} from "./hosted-operator-normal-actor-state";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import type { HostedOperatorContext } from "./hosted-operator-service";

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
export const normalActorAccountPreparationSchema = normalActorPreparationSchema.extend({
  program: normalActorProgramSchema,
  accountPlan: hostedOperatorPlanSchema,
  sealedState: sealedNormalActorStateSchema,
  captures: z.array(captureReferenceSchema),
  accountsCompletedAt: z.iso.datetime({ offset: true }).optional(),
});
export type NormalActorAccountPreparation = z.infer<typeof normalActorAccountPreparationSchema>;
export type NormalActorAccountProvenance = Omit<
  NormalActorAccountPreparation,
  "sealedState" | "captures" | "accountsCompletedAt"
>;
export const normalActorCapturedPayloadSchema = z.strictObject({
  version: z.literal(1),
  actorKey,
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
    reference: capture.reference,
    purpose: "normal-auth-capture-v1",
  });
export const normalActorCaptureCookieDigest = (
  cookie: Pick<NormalActorCaptureCookie, "name" | "value">,
) => createHash("sha256").update(`${cookie.name}=${cookie.value}`).digest("hex");

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

/** Actual owner journal CAS; raw normal sessions are decrypted only in this private capability. */
export const createNormalActorJournal = (ports: NormalActorJournalPorts) => {
  const read = async (context: HostedOperatorContext) => {
    await ports.assertAuthorized(context);
    const row = await ports.store.read(context);
    if (row === undefined) {
      throw new Error("normal_actor_journal_unavailable");
    }
    const preparation = row.record.accountPreparation;
    if (preparation === undefined) {
      return { row, preparation: undefined, state: undefined };
    }
    validateProvenance(context, preparation);
    await ports.assertAccountApproval(context, provenance(preparation));
    const state = decryptNormalActorState({
      ...stateScope(context, preparation),
      config: ports.keyring,
      sealed: preparation.sealedState,
    });
    await ports.assertAuthorized(context);
    const latest = await ports.store.read(context);
    if (latest?.revision !== row.revision) {
      throw new Error("normal_actor_journal_changed");
    }
    return { row, preparation, state };
  };
  const mutate = async (
    context: HostedOperatorContext,
    change: (row: HostedRuntimeJournalRow) => NormalActorAccountPreparation,
  ) => {
    for (;;) {
      const { row } = await read(context);
      await ports.assertMutationAuthority(context, row);
      const preparation = normalActorAccountPreparationSchema.parse(change(row));
      validateProvenance(context, preparation);
      await ports.assertAccountApproval(context, provenance(preparation));
      await ports.assertAuthorized(context);
      await ports.assertMutationAuthority(context, row);
      if (JSON.stringify(preparation) === JSON.stringify(row.record.accountPreparation)) {
        const latest = await ports.store.read(context);
        if (latest?.revision === row.revision) {
          return preparation;
        }
        continue;
      }
      const saved = await ports.store.compareAndSet({
        ...context,
        record: { ...row.record, accountPreparation: preparation },
        expectedRevision: row.revision,
        now: new Date(ports.now()),
      });
      if (saved !== undefined) {
        return preparation;
      }
    }
  };
  return {
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
        const complete = checked.actors.every(
          (actor) =>
            actor.signup === "complete" &&
            actor.session !== undefined &&
            actor.storageState !== undefined,
        );
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
      input: { actorKey: string; nonceSha256: string; proofSha256: string; expiresAt: string },
    ) {
      const preparation = await mutate(context, (row) => {
        const prior = row.record.accountPreparation;
        if (
          prior === undefined ||
          !prior.program.actors.some(
            (actor) => actor.actorKey === input.actorKey && actor.account === "capture-existing",
          )
        ) {
          throw new Error("normal_actor_capture_unavailable");
        }
        const existing = prior.captures.find(
          (capture) => capture.nonceSha256 === input.nonceSha256,
        );
        if (existing !== undefined) {
          if (
            existing.actorKey !== input.actorKey ||
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
      const { preparation } = result;
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
