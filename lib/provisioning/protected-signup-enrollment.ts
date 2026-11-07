import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { BuilderProvisionAuthority } from "./journal";

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const signupEnrollmentScopeSchema = z.strictObject({
  authResourceId: id,
  appResourceId: id,
  appId: id,
  organizationId: id,
  actorId: id,
});

export const signupEnrollmentPolicySchema = z.strictObject({
  policyDigest: digest,
  policyId: id,
  operationRef: z.uuid(),
  planDigest: digest,
  roles: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u)),
});

export const signupEnrollmentRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("protected-signup-enrollment"),
  scope: signupEnrollmentScopeSchema,
  policy: signupEnrollmentPolicySchema,
  generation: z.number().int().positive(),
  state: z.enum(["pending", "granted", "revoked"]),
  lease: z.strictObject({ id: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) }).optional(),
});

export type SignupEnrollmentScope = z.infer<typeof signupEnrollmentScopeSchema>;
export type SignupEnrollmentPolicy = z.infer<typeof signupEnrollmentPolicySchema>;
export type SignupEnrollmentRecord = z.infer<typeof signupEnrollmentRecordSchema>;
interface SignupEnrollmentKey {
  authority: BuilderProvisionAuthority;
  scope: SignupEnrollmentScope;
}
interface SignupEnrollmentRow {
  record: SignupEnrollmentRecord;
  revision: number;
}

export const signupEnrollmentIdentity = (scope: SignupEnrollmentScope) => {
  const canonical = signupEnrollmentScopeSchema.parse(scope);
  const sha256 = createHash("sha256")
    .update(JSON.stringify(["protected-signup-enrollment-v1", canonical]))
    .digest("hex");
  const requestId = `${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-8${sha256.slice(13, 16)}-8${sha256.slice(17, 20)}-${sha256.slice(20, 32)}`;
  return { requestId, digest: sha256 };
};

export interface SignupEnrollmentStore {
  read: (key: SignupEnrollmentKey) => Promise<SignupEnrollmentRow | undefined>;
  reserve: (
    input: SignupEnrollmentKey & { policy: SignupEnrollmentPolicy; now: Date },
  ) => Promise<SignupEnrollmentRow>;
  compareAndSet: (
    input: SignupEnrollmentKey & {
      expectedRevision: number;
      record: SignupEnrollmentRecord;
      now: Date;
    },
  ) => Promise<SignupEnrollmentRow | undefined>;
}

type SignupAccessObservation = "granted" | "applicable" | "revoked" | "unknown";

export interface SignupEnrollmentAccess {
  /** Verify both stores and the exact generation. Revocation and a conflicting generation are never applicable. */
  inspect: (record: SignupEnrollmentRecord) => Promise<SignupAccessObservation>;
  /** Use the protected installer under the existing physical resource lease. */
  grant: (record: SignupEnrollmentRecord, assertCurrent: () => Promise<void>) => Promise<void>;
}

const samePolicy = (a: SignupEnrollmentPolicy, b: SignupEnrollmentPolicy) => {
  if (
    a.roles.length !== b.roles.length ||
    !a.roles.every((role, index) => role === b.roles[index])
  ) {
    return false;
  }
  return [
    a.policyDigest === b.policyDigest,
    a.policyId === b.policyId,
    a.operationRef === b.operationRef,
    a.planDigest === b.planDigest,
  ].every(Boolean);
};

/** Called only after trusted runtime identity and current installed policy have been verified. */
export const continueProtectedSignupEnrollment = async (input: {
  key: SignupEnrollmentKey;
  policy: SignupEnrollmentPolicy;
  store: SignupEnrollmentStore;
  access: SignupEnrollmentAccess;
  assertPolicyCurrent: () => Promise<void>;
  now?: () => Date;
}): Promise<"ready" | "pending" | "blocked"> => {
  const { key, store, access } = input;
  const now = input.now ?? (() => new Date());
  const policy = signupEnrollmentPolicySchema.parse(input.policy);
  await input.assertPolicyCurrent();
  const row = (await store.read(key)) ?? (await store.reserve({ ...key, policy, now: now() }));
  if (!samePolicy(row.record.policy, policy) || row.record.state === "revoked") {
    return "blocked";
  }
  const scope = signupEnrollmentIdentity(key.scope);
  if (signupEnrollmentIdentity(row.record.scope).digest !== scope.digest) {
    return "blocked";
  }

  // The one generation is durable, including when the worker returns no outcome.
  // A previously granted enrollment cannot be used as authority to grant again.
  if (row.record.state === "granted") {
    const observation = await access.inspect(row.record);
    await input.assertPolicyCurrent();
    if (observation === "granted") {
      return "ready";
    }
    return observation === "unknown" ? "pending" : "blocked";
  }

  const startedAt = now();
  if (
    row.record.lease !== undefined &&
    Date.parse(row.record.lease.expiresAt) > startedAt.getTime()
  ) {
    return "pending";
  }
  const lease = {
    id: randomUUID(),
    expiresAt: new Date(startedAt.getTime() + 120_000).toISOString(),
  };
  const leased = await store.compareAndSet({
    ...key,
    expectedRevision: row.revision,
    record: { ...row.record, lease },
    now: startedAt,
  });
  if (leased === undefined) {
    return "pending";
  }

  const assertCurrent = async () => {
    await input.assertPolicyCurrent();
    const current = await store.read(key);
    if (
      current?.revision !== leased.revision ||
      current.record.state !== "pending" ||
      current.record.lease?.id !== lease.id ||
      Date.parse(lease.expiresAt) <= now().getTime()
    ) {
      throw new Error("Signup enrollment lease is no longer current.");
    }
  };
  let state: SignupEnrollmentRecord["state"] = "pending";
  try {
    await assertCurrent();
    let observation = await access.inspect(leased.record);
    if (observation === "applicable") {
      await assertCurrent();
      await access.grant(leased.record, assertCurrent);
      observation = await access.inspect(leased.record);
    }
    await assertCurrent();
    if (observation === "granted") {
      state = "granted";
    }
    if (observation === "revoked") {
      state = "revoked";
    }
  } catch {
    // Unknown worker results never become success, a new generation, or an immediate replay.
    return "pending";
  }

  const settled = await store.compareAndSet({
    ...key,
    expectedRevision: leased.revision,
    record: {
      version: leased.record.version,
      kind: leased.record.kind,
      scope: leased.record.scope,
      policy: leased.record.policy,
      generation: leased.record.generation,
      state,
    },
    now: now(),
  });
  if (settled === undefined) {
    return "pending";
  }
  if (state === "granted") {
    return "ready";
  }
  return state === "revoked" ? "blocked" : "pending";
};
