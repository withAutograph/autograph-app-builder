ALTER TABLE "builder_draft"
  ADD COLUMN "status" text NOT NULL DEFAULT 'archived',
  ADD COLUMN "last_client_mutation_id" text;

-- Preserve the most recent existing draft as the tenant's active resume target.
WITH ranked_drafts AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY "issuer", "audience", "workspace_id", "owner_user_id"
      ORDER BY "updated_at" DESC, "draft_id" DESC
    ) AS position
  FROM "builder_draft"
)
UPDATE "builder_draft" AS draft
SET "status" = 'active'
FROM ranked_drafts
WHERE draft.ctid = ranked_drafts.ctid
  AND ranked_drafts.position = 1;

ALTER TABLE "builder_draft"
  ALTER COLUMN "status" SET DEFAULT 'active',
  ADD CONSTRAINT "builder_draft_status_check"
    CHECK ("status" IN ('active', 'archived')),
  ADD CONSTRAINT "builder_draft_last_client_mutation_id_check"
    CHECK (
      "last_client_mutation_id" IS NULL
      OR "last_client_mutation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );

CREATE UNIQUE INDEX "builder_draft_active_tenant_uidx"
  ON "builder_draft" ("issuer", "audience", "workspace_id", "owner_user_id")
  WHERE "status" = 'active';
