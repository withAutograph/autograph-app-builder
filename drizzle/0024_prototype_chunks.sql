CREATE TABLE "prototype_artifact_chunk" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "path" text NOT NULL,
  "transfer_digest" text NOT NULL,
  "chunk_index" integer NOT NULL,
  "chunk_digest" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "prototype_artifact_chunk_tenant_pk" PRIMARY KEY (
    "issuer", "audience", "workspace_id", "owner_user_id", "session_id", "path", "transfer_digest", "chunk_index"
  ),
  CONSTRAINT "prototype_artifact_chunk_index_check" CHECK ("chunk_index" >= 0),
  CONSTRAINT "prototype_artifact_chunk_digest_check" CHECK (
    "chunk_digest" ~ '^[0-9a-f]{64}$' AND "transfer_digest" ~ '^[0-9a-f]{64}$'
  )
);
