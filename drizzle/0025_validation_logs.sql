CREATE TABLE "validation_log_chunk" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "log_id" text NOT NULL,
  "command" text NOT NULL,
  "chunk_index" bigint NOT NULL,
  "chunk_digest" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "validation_log_chunk_tenant_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "log_id", "chunk_index"),
  CONSTRAINT "validation_log_chunk_index_check" CHECK ("chunk_index" >= 0)
);
CREATE TABLE "validation_log_manifest" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "log_id" text NOT NULL,
  "attempt_digest" text NOT NULL,
  "command" text NOT NULL,
  "channel" text NOT NULL,
  "digest" text NOT NULL,
  "byte_length" bigint NOT NULL,
  "chunk_count" bigint NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "validation_log_manifest_tenant_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "log_id"),
  CONSTRAINT "validation_log_manifest_size_check" CHECK ("byte_length" >= 0 AND "chunk_count" >= 0)
);
