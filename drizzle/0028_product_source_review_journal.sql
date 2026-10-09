CREATE TABLE "product_source_review_journal" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "pair_key" text NOT NULL,
  "record" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "product_source_review_journal_owner_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "pair_key"),
  CONSTRAINT "product_source_review_journal_key_check" CHECK ("pair_key" ~ '^[0-9a-f]{64}$')
);
