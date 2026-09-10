CREATE TABLE "builder_draft" (
  "issuer" text NOT NULL, "audience" text NOT NULL, "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL, "draft_id" text NOT NULL, "revision" integer NOT NULL DEFAULT 1,
  "record" jsonb NOT NULL, "created_at" timestamptz NOT NULL, "updated_at" timestamptz NOT NULL,
  CONSTRAINT "builder_draft_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id", "draft_id"),
  CONSTRAINT "builder_draft_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "builder_draft_record_check" CHECK (jsonb_typeof("record") = 'object')
);
CREATE INDEX "builder_draft_updated_idx" ON "builder_draft" ("issuer", "audience", "workspace_id", "owner_user_id", "updated_at");
