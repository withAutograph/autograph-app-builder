DO $$
BEGIN
  IF EXISTS (
    SELECT lower("email")
      FROM "user"
     GROUP BY lower("email")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'case-insensitive Better Auth user email collision requires operator reconciliation';
  END IF;
END $$;

UPDATE "user"
   SET "email" = lower("email"),
       "updated_at" = clock_timestamp()
 WHERE "email" <> lower("email");

CREATE UNIQUE INDEX "user_email_lower_uidx" ON "user" (lower("email"));

CREATE TABLE "personal_workspace" (
  "user_id" text PRIMARY KEY NOT NULL
    REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL
    REFERENCES "organization"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "personal_workspace_organization_id_uidx"
  ON "personal_workspace" ("organization_id");
