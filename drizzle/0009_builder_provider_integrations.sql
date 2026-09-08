CREATE TABLE "hosted_github_installation_binding" (
	"issuer" text NOT NULL,
	"audience" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"account_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"active" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosted_github_installation_binding_pk" PRIMARY KEY("issuer","audience","workspace_id","owner_user_id","installation_id"),
	CONSTRAINT "hosted_github_installation_binding_id_check" CHECK ("installation_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "hosted_github_installation_binding_account_id_check" CHECK ("account_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "hosted_github_installation_binding_account_type_check" CHECK ("account_type" IN ('Organization', 'User'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_github_installation_binding_id_uidx" ON "hosted_github_installation_binding" ("installation_id");
--> statement-breakpoint
CREATE TABLE "hosted_vercel_installation" (
	"issuer" text NOT NULL,
	"audience" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"token_key_version" text NOT NULL,
	"active" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosted_vercel_installation_pk" PRIMARY KEY("issuer","audience","workspace_id","owner_user_id","installation_id"),
	CONSTRAINT "hosted_vercel_installation_scope_type_check" CHECK ("scope_type" IN ('team', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_vercel_installation_id_uidx" ON "hosted_vercel_installation" ("installation_id");
--> statement-breakpoint
CREATE TABLE "vercel_installation_authorization_state" (
	"state_digest" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"audience" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"authority_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "vercel_installation_authorization_state_digest_check" CHECK ("state_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vercel_installation_authorization_authority_digest_check" CHECK ("authority_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "vercel_installation_authorization_state_time_check" CHECK ("created_at" < "expires_at"),
	CONSTRAINT "vercel_installation_authorization_state_consumed_check" CHECK ("consumed_at" IS NULL OR ("consumed_at" >= "created_at" AND "consumed_at" <= "expires_at"))
);
--> statement-breakpoint
CREATE INDEX "vercel_installation_authorization_state_expiry_idx" ON "vercel_installation_authorization_state" ("expires_at");
