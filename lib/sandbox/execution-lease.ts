import { createHash } from "node:crypto";

import { z } from "zod";

import {
  hostedIdentifierSchema,
  hostedPrincipalSchema,
  tenantKeyFor,
  type HostedPrincipal,
} from "../eve/hosted-auth";
import {
  SANDBOX_EXECUTION_POLICY,
  sandboxExecutionPolicyDigest,
  type SandboxExecutionPolicy,
} from "./execution-policy";

const sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const sandboxExecutionLeaseSchema = z
  .object({
    version: z.literal(1),
    principal: hostedPrincipalSchema,
    adapterSessionId: hostedIdentifierSchema,
    providerSandboxId: hostedIdentifierSchema,
    epoch: z.number().int().positive(),
    state: z.enum(["active", "released", "orphaned"]),
    policyDigest: sha256Digest,
    acquiredAtEpochMs: z.number().int().nonnegative(),
    heartbeatAtEpochMs: z.number().int().nonnegative(),
    expiresAtEpochMs: z.number().int().positive(),
    releasedAtEpochMs: z.number().int().nonnegative().optional(),
    releaseReason: z
      .enum([
        "waiting",
        "turn-completed",
        "turn-cancelled",
        "turn-failed",
        "session-completed",
        "session-failed",
        "expired",
      ])
      .optional(),
  })
  .strict()
  .superRefine((lease, context) => {
    if (
      lease.acquiredAtEpochMs > lease.heartbeatAtEpochMs ||
      lease.heartbeatAtEpochMs >= lease.expiresAtEpochMs
    ) {
      context.addIssue({ code: "custom", message: "Invalid lease interval." });
    }
    const released =
      lease.releasedAtEpochMs !== undefined &&
      lease.releaseReason !== undefined;
    if ((lease.state === "released") !== released) {
      context.addIssue({
        code: "custom",
        message: "Lease release state is not canonical.",
      });
    }
  });

export type SandboxExecutionLease = z.infer<typeof sandboxExecutionLeaseSchema>;
export type SandboxLeaseReleaseReason = NonNullable<
  SandboxExecutionLease["releaseReason"]
>;

export type AcquireSandboxLeaseResult =
  | { disposition: "acquired" | "existing"; lease: SandboxExecutionLease }
  | { disposition: "rejected"; reason: "subject-limit" | "workspace-limit" };

export interface SandboxExecutionLeaseStore {
  acquire(input: {
    principal: HostedPrincipal;
    adapterSessionId: string;
    providerSandboxId: string;
    policy: SandboxExecutionPolicy;
    nowEpochMs: number;
  }): Promise<AcquireSandboxLeaseResult>;
  assertCurrent(input: {
    principal: HostedPrincipal;
    adapterSessionId: string;
    providerSandboxId: string;
    epoch: number;
    policyDigest: string;
    nowEpochMs: number;
  }): Promise<SandboxExecutionLease>;
  heartbeat(input: {
    principal: HostedPrincipal;
    adapterSessionId: string;
    epoch: number;
    nowEpochMs: number;
  }): Promise<SandboxExecutionLease>;
  release(input: {
    principal: HostedPrincipal;
    adapterSessionId: string;
    epoch: number;
    reason: SandboxLeaseReleaseReason;
    nowEpochMs: number;
  }): Promise<SandboxExecutionLease>;
  claimExpired(input: {
    nowEpochMs: number;
    limit: number;
  }): Promise<readonly SandboxExecutionLease[]>;
  settleRecovery(input: {
    lease: SandboxExecutionLease;
    stopped: boolean;
    nowEpochMs: number;
  }): Promise<SandboxExecutionLease>;
}

export function sandboxLeaseKey(
  principal: HostedPrincipal,
  adapterSessionId: string,
): string {
  return JSON.stringify([tenantKeyFor(principal), adapterSessionId]);
}

