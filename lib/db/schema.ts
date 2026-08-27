import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const hostedWorkspaceMemberships = pgTable(
  "hosted_workspace_membership",
  {
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    active: boolean("active").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hosted_workspace_membership_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
      ],
    }),
  ],
);

export const agentSessions = pgTable(
  "agent_session",
  {
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    sessionId: text("session_id").notNull(),
    adapterSessionId: text("adapter_session_id").notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_session_tenant_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.sessionId,
      ],
    }),
    index("agent_session_owner_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
    ),
    index("agent_session_retention_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt,
    ),
    uniqueIndex("agent_session_adapter_id_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.adapterSessionId,
    ),
  ],
);

export const agentOperations = pgTable(
  "agent_operation",
  {
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    operationId: text("operation_id").notNull(),
    sessionId: text("session_id"),
    kind: text("kind").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    state: text("state").notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_operation_tenant_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.operationId,
      ],
    }),
    uniqueIndex("agent_operation_idempotency_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.kind,
      table.clientRequestId,
    ),
    index("agent_operation_retention_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt,
      table.state,
    ),
  ],
);
