/* oxlint-disable sonarjs/no-duplicate-string -- Closed journal kinds and stages are protocol values, kept literal at transitions. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppAccessError } from "../app-access/errors";
import {
  repositoryProductionDigest,
  repositoryProductionOperationRef,
  repositoryProductionScopeSchema,
} from "./repository-production-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import { repositoryProductionSignupPolicySchema } from "./repository-production-signup-policy";
import type {
  RepositoryProductionEffectContext,
  RepositoryProductionSetupPorts,
} from "./repository-production-setup";
import type { createRepositoryProductionWorkers } from "./repository-production-workers";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const recordedGrant = z.strictObject({
  operationRef: z.uuid(),
  fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const repositoryProductionSignupClaimSchema = z.object({
  id: z.uuid(),
  policyId: z.uuid(),
  policyDigest: hash,
  scopeDigest: hash,
  workspaceId: z.string().min(1),
  resourceDigest: hash,
  appId: z.string().min(1),
  organizationId: z.string().min(1),
  actorId: z.string().min(1),
  appRoles: z.array(z.string()),
  returnUrl: z.url(),
  status: z.enum(["verified", "applied", "rejected"]),
  sessionId: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  accessState: z.enum(["absent", "active", "revoked", "changed"]),
  memberPrepared: z.boolean(),
  grantReserved: z.boolean().optional(),
  recordedGrant: recordedGrant.optional(),
  accessRevocation: z
    .strictObject({ fenceGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
    .optional(),
});
export type RepositoryProductionSignupClaim = z.infer<typeof repositoryProductionSignupClaimSchema>;
const retainedClaim = repositoryProductionSignupClaimSchema.omit({
  status: true,
  accessState: true,
  memberPrepared: true,
  grantReserved: true,
  recordedGrant: true,
  accessRevocation: true,
});
const signupStage = z.enum([
  "registered",
  "prepared",
  "grant-pending",
  "granted",
  "applied",
  "cancel-pending",
  "rejected",
]);
export const repositoryProductionSignupRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("repository-production-signup-v1"),
  scope: repositoryProductionScopeSchema,
  claim: retainedClaim,
  stage: signupStage,
  workerCheckpoints: z.array(z.json()),
  cancellation: z
    .strictObject({
      operationRef: z.uuid(),
      actorId: z.string().min(1),
      scopeDigest: hash,
      roles: z.array(z.string()),
    })
    .optional(),
  renewals: z
    .array(
      z.strictObject({
        claim: retainedClaim,
        stage: signupStage,
        workerCheckpoints: z.array(z.json()),
      }),
    )
    .optional(),
});
export type RepositoryProductionSignupRecord = z.infer<
  typeof repositoryProductionSignupRecordSchema
>;
export interface RepositoryProductionSignupRow {
  operationRef: string;
  revision: number;
  record: RepositoryProductionSignupRecord;
}
export interface RepositoryProductionSignupStore {
  read: (
    scope: RepositoryProductionScope,
    claimId: string,
  ) => Promise<RepositoryProductionSignupRow | undefined>;
  reserve: (record: RepositoryProductionSignupRecord) => Promise<RepositoryProductionSignupRow>;
  compareAndSet: (
    row: RepositoryProductionSignupRow,
    record: RepositoryProductionSignupRecord,
  ) => Promise<RepositoryProductionSignupRow | undefined>;
  renew: (
    row: RepositoryProductionSignupRow,
    claim: RepositoryProductionSignupClaim,
  ) => Promise<RepositoryProductionSignupRow | undefined>;
  pending: (scope: RepositoryProductionScope) => Promise<RepositoryProductionSignupRow[]>;
}
export const repositoryProductionSignupOperationRef = (
  policyId: string,
  claimId: string,
  step = "claim",
) => {
  const hex = repositoryProductionDigest({
    kind: "repository-production-signup-v1",
    policyId,
    claimId,
    step,
  });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
type Json = z.infer<ReturnType<typeof z.json>>;
type Workers = Pick<
  ReturnType<typeof createRepositoryProductionWorkers>,
  "invokeAuthManagement" | "mutateAppAccess" | "inspectAppAccess"
>;
export interface RepositoryProductionSignupPorts {
  journal: RepositoryProductionSignupStore;
  withLease: RepositoryProductionSetupPorts["withLease"];
  readSetup: (scope: RepositoryProductionScope) => Promise<RepositoryProductionRow | undefined>;
  workers: (scope: RepositoryProductionScope) => Workers;
  realm: (scope: RepositoryProductionScope) => Json;
  builderOrigin: string;
  assertNoConflictingAccess: (scope: RepositoryProductionScope) => Promise<void>;
}
const immutableClaim = (claim: RepositoryProductionSignupClaim) =>
  repositoryProductionSignupRecordSchema.shape.claim.parse(claim);
const denied = () => new AppAccessError("app_access_denied");
const unusable = (claim: RepositoryProductionSignupClaim) =>
  claim.status === "rejected" || claim.accessState === "revoked" || claim.accessState === "changed";
const claimIdentity = (claim: RepositoryProductionSignupRecord["claim"]) => ({
  id: claim.id,
  policyId: claim.policyId,
  workspaceId: claim.workspaceId,
  resourceDigest: claim.resourceDigest,
  appId: claim.appId,
  organizationId: claim.organizationId,
  actorId: claim.actorId,
});
/** Older worker responses cannot prove that no protected grant was reserved. */
export const repositoryProductionSignupNeverGranted = (claim: RepositoryProductionSignupClaim) =>
  claim.grantReserved === false && claim.accessState === "absent";
