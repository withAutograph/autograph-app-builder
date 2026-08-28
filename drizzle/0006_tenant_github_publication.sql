CREATE TABLE "hosted_github_installation" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "installation_id" text NOT NULL,
  "account_id" text NOT NULL,
  "account_login" text NOT NULL,
  "account_type" text NOT NULL,
  "active" boolean NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "hosted_github_installation_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id"),
  CONSTRAINT "hosted_github_installation_id_check" CHECK ("installation_id" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "hosted_github_installation_account_id_check" CHECK ("account_id" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "hosted_github_installation_account_type_check" CHECK ("account_type" IN ('Organization', 'User'))
);
CREATE UNIQUE INDEX "hosted_github_installation_id_tenant_uidx" ON "hosted_github_installation" ("installation_id", "issuer", "audience", "workspace_id", "owner_user_id");

CREATE TABLE "hosted_github_publication_proposal" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "proposal_digest" text NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "proposal" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "hosted_github_publication_proposal_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id", "proposal_digest"),
  CONSTRAINT "hosted_github_publication_proposal_digest_check" CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hosted_github_publication_proposal_idempotency_check" CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hosted_github_publication_proposal_kind_check" CHECK ("kind" IN ('fresh-repository', 'draft-pull-request')),
  CONSTRAINT "hosted_github_publication_proposal_record_check" CHECK (jsonb_typeof("proposal") = 'object')
);
CREATE UNIQUE INDEX "hosted_github_publication_proposal_idempotency_uidx" ON "hosted_github_publication_proposal" ("issuer", "audience", "workspace_id", "owner_user_id", "kind", "idempotency_key");

CREATE TABLE "hosted_github_publication_journal" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "proposal_digest" text NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "receipt_digest" text NOT NULL,
  "status" text NOT NULL,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "hosted_github_publication_journal_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id", "proposal_digest"),
  CONSTRAINT "hosted_github_publication_journal_proposal_digest_check" CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hosted_github_publication_journal_receipt_digest_check" CHECK ("receipt_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hosted_github_publication_journal_idempotency_check" CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hosted_github_publication_journal_kind_check" CHECK ("kind" IN ('fresh-repository', 'draft-pull-request')),
  CONSTRAINT "hosted_github_publication_journal_status_check" CHECK ("status" IN ('pending', 'failed', 'succeeded')),
  CONSTRAINT "hosted_github_publication_journal_record_check" CHECK (jsonb_typeof("record") = 'object'),
  CONSTRAINT "hosted_github_publication_journal_timestamp_check" CHECK ("created_at" <= "updated_at")
);
CREATE UNIQUE INDEX "hosted_github_publication_journal_idempotency_uidx" ON "hosted_github_publication_journal" ("issuer", "audience", "workspace_id", "owner_user_id", "idempotency_key");
CREATE INDEX "hosted_github_publication_journal_status_idx" ON "hosted_github_publication_journal" ("issuer", "audience", "workspace_id", "owner_user_id", "status", "updated_at");
