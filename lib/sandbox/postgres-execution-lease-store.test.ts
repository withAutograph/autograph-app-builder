import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { HostedPrincipal } from "../eve/hosted-auth";
import {
  parseSandboxExecutionLeaseRow,
  sandboxLeaseAdvisoryKey,
} from "./postgres-execution-lease-store";
import { sandboxExecutionPolicyDigest } from "./execution-policy";

const principal: HostedPrincipal = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace_1",
  ownerUserId: "user_1",
  scopes: ["eve:start"],
};

const lease = {
  version: 1 as const,
  principal,
  adapterSessionId: "session_1",
  providerSandboxId: "sandbox_1",
  epoch: 1,
  state: "active" as const,
  policyDigest: sandboxExecutionPolicyDigest(),
  acquiredAtEpochMs: 1_000,
  heartbeatAtEpochMs: 1_000,
  expiresAtEpochMs: 901_000,
};

const row = {
  issuer: principal.issuer,
  audience: principal.audience,
  workspaceId: principal.workspaceId,
  ownerUserId: principal.ownerUserId,
  adapterSessionId: lease.adapterSessionId,
  providerSandboxId: lease.providerSandboxId,
  epoch: lease.epoch,
  state: lease.state,
  policyDigest: lease.policyDigest,
  record: lease,
  acquiredAt: new Date(lease.acquiredAtEpochMs),
  heartbeatAt: new Date(lease.heartbeatAtEpochMs),
  expiresAt: new Date(lease.expiresAtEpochMs),
  releasedAt: null,
};

describe("PostgreSQL sandbox execution lease authority", () => {
  it("rejects drift between duplicated indexes and the closed lease", () => {
    expect(parseSandboxExecutionLeaseRow(row)).toEqual(lease);
    expect(() =>
      parseSandboxExecutionLeaseRow({
        ...row,
        providerSandboxId: "substituted",
      }),
    ).toThrow("canonically bound");
    expect(() =>
      parseSandboxExecutionLeaseRow({
        ...row,
        record: { ...lease, extraAuthority: true },
      }),
    ).toThrow();
  });

  it("uses unambiguous, NUL-free admission lock keys", () => {
    for (const scope of ["workspace", "subject"] as const) {
      const key = sandboxLeaseAdvisoryKey(scope, principal);
      expect(key).not.toContain("\0");
      expect(JSON.parse(key)).toHaveLength(scope === "workspace" ? 5 : 6);
    }
  });

  it("keeps the lease migration additive, tenant-bound, and recovery indexed", async () => {
    const migration = await readFile(
      new URL(
        "../../drizzle/0008_sandbox_execution_lease.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const required of [
      '"sandbox_execution_lease_tenant_pk"',
      '"issuer", "audience", "workspace_id", "owner_user_id", "adapter_session_id"',
      '"sandbox_execution_lease_subject_active_idx"',
      '"sandbox_execution_lease_workspace_active_idx"',
      '"sandbox_execution_lease_orphan_idx"',
      '"policy_digest" ~',
    ])
      expect(migration).toContain(required);
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/iu);
  });
});
