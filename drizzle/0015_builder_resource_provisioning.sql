CREATE TABLE "hosted_github_user_credential" (
	"issuer" text NOT NULL,
	"audience" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"provider_login" text NOT NULL,
	"encrypted_credential" text NOT NULL,
	"credential_iv" text NOT NULL,
	"credential_tag" text NOT NULL,
	"key_version" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"active" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosted_github_user_credential_pk" PRIMARY KEY("issuer","audience","workspace_id","owner_user_id","provider_user_id"),
	CONSTRAINT "hosted_github_user_credential_provider_user_id_check" CHECK ("hosted_github_user_credential"."provider_user_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "hosted_github_user_credential_revision_check" CHECK ("hosted_github_user_credential"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "builder_provisioning_journal" (
	"issuer" text NOT NULL,
	"audience" text NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"state" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "builder_provisioning_journal_pk" PRIMARY KEY("issuer","audience","workspace_id","owner_user_id","request_id"),
	CONSTRAINT "builder_provisioning_journal_request_id_check" CHECK ("builder_provisioning_journal"."request_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "builder_provisioning_journal_request_digest_check" CHECK ("builder_provisioning_journal"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "builder_provisioning_journal_state_check" CHECK ("builder_provisioning_journal"."state" IN ('pending', 'settled')),
	CONSTRAINT "builder_provisioning_journal_revision_check" CHECK ("builder_provisioning_journal"."revision" > 0),
	CONSTRAINT "builder_provisioning_journal_record_check" CHECK (jsonb_typeof("builder_provisioning_journal"."record") = 'object')
);
--> statement-breakpoint
CREATE INDEX "builder_provisioning_journal_retention_idx" ON "builder_provisioning_journal" USING btree ("issuer","audience","workspace_id","owner_user_id","updated_at");
