ALTER TABLE "user" ADD COLUMN "role" text;
ALTER TABLE "user" ADD COLUMN "banned" boolean DEFAULT false;
ALTER TABLE "user" ADD COLUMN "ban_reason" text;
ALTER TABLE "user" ADD COLUMN "ban_expires" timestamptz;

ALTER TABLE "session" ADD COLUMN "active_organization_id" text;
ALTER TABLE "session" ADD COLUMN "impersonated_by" text;

CREATE TABLE "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "logo" text,
  "created_at" timestamptz NOT NULL,
  "metadata" text,
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL
);
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" ("slug");
CREATE UNIQUE INDEX "organization_authority_uidx"
  ON "organization" ("issuer", "audience", "workspace_id");

CREATE TABLE "member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text DEFAULT 'member' NOT NULL,
  "created_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "member_organization_user_uidx"
  ON "member" ("organization_id", "user_id");
CREATE INDEX "member_organization_id_idx" ON "member" ("organization_id");
CREATE INDEX "member_user_id_idx" ON "member" ("user_id");

CREATE TABLE "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  "inviter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX "invitation_organization_id_idx"
  ON "invitation" ("organization_id");
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "hosted_workspace_membership" AS legacy
    LEFT JOIN "user" AS auth_user ON auth_user."id" = legacy."owner_user_id"
    WHERE legacy."active" = true AND auth_user."id" IS NULL
  ) THEN
    RAISE EXCEPTION
      'active hosted workspace membership has no Better Auth user';
  END IF;
END $$;

INSERT INTO "organization" (
  "id", "name", "slug", "created_at", "metadata",
  "issuer", "audience", "workspace_id"
)
SELECT
  'org-' || md5(
    legacy."issuer" || chr(31) || legacy."audience" || chr(31) ||
    legacy."workspace_id"
  ),
  legacy."workspace_id",
  'org-' || md5(
    legacy."issuer" || chr(31) || legacy."audience" || chr(31) ||
    legacy."workspace_id"
  ),
  min(legacy."updated_at"),
  json_build_object(
    'migrationSource', 'hosted_workspace_membership'
  )::text,
  legacy."issuer",
  legacy."audience",
  legacy."workspace_id"
FROM "hosted_workspace_membership" AS legacy
WHERE legacy."active" = true
GROUP BY legacy."issuer", legacy."audience", legacy."workspace_id";

INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at")
SELECT
  'legacy-' || md5(
    legacy."issuer" || chr(31) || legacy."audience" || chr(31) ||
    legacy."workspace_id" || chr(31) || legacy."owner_user_id"
  ),
  'org-' || md5(
    legacy."issuer" || chr(31) || legacy."audience" || chr(31) ||
    legacy."workspace_id"
  ),
  legacy."owner_user_id",
  'owner',
  legacy."updated_at"
FROM "hosted_workspace_membership" AS legacy
WHERE legacy."active" = true;

UPDATE "session" AS auth_session
SET "active_organization_id" = 'org-' || md5(
  legacy."issuer" || chr(31) || legacy."audience" || chr(31) ||
  legacy."workspace_id"
)
FROM "hosted_workspace_membership" AS legacy
WHERE legacy."active" = true
  AND legacy."owner_user_id" = auth_session."user_id"
  AND NOT EXISTS (
    SELECT 1
    FROM "hosted_workspace_membership" AS another
    WHERE another."active" = true
      AND another."owner_user_id" = legacy."owner_user_id"
      AND (
        another."issuer", another."audience", another."workspace_id"
      ) <> (
        legacy."issuer", legacy."audience", legacy."workspace_id"
      )
  );
