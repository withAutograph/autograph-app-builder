CREATE TABLE "github_publication_proposal" (
  "proposal_digest" text NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "proposal" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "github_publication_proposal_pk" PRIMARY KEY ("proposal_digest"),
  CONSTRAINT "github_publication_proposal_digest_check"
    CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "github_publication_proposal_idempotency_key_check"
    CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "github_publication_proposal_kind_check"
    CHECK ("kind" IN ('fresh-repository', 'draft-pull-request')),
  CONSTRAINT "github_publication_proposal_record_check"
    CHECK (jsonb_typeof("proposal") = 'object')
);
CREATE UNIQUE INDEX "github_publication_proposal_idempotency_idx" ON "github_publication_proposal" (
  "kind", "idempotency_key"
);

CREATE TABLE "github_publication_journal" (
  "proposal_digest" text NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "receipt_digest" text NOT NULL,
  "status" text NOT NULL,
  "record" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "github_publication_journal_pk" PRIMARY KEY ("proposal_digest"),
  CONSTRAINT "github_publication_journal_proposal_digest_check"
    CHECK ("proposal_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "github_publication_journal_receipt_digest_check"
    CHECK ("receipt_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "github_publication_journal_idempotency_key_check"
    CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "github_publication_journal_kind_check"
    CHECK ("kind" IN ('fresh-repository', 'draft-pull-request')),
  CONSTRAINT "github_publication_journal_status_check"
    CHECK ("status" IN ('pending', 'failed', 'succeeded')),
  CONSTRAINT "github_publication_journal_record_check"
    CHECK (jsonb_typeof("record") = 'object'),
  CONSTRAINT "github_publication_journal_timestamp_check"
    CHECK ("created_at" <= "updated_at")
);
CREATE UNIQUE INDEX "github_publication_journal_idempotency_idx" ON "github_publication_journal" (
  "idempotency_key"
);
CREATE INDEX "github_publication_journal_status_idx" ON "github_publication_journal" (
  "status", "updated_at"
);
