import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { hostedEveOperationScopes, type HostedPrincipal } from "./hosted-auth";
import {
  parseHostedOperationRow,
  parseHostedSessionRow,
} from "./postgres-hosted-store";

const principal: HostedPrincipal = {
  issuer: "https://identity.example.test",
  audience: "eve-hosted",
  workspaceId: "workspace_1",
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
};

const operationRecord = {
  version: 1 as const,
  operationId: "operation_1",
  principal,
  kind: "start" as const,
  clientRequestId: "request_1",
  requestDigest: `sha256:${"a".repeat(64)}`,
  state: "reserved" as const,
  createdAtEpochMs: 1_000,
  updatedAtEpochMs: 1_000,
};

const operationRow = {
  issuer: principal.issuer,
  audience: principal.audience,
  workspaceId: principal.workspaceId,
  ownerUserId: principal.ownerUserId,
  operationId: operationRecord.operationId,
  sessionId: null,
  kind: operationRecord.kind,
  clientRequestId: operationRecord.clientRequestId,
  requestDigest: operationRecord.requestDigest,
  state: operationRecord.state,
  record: operationRecord,
  createdAt: new Date(1_000),
  updatedAt: new Date(1_000),
};

const sessionRecord = {
  version: 1 as const,
  sessionId: "session_1",
  principal,
  adapterSessionId: "adapter_1",
  status: "waiting" as const,
  createdAtEpochMs: 2_000,
  updatedAtEpochMs: 2_000,
};

const sessionRow = {
  issuer: principal.issuer,
  audience: principal.audience,
  workspaceId: principal.workspaceId,
  ownerUserId: principal.ownerUserId,
  sessionId: sessionRecord.sessionId,
  adapterSessionId: sessionRecord.adapterSessionId,
  adapterGeneration: null,
  title: null,
  stage: null,
  resumabilityState: null,
  checkpointDigest: null,
  checkpointProgressDigest: null,
  parentSessionId: null,
  lastProgressAt: null,
  record: sessionRecord,
  createdAt: new Date(2_000),
  updatedAt: new Date(2_000),
};

describe("PostgreSQL hosted Eve row authority", () => {
  it("accepts only an operation whose indexed authority matches its closed record", () => {
    expect(parseHostedOperationRow(operationRow)).toEqual(operationRecord);
    expect(() =>
      parseHostedOperationRow({ ...operationRow, workspaceId: "workspace_2" }),
    ).toThrow("canonically bound");
    expect(() =>
      parseHostedOperationRow({
        ...operationRow,
        record: { ...operationRecord, untrustedRole: "admin" },
      }),
    ).toThrow();
  });

  it("accepts only a session whose tenant and adapter index match its record", () => {
    expect(parseHostedSessionRow(sessionRow)).toEqual(sessionRecord);
    expect(() =>
      parseHostedSessionRow({ ...sessionRow, adapterSessionId: "substituted" }),
    ).toThrow("canonically bound");
  });

  it("keeps the checked-in migration tenant scoped and idempotency bound", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0001_hosted_eve_bridge.sql", import.meta.url),
      "utf8",
    );
    for (const required of [
      '"issuer" text NOT NULL',
      '"audience" text NOT NULL',
      '"workspace_id" text NOT NULL',
      '"owner_user_id" text NOT NULL',
      '"record" jsonb NOT NULL',
      '"agent_operation_idempotency_idx"',
      '"kind", "client_request_id"',
    ]) {
      expect(migration).toContain(required);
    }
    const journal = JSON.parse(
      await readFile(
        new URL("../../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    expect(journal).toEqual({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: 1_787_626_800_000,
          tag: "0001_hosted_eve_bridge",
          breakpoints: true,
        },
        {
          idx: 1,
          version: "7",
          when: 1_787_755_200_000,
          tag: "0002_hosted_workspace_membership",
          breakpoints: true,
        },
        {
          idx: 2,
          version: "7",
          when: 1_787_795_200_000,
          tag: "0003_hosted_retention_indexes",
          breakpoints: true,
        },
        {
          idx: 3,
          version: "7",
          when: 1_787_800_800_000,
          tag: "0004_preview_oauth",
          breakpoints: true,
        },
        {
          idx: 4,
          version: "7",
          when: 1_787_803_200_000,
          tag: "0005_github_publication_journal",
          breakpoints: true,
        },
        {
          idx: 5,
          version: "7",
          when: 1_787_893_200_000,
          tag: "0006_tenant_github_publication",
          breakpoints: true,
        },
        {
          idx: 6,
          version: "7",
          when: 1_787_896_800_000,
          tag: "0007_github_installation_authorization",
          breakpoints: true,
        },
        {
          idx: 7,
          version: "7",
          when: 1_787_983_200_000,
          tag: "0008_sandbox_execution_lease",
          breakpoints: true,
        },
        {
          idx: 8,
          version: "7",
          when: 1_788_066_000_000,
          tag: "0009_builder_provider_integrations",
          breakpoints: true,
        },
        {
          idx: 9,
          version: "7",
          when: 1_788_069_600_000,
          tag: "0010_better_auth_organizations",
          breakpoints: true,
        },
        {
          idx: 10,
          version: "7",
          when: 1_788_080_400_000,
          tag: "0011_self_service_onboarding",
          breakpoints: true,
        },
        {
          idx: 11,
          version: "7",
          when: 1_788_084_000_000,
          tag: "0012_provider_connection_return_state",
          breakpoints: true,
        },
        {
          idx: 12,
          version: "7",
          when: 1_788_091_200_000,
          tag: "0013_passkey_onboarding",
          breakpoints: true,
        },
        {
          idx: 13,
          version: "7",
          when: 1_788_094_800_000,
          tag: "0014_tenant_github_installation_uniqueness",
          breakpoints: true,
        },
        {
          idx: 14,
          version: "7",
          when: 1_788_102_000_000,
          tag: "0015_builder_resource_provisioning",
          breakpoints: true,
        },
        {
          idx: 15,
          version: "7",
          when: 1_788_102_600_000,
          tag: "0016_emulate_preview_state",
          breakpoints: true,
        },
        {
          idx: 16,
          version: "7",
          when: 1_788_261_600_000,
          tag: "0017_chat_repository_access",
          breakpoints: true,
        },
        {
          idx: 17,
          version: "7",
          when: 1_788_264_000_000,
          tag: "0018_durable_session_resume",
          breakpoints: true,
        },
        {
          idx: 18,
          version: "7",
          when: 1_788_267_600_000,
          tag: "0019_opaque_builder_handoff",
          breakpoints: true,
        },
      ],
    });
  });

  it("adds bounded durable-session metadata without rewriting legacy rows", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0018_durable_session_resume.sql", import.meta.url),
      "utf8",
    );
    for (const required of [
      '"adapter_generation" integer',
      '"checkpoint_digest" text',
      '"checkpoint_progress_digest" text',
      '"parent_session_id" text',
      '"last_progress_at" timestamptz',
      '"agent_session_recent_idx"',
    ])
      expect(migration).toContain(required);
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });

  it("adds opaque handoffs without rewriting existing rows", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0019_opaque_builder_handoff.sql", import.meta.url),
      "utf8",
    );
    for (const required of [
      'CREATE TABLE "builder_handoff"',
      '"builder_handoff_creation_uidx"',
      '"builder_handoff_expiry_idx"',
      '"builder_handoff_redemption_check"',
    ])
      expect(migration).toContain(required);
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });

});
