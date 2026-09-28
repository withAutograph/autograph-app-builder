ALTER TABLE "agent_session" ADD COLUMN "checkpoint_id" text;

CREATE TABLE "agent_session_checkpoint_manifest" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "checkpoint_id" text NOT NULL,
  "checkpoint_digest" text,
  "event_count" integer,
  "item_count" integer,
  "created_at" timestamptz NOT NULL,
  "published_at" timestamptz,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "agent_session_checkpoint_manifest_pk" PRIMARY KEY
    ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "checkpoint_id"),
  CONSTRAINT "agent_session_checkpoint_manifest_session_fk" FOREIGN KEY
    ("issuer", "audience", "workspace_id", "owner_user_id", "session_id")
    REFERENCES "agent_session"
      ("issuer", "audience", "workspace_id", "owner_user_id", "session_id")
    ON DELETE CASCADE,
  CONSTRAINT "agent_session_checkpoint_manifest_state_check" CHECK (
    ("published_at" IS NULL AND "checkpoint_digest" IS NULL AND "event_count" IS NULL AND "item_count" IS NULL)
    OR ("published_at" IS NOT NULL AND "checkpoint_digest" ~ '^sha256:[a-f0-9]{64}$'
      AND "event_count" >= 0 AND "item_count" = "event_count" + 1)
  )
);

CREATE TABLE "agent_session_checkpoint_item" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "checkpoint_id" text NOT NULL,
  "item_index" integer NOT NULL,
  "digest" text NOT NULL,
  "byte_length" integer NOT NULL,
  "part_count" integer NOT NULL,
  CONSTRAINT "agent_session_checkpoint_item_pk" PRIMARY KEY
    ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "checkpoint_id", "item_index"),
  CONSTRAINT "agent_session_checkpoint_item_manifest_fk" FOREIGN KEY
    ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "checkpoint_id")
    REFERENCES "agent_session_checkpoint_manifest"
      ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "checkpoint_id")
    ON DELETE CASCADE,
  CONSTRAINT "agent_session_checkpoint_item_bounds_check"
    CHECK ("item_index" >= -1 AND "byte_length" >= 0 AND "part_count" > 0),
  CONSTRAINT "agent_session_checkpoint_item_digest_check"
    CHECK ("digest" ~ '^sha256:[a-f0-9]{64}$')
);

CREATE TABLE "agent_session_checkpoint_chunk" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "checkpoint_id" text NOT NULL,
  "item_index" integer NOT NULL,
  "part_index" integer NOT NULL,
  "chunk_digest" text NOT NULL,
  "payload" text NOT NULL,
  CONSTRAINT "agent_session_checkpoint_chunk_pk" PRIMARY KEY
    ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "checkpoint_id", "item_index", "part_index"),
  CONSTRAINT "agent_session_checkpoint_chunk_manifest_fk" FOREIGN KEY
    ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "checkpoint_id")
    REFERENCES "agent_session_checkpoint_manifest"
      ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "checkpoint_id")
    ON DELETE CASCADE,
  CONSTRAINT "agent_session_checkpoint_chunk_position_check"
    CHECK ("item_index" >= -1 AND "part_index" >= 0),
  CONSTRAINT "agent_session_checkpoint_chunk_digest_check"
    CHECK ("chunk_digest" ~ '^sha256:[a-f0-9]{64}$')
);
