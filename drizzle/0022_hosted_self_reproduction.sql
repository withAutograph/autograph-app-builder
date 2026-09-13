CREATE TABLE "hosted_self_reproduction_run" (
  "id" text PRIMARY KEY NOT NULL,
  "revision" integer NOT NULL,
  "record" jsonb NOT NULL,
  CONSTRAINT "hosted_self_reproduction_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "hosted_self_reproduction_record_check" CHECK (jsonb_typeof("record") = 'object')
);

CREATE TABLE "hosted_self_reproduction_artifact" (
  "storage_key" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "hosted_self_reproduction_run"("id") ON DELETE CASCADE,
  "artifact_id" text NOT NULL,
  "content_type" text NOT NULL,
  "content" bytea NOT NULL
);

CREATE UNIQUE INDEX "hosted_self_reproduction_artifact_identity"
  ON "hosted_self_reproduction_artifact" ("run_id", "artifact_id");
