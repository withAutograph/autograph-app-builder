CREATE TABLE "github_repository_access_continuation" (
	"continuation_digest" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"audience" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"request_id" text NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"selected_installation_id" text,
	"callback_url" text NOT NULL,
	"created_at" timestamptz NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"authorized_at" timestamptz,
	"consumed_at" timestamptz,
	CONSTRAINT "github_repository_access_continuation_digest_check" CHECK ("continuation_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "github_repository_access_continuation_session_check" CHECK (length("session_id") BETWEEN 1 AND 255),
	CONSTRAINT "github_repository_access_continuation_request_check" CHECK (length("request_id") BETWEEN 1 AND 255),
	CONSTRAINT "github_repository_access_continuation_repository_check" CHECK (length("repository_owner") BETWEEN 1 AND 100 AND length("repository_name") BETWEEN 1 AND 100),
	CONSTRAINT "github_repository_access_continuation_installation_check" CHECK ("selected_installation_id" IS NULL OR "selected_installation_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "github_repository_access_continuation_time_check" CHECK ("created_at" < "expires_at"),
	CONSTRAINT "github_repository_access_continuation_authorized_check" CHECK ("authorized_at" IS NULL OR ("authorized_at" >= "created_at" AND "authorized_at" <= "expires_at")),
	CONSTRAINT "github_repository_access_continuation_consumed_check" CHECK ("consumed_at" IS NULL OR ("authorized_at" IS NOT NULL AND "consumed_at" >= "authorized_at"))
);

CREATE INDEX "github_repository_access_continuation_expiry_idx" ON "github_repository_access_continuation" USING btree ("expires_at");
