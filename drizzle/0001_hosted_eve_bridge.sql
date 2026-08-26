CREATE TABLE "agent_session" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "adapter_session_id" text NOT NULL,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "agent_session_tenant_pk" PRIMARY KEY (
    "issuer", "audience", "workspace_id", "owner_user_id", "session_id"
  )
);
CREATE INDEX "agent_session_owner_idx" ON "agent_session" (
  "issuer", "audience", "workspace_id", "owner_user_id"
);
CREATE UNIQUE INDEX "agent_session_adapter_id_idx" ON "agent_session" (
  "issuer", "audience", "workspace_id", "owner_user_id", "adapter_session_id"
);

CREATE TABLE "agent_operation" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "session_id" text,
  "kind" text NOT NULL,
  "client_request_id" text NOT NULL,
  "request_digest" text NOT NULL,
  "state" text NOT NULL,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "agent_operation_tenant_pk" PRIMARY KEY (
    "issuer", "audience", "workspace_id", "owner_user_id", "operation_id"
  )
);
CREATE UNIQUE INDEX "agent_operation_idempotency_idx" ON "agent_operation" (
  "issuer", "audience", "workspace_id", "owner_user_id", "kind", "client_request_id"
);
