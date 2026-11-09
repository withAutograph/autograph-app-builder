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
});
export type RepositoryProductionSignupClaim = z.infer<typeof repositoryProductionSignupClaimSchema>;
export const repositoryProductionSignupRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("repository-production-signup-v1"),
  scope: repositoryProductionScopeSchema,
  claim: repositoryProductionSignupClaimSchema.omit({
    status: true,
    accessState: true,
    memberPrepared: true,
  }),
  stage: z.enum(["registered", "prepared", "grant-pending", "granted", "applied", "rejected"]),
  workerCheckpoints: z.array(z.json()),
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
    const id = repositoryProductionSignupOperationRef(this.policyId, this.claimId, step);
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
  private async readClaim() {
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
      throw denied();
    }
    if (unusable(claim)) {
      if (this.row && this.row.record.stage !== "rejected") {
        await this.save("rejected");
      }
      throw denied();
    }
    return claim;
  }
  private async register(claim: RepositoryProductionSignupClaim) {
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
    if (this.row?.record.stage === "rejected") {
      throw denied();
    }
    const claim = await this.readClaim();
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
) => {
  await Promise.all(
    rows.map(async (row) => {
      if (row.record.stage !== "grant-pending") {
        return;
      }
      const claim = repositoryProductionSignupClaimSchema.parse(await readClaim(row));
      if (!isDeepStrictEqual(immutableClaim(claim), row.record.claim)) {
        throw denied();
      }
      if (claim.status === "rejected") {
        return;
      }
      if (claim.status !== "applied" || claim.accessState !== "active") {
        throw new Error("repository_production_signup_reconciliation_required");
      }
    }),
  );
};