export function sandboxLeaseReceiptDigest(
  lease: SandboxExecutionLease,
): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sandboxExecutionLeaseSchema.parse(lease)))
    .digest("hex")}`;
}

export class InMemorySandboxExecutionLeaseStore implements SandboxExecutionLeaseStore {
  private readonly leases = new Map<string, SandboxExecutionLease>();

  async acquire(
    input: Parameters<SandboxExecutionLeaseStore["acquire"]>[0],
  ): Promise<AcquireSandboxLeaseResult> {
    const principal = hostedPrincipalSchema.parse(input.principal);
    const adapterSessionId = hostedIdentifierSchema.parse(
      input.adapterSessionId,
    );
    const providerSandboxId = hostedIdentifierSchema.parse(
      input.providerSandboxId,
    );
    const policyDigest = sandboxExecutionPolicyDigest(input.policy);
    const key = sandboxLeaseKey(principal, adapterSessionId);
    const existing = this.leases.get(key);
    if (
      existing?.state === "active" &&
      existing.expiresAtEpochMs > input.nowEpochMs
    ) {
      if (
        existing.providerSandboxId !== providerSandboxId ||
        existing.policyDigest !== policyDigest
      ) {
        throw new Error(
          "An active sandbox lease is bound to different inputs.",
        );
      }
      return { disposition: "existing", lease: structuredClone(existing) };
    }
    const active = [...this.leases.values()].filter(
      (lease) =>
        lease.state === "active" &&
        lease.expiresAtEpochMs > input.nowEpochMs &&
        lease.principal.issuer === principal.issuer &&
        lease.principal.audience === principal.audience &&
        lease.principal.workspaceId === principal.workspaceId,
    );
    if (
      active.filter(
        ({ principal: candidate }) =>
          candidate.ownerUserId === principal.ownerUserId,
      ).length >= input.policy.lease.maxActivePerSubject
    ) {
      return { disposition: "rejected", reason: "subject-limit" };
    }
    if (active.length >= input.policy.lease.maxActivePerWorkspace) {
      return { disposition: "rejected", reason: "workspace-limit" };
    }
    const lease = sandboxExecutionLeaseSchema.parse({
      version: 1,
      principal,
      adapterSessionId,
      providerSandboxId,
      epoch: (existing?.epoch ?? 0) + 1,
      state: "active",
      policyDigest,
      acquiredAtEpochMs: input.nowEpochMs,
      heartbeatAtEpochMs: input.nowEpochMs,
      expiresAtEpochMs: input.nowEpochMs + input.policy.lease.ttlMs,
    });
    this.leases.set(key, lease);
    return { disposition: "acquired", lease: structuredClone(lease) };
  }

  async assertCurrent(
    input: Parameters<SandboxExecutionLeaseStore["assertCurrent"]>[0],
  ): Promise<SandboxExecutionLease> {
    const lease = this.leases.get(
      sandboxLeaseKey(input.principal, input.adapterSessionId),
    );
    if (
      lease === undefined ||
      lease.state !== "active" ||
      lease.expiresAtEpochMs <= input.nowEpochMs ||
      lease.epoch !== input.epoch ||
      lease.providerSandboxId !== input.providerSandboxId ||
      lease.policyDigest !== input.policyDigest
    ) {
      throw new Error("The sandbox execution lease is stale or unavailable.");
    }
    return structuredClone(lease);
  }

  async heartbeat(
    input: Parameters<SandboxExecutionLeaseStore["heartbeat"]>[0],
  ): Promise<SandboxExecutionLease> {
    const key = sandboxLeaseKey(input.principal, input.adapterSessionId);
    const current = await this.assertCurrent({
      ...input,
      providerSandboxId: this.leases.get(key)?.providerSandboxId ?? "missing",
      policyDigest: this.leases.get(key)?.policyDigest ?? "sha256:missing",
    });
    const lease = sandboxExecutionLeaseSchema.parse({
      ...current,
      heartbeatAtEpochMs: input.nowEpochMs,
      expiresAtEpochMs: input.nowEpochMs + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
    });
    this.leases.set(key, lease);
    return structuredClone(lease);
  }

  async release(
    input: Parameters<SandboxExecutionLeaseStore["release"]>[0],
  ): Promise<SandboxExecutionLease> {
    const key = sandboxLeaseKey(input.principal, input.adapterSessionId);
    const current = this.leases.get(key);
    if (current === undefined || current.epoch !== input.epoch) {
      throw new Error("The sandbox execution lease epoch is stale.");
    }
    if (current.state !== "active") return structuredClone(current);
    const lease = sandboxExecutionLeaseSchema.parse({
      ...current,
      state: "released",
      releasedAtEpochMs: input.nowEpochMs,
      releaseReason: input.reason,
    });
    this.leases.set(key, lease);
    return structuredClone(lease);
  }

  async claimExpired(
    input: Parameters<SandboxExecutionLeaseStore["claimExpired"]>[0],
  ): Promise<readonly SandboxExecutionLease[]> {
    const claimed: SandboxExecutionLease[] = [];
    for (const [key, current] of [...this.leases.entries()].toSorted()) {
      if (
        claimed.length >= input.limit ||
        current.state !== "active" ||
        current.expiresAtEpochMs > input.nowEpochMs
      )
        continue;
      const lease = sandboxExecutionLeaseSchema.parse({
        ...current,
        state: "orphaned",
      });
      this.leases.set(key, lease);
      claimed.push(structuredClone(lease));
    }
    return claimed;
  }

  async settleRecovery(
    input: Parameters<SandboxExecutionLeaseStore["settleRecovery"]>[0],
  ): Promise<SandboxExecutionLease> {
    const key = sandboxLeaseKey(
      input.lease.principal,
      input.lease.adapterSessionId,
    );
    const current = this.leases.get(key);
    if (
      current === undefined ||
      current.state !== "orphaned" ||
      current.epoch !== input.lease.epoch
    )
      throw new Error("The orphan recovery claim is stale.");
    const lease = sandboxExecutionLeaseSchema.parse(
      input.stopped
        ? {
            ...current,
            state: "released",
            releasedAtEpochMs: input.nowEpochMs,
            releaseReason: "expired",
          }
        : { ...current, state: "active" },
    );
    this.leases.set(key, lease);
    return structuredClone(lease);
  }
}

export async function reconcileExpiredSandboxLeases(input: {
  store: SandboxExecutionLeaseStore;
  stopSandbox(providerSandboxId: string): Promise<void>;
  nowEpochMs: number;
  limit?: number;
}) {
  const leases = await input.store.claimExpired({
    nowEpochMs: input.nowEpochMs,
    limit: input.limit ?? 32,
  });
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const lease of leases) {
    try {
      await input.stopSandbox(lease.providerSandboxId);
      await input.store.settleRecovery({
        lease,
        stopped: true,
        nowEpochMs: input.nowEpochMs,
      });
      stopped.push(sandboxLeaseReceiptDigest(lease));
    } catch {
      await input.store.settleRecovery({
        lease,
        stopped: false,
        nowEpochMs: input.nowEpochMs,
      });
      failed.push(sandboxLeaseReceiptDigest(lease));
    }
  }
  return { claimed: leases.length, stopped, failed } as const;
}