export const repositoryProductionSignupCanRenew = (
  record: RepositoryProductionSignupRecord,
  claim: RepositoryProductionSignupClaim,
) => {
  if (record.cancellation !== undefined) {
    return false;
  }
  if (
    claim.status !== "verified" ||
    !repositoryProductionSignupNeverGranted(claim) ||
    record.stage === "granted" ||
    record.stage === "applied"
  ) {
    return false;
  }
  if (
    !isDeepStrictEqual(claimIdentity(record.claim), claimIdentity(claim)) ||
    record.claim.scopeDigest === claim.scopeDigest
  ) {
    return false;
  }
  return !(record.renewals ?? []).some(
    (previous) => previous.claim.scopeDigest === claim.scopeDigest,
  );
};
export const renewedRepositoryProductionSignupRecord = (
  record: RepositoryProductionSignupRecord,
  claim: RepositoryProductionSignupClaim,
): RepositoryProductionSignupRecord => {
  if (!repositoryProductionSignupCanRenew(record, claim)) {
    throw denied();
  }
  return {
    ...record,
    claim: immutableClaim(claim),
    stage: "registered",
    workerCheckpoints: [],
    renewals: [
      ...(record.renewals ?? []),
      { claim: record.claim, stage: record.stage, workerCheckpoints: record.workerCheckpoints },
    ],
  };
};
export const repositoryProductionSignupStepOperationRef = (
  record: RepositoryProductionSignupRecord,
  step: string,
) =>
  repositoryProductionSignupOperationRef(
    record.claim.policyId,
    record.claim.id,
    (record.renewals?.length ?? 0) > 0 ? `${step}:${record.claim.scopeDigest}` : step,
  );
const ownsRecordedGrant = (
  row: RepositoryProductionSignupRow,
  claim: RepositoryProductionSignupClaim,
) =>
  claim.grantReserved === true &&
  claim.accessState === "active" &&
  claim.recordedGrant?.operationRef ===
    repositoryProductionSignupStepOperationRef(row.record, "grant");

class SignupCompletion {
  private row: RepositoryProductionSignupRow | undefined;
  private readonly policyId: string;
  private readonly ports: RepositoryProductionSignupPorts;
  private readonly scope: RepositoryProductionScope;
  private readonly claimId: string;
  private readonly assertFence: () => Promise<void>;
  constructor(
    ports: RepositoryProductionSignupPorts,
    scope: RepositoryProductionScope,
    claimId: string,
    assertFence: () => Promise<void>,
  ) {
    this.ports = ports;
    this.scope = scope;
    this.claimId = claimId;
    this.assertFence = assertFence;
    this.policyId = repositoryProductionOperationRef(scope);
  }

