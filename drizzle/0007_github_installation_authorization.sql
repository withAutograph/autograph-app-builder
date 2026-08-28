CREATE TABLE "github_installation_authorization_state" (
  "state_digest" text PRIMARY KEY NOT NULL,
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "authority_digest" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "github_installation_authorization_state_digest_check" CHECK ("state_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "github_installation_authorization_authority_digest_check" CHECK ("authority_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "github_installation_authorization_state_time_check" CHECK ("created_at" < "expires_at"),
  CONSTRAINT "github_installation_authorization_state_consumed_check" CHECK ("consumed_at" IS NULL OR ("consumed_at" >= "created_at" AND "consumed_at" <= "expires_at"))
);
CREATE INDEX "github_installation_authorization_state_expiry_idx" ON "github_installation_authorization_state" ("expires_at");
CREATE UNIQUE INDEX "hosted_github_installation_id_uidx" ON "hosted_github_installation" ("installation_id");
