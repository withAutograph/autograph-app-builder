import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  parseHostedOperationRow,
  parseHostedSessionRow,
} from "./postgres-hosted-store";

const principal: HostedPrincipal = {
  audience: "eve-hosted",
  issuer: "https://identity.example.test",
  ownerUserId: "user_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
};

const operationRecord = {
  clientRequestId: "request_1",
  createdAtEpochMs: 1_000,
  kind: "start" as const,
  operationId: "operation_1",
  principal,
  requestDigest: `sha256:${"a".repeat(64)}`,
  state: "reserved" as const,
  updatedAtEpochMs: 1_000,
  version: 1 as const,
};

const operationRow = {
  audience: principal.audience,
  clientRequestId: operationRecord.clientRequestId,
  createdAt: new Date(1_000),
  issuer: principal.issuer,
  kind: operationRecord.kind,
  operationId: operationRecord.operationId,
  ownerUserId: principal.ownerUserId,
  record: operationRecord,
  requestDigest: operationRecord.requestDigest,
  sessionId: null,
  state: operationRecord.state,
  updatedAt: new Date(1_000),
  workspaceId: principal.workspaceId,
};

const sessionRecord = {
  adapterSessionId: "adapter_1",
  createdAtEpochMs: 2_000,
  principal,
  sessionId: "session_1",
  status: "waiting" as const,
  updatedAtEpochMs: 2_000,
  version: 1 as const,
};

const sessionRow = {
  adapterGeneration: null,
  adapterSessionId: sessionRecord.adapterSessionId,
  audience: principal.audience,
  checkpointDigest: null,
  checkpointProgressDigest: null,
  createdAt: new Date(2_000),
  issuer: principal.issuer,
  lastProgressAt: null,
  ownerUserId: principal.ownerUserId,
  parentSessionId: null,
  record: sessionRecord,
  resumabilityState: null,
  sessionId: sessionRecord.sessionId,
  stage: null,
  title: null,
  updatedAt: new Date(2_000),
  workspaceId: principal.workspaceId,
};

describe("PostgreSQL hosted Eve row authority", () => {
  it("accepts only an operation whose indexed authority matches its closed record", () => {
    expect(parseHostedOperationRow(operationRow)).toEqual(operationRecord);
    expect(() =>
      parseHostedOperationRow({ ...operationRow, workspaceId: "workspace_2" })
    ).toThrow("canonically bound");
    expect(() =>
      parseHostedOperationRow({
        ...operationRow,
        record: { ...operationRecord, untrustedRole: "admin" },
      })
    ).toThrow();
  });

  it("accepts only a session whose tenant and adapter index match its record", () => {
    expect(parseHostedSessionRow(sessionRow)).toEqual(sessionRecord);
    expect(() =>
      parseHostedSessionRow({ ...sessionRow, adapterSessionId: "substituted" })
    ).toThrow("canonically bound");
  });

  it("keeps the checked-in migration tenant scoped and idempotency bound", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0001_hosted_eve_bridge.sql", import.meta.url),
      "utf-8"
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
        "utf-8"
      )
    ) as unknown;
    expect(journal).toEqual({
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
        {
          idx: 19,
          version: "7",
          when: 1_788_354_000_000,
          tag: "0020_durable_builder_draft",
          breakpoints: true,
        },
        {
          idx: 20,
          version: "7",
          when: 1_788_357_600_000,
          tag: "0021_builder_draft_active_revision",
          breakpoints: true,
        },
      ],
      version: "7",
    });
  });

  it("adds bounded durable-session metadata without rewriting legacy rows", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0018_durable_session_resume.sql", import.meta.url),
      "utf-8"
    );
    for (const required of [
      '"adapter_generation" integer',
      '"checkpoint_digest" text',
      '"checkpoint_progress_digest" text',
      '"parent_session_id" text',
      '"last_progress_at" timestamptz',
      '"agent_session_recent_idx"',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });

  it("adds opaque handoffs without rewriting existing rows", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0019_opaque_builder_handoff.sql", import.meta.url),
      "utf-8"
    );
    for (const required of [
      'CREATE TABLE "builder_handoff"',
      '"builder_handoff_creation_uidx"',
      '"builder_handoff_expiry_idx"',
      '"builder_handoff_redemption_check"',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });

  it("adds tenant-scoped durable drafts without rewriting existing rows", async () => {
    const migration = await readFile(
      new URL("../../drizzle/0020_durable_builder_draft.sql", import.meta.url),
      "utf-8"
    );
    for (const required of [
      'CREATE TABLE "builder_draft"',
      '"builder_draft_pk"',
      '"builder_draft_updated_idx"',
      '"builder_draft_revision_check"',
      '"builder_draft_record_check"',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE)\b/iu);
  });
});