  private async assertCurrent() {
    await this.assertFence();
    await this.ports.assertNoConflictingAccess(this.scope);
  }
  private async save(stage: RepositoryProductionSignupRecord["stage"], checkpoint?: Json) {
    await this.assertCurrent();
    if (!this.row) {
      throw denied();
    }
    const next = await this.ports.journal.compareAndSet(this.row, {
      ...this.row.record,
      stage,
      workerCheckpoints:
        checkpoint === undefined
          ? this.row.record.workerCheckpoints
          : [...this.row.record.workerCheckpoints, checkpoint],
    });
    if (!next) {
      throw new Error("repository_production_signup_conflict");
    }
    this.row = next;
  }
  private async context(step: string): Promise<RepositoryProductionEffectContext> {
    await this.assertCurrent();
    const setup = await this.ports.readSetup(this.scope);
    if (!setup?.record.lease || setup.record.effects["signup-policy"].state !== "applied") {
      throw denied();
    }
    const retained = this.row?.record;
    const id = retained
      ? repositoryProductionSignupStepOperationRef(retained, step)
      : repositoryProductionSignupOperationRef(this.policyId, this.claimId, step);
    return {
      row: {
        ...setup,
        operationRef: id,
        record: {
          ...setup.record,
          workerCheckpoints: this.row?.record.workerCheckpoints ?? [],
          effects: {
            ...setup.record.effects,
            "creator-access": { state: "pending", attemptId: id },
          },
        },
      },
      effect: "creator-access",
      // oxlint-disable-next-line typescript/promise-function-async -- Retain the current lease promise and its synchronous exception behavior.
      assertCurrent: () => this.assertCurrent(),
      checkpoint: async (value) => {
        if (!this.row) {
          throw denied();
        }
        await this.save(this.row.record.stage, value);
      },
    };
  }
  private async auth(request: Json, readOnly: boolean, step: string) {
    const result = await this.ports.workers(this.scope).invokeAuthManagement(
      await this.context(step),
      {
        version: 1,
        realm: this.ports.realm(this.scope),
        builderOrigin: this.ports.builderOrigin,
        scope: { appId: this.scope.appId, organizationId: this.scope.organizationId },
        request,
      },
      readOnly,
    );
    await this.assertCurrent();
    return z.object({ result: z.json() }).parse(result).result;
  }
  private async readClaim(allowReservedReadback = false) {
    const parsed = repositoryProductionSignupClaimSchema.safeParse(
      await this.auth(
        { action: "read-signup", policyId: this.policyId, claimId: this.claimId },
        true,
        "read",
      ),
    );
    if (!parsed.success) {
      throw denied();
    }
    const claim = parsed.data;
    if (claim.id !== this.claimId || claim.policyId !== this.policyId) {
      throw denied();
    }
    if (
      claim.workspaceId !== this.scope.authority.workspaceId ||
      claim.appId !== this.scope.appId ||
      claim.organizationId !== this.scope.organizationId
    ) {
      throw denied();
    }
    if (this.row && !isDeepStrictEqual(this.row.record.claim, immutableClaim(claim))) {
      if (!repositoryProductionSignupCanRenew(this.row.record, claim)) {
        throw denied();
      }
      await this.validatePolicy(claim);
      await this.assertCurrent();
      const renewed = await this.ports.journal.renew(this.row, claim);
      if (!renewed) {
        throw new Error("repository_production_signup_conflict");
      }
      this.row = renewed;
      await this.assertCurrent();
    }
    if (this.row?.record.stage === "rejected" || this.row?.record.stage === "cancel-pending") {
      throw denied();
    }
    if (unusable(claim) && !(allowReservedReadback && claim.grantReserved !== false)) {
      if (
        this.row &&
        !(this.row.record.stage === "grant-pending" && claim.grantReserved !== false)
      ) {
        await this.save("rejected");
      }
      throw denied();
    }
    return claim;
  }
  private async validatePolicy(claim: RepositoryProductionSignupClaim) {
    const setup = await this.ports.readSetup(this.scope);
    const policy = repositoryProductionSignupPolicySchema.parse(
      setup?.record.effects["signup-policy"].receipt,
    );
    if (
      !policy.enabled ||
      policy.policyId !== this.policyId ||
      claim.policyDigest !== policy.policyDigest ||
      claim.resourceDigest !== policy.resourceDigest
    ) {
      throw denied();
    }
    if (
      !isDeepStrictEqual(claim.appRoles, policy.appRoles) ||
      claim.returnUrl !== new URL(policy.appPath, this.scope.publicOrigin).toString()
    ) {
      throw denied();
    }
  }
  private async register(claim: RepositoryProductionSignupClaim) {
    await this.validatePolicy(claim);
    if (!this.row) {
      if (claim.accessState !== "absent") {
        throw denied();
      }
      this.row = await this.ports.journal.reserve({
        version: 1,
        kind: "repository-production-signup-v1",
        scope: this.scope,
        claim: immutableClaim(claim),
        stage: "registered",
        workerCheckpoints: [],
      });
    }
  }
  private proof(claim: RepositoryProductionSignupClaim) {
    return { policyId: this.policyId, claimId: this.claimId, scopeDigest: claim.scopeDigest };
  }
  private request(claim: RepositoryProductionSignupClaim) {
    return { ...this.proof(claim), actorId: claim.actorId };
  }
  private async prepareMember(claim: RepositoryProductionSignupClaim) {
    if (this.row?.record.stage !== "registered") {
      return true;
    }
    if (claim.accessState !== "absent") {
      throw denied();
    }
    if (!claim.memberPrepared) {
      await this.auth({ action: "prepare-signup-member", ...this.request(claim) }, false, "member");
    }
    const observed = await this.readClaim();
    if (
      observed.status !== "verified" ||
      !observed.memberPrepared ||
      observed.accessState !== "absent"
    ) {
      return false;
    }
    await this.save("prepared");
    return true;
  }
  private access(claim: RepositoryProductionSignupClaim) {
    return {
      actorId: claim.actorId,
      roles: claim.appRoles,
      active: true,
      signupClaim: this.proof(claim),
    };
  }
  private async inspect(claim: RepositoryProductionSignupClaim) {
    const latest = await this.readClaim();
    if (latest.scopeDigest !== claim.scopeDigest) {
      return "unknown";
    }
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Read current claim authority before constructing a grant context.
    const context = await this.context("grant");
    if (context.row.record.intent.storage.kind === "none") {
      return latest.accessState === "active" ? "applied" : "not-applied";
    }
    const observed = await this.ports
      .workers(this.scope)
      .inspectAppAccess(context, this.access(claim));
    return observed.state;
  }
  private async observeRecordedGrant(claim: RepositoryProductionSignupClaim) {
    const observed = claim.recordedGrant;
    if (!this.row || !observed || claim.accessState !== "active") {
      return false;
    }
    if (!ownsRecordedGrant(this.row, claim)) {
      throw denied();
    }
    const context = await this.context("observe-grant");
    if (context.row.record.intent.storage.kind === "postgres") {
      const result = await this.ports.workers(this.scope).inspectAppAccess(context, {
        ...this.access(claim),
        signupGrantReadback: observed,
      });
      await this.assertCurrent();
      if (result.state !== "applied") {
        return false;
      }
    }
    const checkpoint = {
      kind: "signup-recorded-grant",
      ...observed,
      scopeDigest: claim.scopeDigest,
    };
    if (
      this.row.record.stage !== "applied" ||
      !this.row.record.workerCheckpoints.some((previous) => isDeepStrictEqual(previous, checkpoint))
    ) {
      await this.save("applied", checkpoint);
    }
    return true;
  }
  private async grant(claim: RepositoryProductionSignupClaim) {
    if (this.row?.record.stage !== "prepared" && this.row?.record.stage !== "grant-pending") {
      return;
    }
    let state = await this.inspect(claim);
    if (state === "unknown") {
      return;
    }
    if (state === "not-applied") {
      await this.save("grant-pending");
      const context = await this.context("grant");
      const access = this.access(claim);
      await (context.row.record.intent.storage.kind === "none"
        ? this.auth({ action: "set-access", ...access }, false, "grant")
        : this.ports.workers(this.scope).mutateAppAccess(context, access));
      state = await this.inspect(claim);
    }
    if (state === "applied") {
      await this.save("granted");
    }
  }
  async run(): Promise<"ready" | "pending"> {
    this.row = await this.ports.journal.read(this.scope, this.claimId);
    let claim = await this.readClaim(true);
    if (this.row && claim.recordedGrant) {
      if (await this.observeRecordedGrant(claim)) {
        return "ready";
      }
      if (claim.status === "applied") {
        return "pending";
      }
    }
    if (unusable(claim)) {
      if (
        (this.row?.record.stage === "grant-pending" || this.row?.record.stage === "granted") &&
        claim.grantReserved !== false
      ) {
        return "pending";
      }
      if (this.row) {
        await this.save("rejected");
      }
      throw denied();
    }
    if (claim.status === "applied") {
      if (!this.row || claim.accessState !== "active") {
        throw denied();
      }
      await this.save("applied");
      return "ready";
    }
    await this.register(claim);
    if (!(await this.prepareMember(claim))) {
      return "pending";
    }
    claim = await this.readClaim();
    await this.grant(claim);
    if (this.row?.record.stage !== "granted") {
      return "pending";
    }
    await this.auth({ action: "complete-signup", ...this.request(claim) }, false, "complete");
    const observed = await this.readClaim();
    if (observed.status !== "applied" || observed.accessState !== "active") {
      return "pending";
    }
    await this.save("applied");
    return "ready";
  }
}

