import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { HostedPrincipal } from "../eve/hosted-auth";
import { sandboxExecutionPolicyDigest } from "./execution-policy";
import {
  parseSandboxExecutionLeaseRow,
  sandboxLeaseAdvisoryKey,
} from "./postgres-execution-lease-store";

const principal: HostedPrincipal = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user_1",
  scopes: ["eve:start"],
  workspaceId: "workspace_1",
};

const lease = {
  acquiredAtEpochMs: 1_000,
  adapterSessionId: "session_1",
  epoch: 1,
  expiresAtEpochMs: 901_000,
  heartbeatAtEpochMs: 1_000,
  policyDigest: sandboxExecutionPolicyDigest(),
  principal,
  providerSandboxId: "sandbox_1",
  state: "active" as const,
  version: 1 as const,
};

const row = {
  acquiredAt: new Date(lease.acquiredAtEpochMs),
  adapterSessionId: lease.adapterSessionId,
  audience: principal.audience,
  epoch: lease.epoch,
  expiresAt: new Date(lease.expiresAtEpochMs),
  heartbeatAt: new Date(lease.heartbeatAtEpochMs),
  issuer: principal.issuer,
  ownerUserId: principal.ownerUserId,
  policyDigest: lease.policyDigest,
  providerSandboxId: lease.providerSandboxId,
  record: lease,
  releasedAt: null,
  state: lease.state,
  workspaceId: principal.workspaceId,
};

describe("PostgreSQL sandbox execution lease authority", () => {
  it("rejects drift between duplicated indexes and the closed lease", () => {
    expect(parseSandboxExecutionLeaseRow(row)).toEqual(lease);
    expect(() =>
      parseSandboxExecutionLeaseRow({
        ...row,
        providerSandboxId: "substituted",
      })
    ).toThrow("canonically bound");
    expect(() =>
      parseSandboxExecutionLeaseRow({
        ...row,
        record: { ...lease, extraAuthority: true },
      })
    ).toThrow();
  });

  it("uses an unambiguous, NUL-free exact-session lock key", () => {
    const key = sandboxLeaseAdvisoryKey(principal, "session_1");
    expect(key).not.toContain("\0");
    expect(JSON.parse(key)).toEqual([
      "sandbox_execution_lease_v1",
      "session",
      principal.issuer,
      principal.audience,
      principal.workspaceId,
      principal.ownerUserId,
      "session_1",
    ]);
  });

  it("keeps the lease migration additive, tenant-bound, and recovery indexed", async () => {
    const migration = await readFile(
      new URL(
        "../../drizzle/0008_sandbox_execution_lease.sql",
        import.meta.url
      ),
      "utf-8"
    );
    for (const required of [
      '"sandbox_execution_lease_tenant_pk"',
      '"issuer", "audience", "workspace_id", "owner_user_id", "adapter_session_id"',
      '"sandbox_execution_lease_subject_active_idx"',
      '"sandbox_execution_lease_workspace_active_idx"',
      '"sandbox_execution_lease_orphan_idx"',
      '"policy_digest" ~',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/iu);
  });
});