/** A verified claim has its own durable steps under the ordinary app lock and approved setup. */
export const createRepositoryProductionSignup = (ports: RepositoryProductionSignupPorts) => ({
  complete: async (
    scope: RepositoryProductionScope,
    claimId: string,
  ): Promise<"ready" | "pending"> =>
    await ports.withLease(
      scope,
      async (assertFence) => await new SignupCompletion(ports, scope, claimId, assertFence).run(),
    ),
});

/** Read-only settlement check before a different app operation; only an unresolved grant blocks it. */
export const assertNoUnresolvedRepositoryProductionSignup = async (
  rows: readonly RepositoryProductionSignupRow[],
  readClaim: (row: RepositoryProductionSignupRow) => Promise<Json>,
  observeRecorded?: (
    row: RepositoryProductionSignupRow,
    claim: RepositoryProductionSignupClaim,
  ) => Promise<boolean>,
) => {
  const results = await Promise.allSettled(
    rows.map(async (row) => {
      if (row.record.stage === "cancel-pending") {
        throw new Error("repository_production_signup_reconciliation_required");
      }
      if (row.record.stage !== "grant-pending") {
        return;
      }
      const claim = repositoryProductionSignupClaimSchema.parse(await readClaim(row));
      if (
        repositoryProductionSignupNeverGranted(claim) &&
        isDeepStrictEqual(claimIdentity(claim), claimIdentity(row.record.claim))
      ) {
        return;
      }
      if (!isDeepStrictEqual(immutableClaim(claim), row.record.claim)) {
        throw denied();
      }
      if (ownsRecordedGrant(row, claim) && observeRecorded && (await observeRecorded(row, claim))) {
        return;
      }
      if (claim.recordedGrant !== undefined) {
        throw new Error("repository_production_signup_reconciliation_required");
      }
      if (claim.status !== "applied" || claim.accessState !== "active") {
        throw new Error("repository_production_signup_reconciliation_required");
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
};
