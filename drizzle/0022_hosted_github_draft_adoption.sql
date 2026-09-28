CREATE TABLE "hosted_github_draft_adoption" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "adoption_digest" text NOT NULL,
  "repository_id" text NOT NULL,
  "pull_request_id" text NOT NULL,
  "pull_request_number" integer NOT NULL,
  "builder_marker" text NOT NULL,
  "app_id" text NOT NULL,
  "author_id" text NOT NULL,
  "original_head_sha" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "hosted_github_draft_adoption_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id", "adoption_digest"),
  CONSTRAINT "hosted_github_draft_adoption_digest_check" CHECK ("adoption_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hosted_github_draft_adoption_marker_check" CHECK ("builder_marker" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hosted_github_draft_adoption_head_check" CHECK ("original_head_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "hosted_github_draft_adoption_pr_check" CHECK ("pull_request_number" > 0)
);
CREATE UNIQUE INDEX "hosted_github_draft_adoption_pr_uidx" ON "hosted_github_draft_adoption" (
  "issuer", "audience", "workspace_id", "owner_user_id", "repository_id", "pull_request_id"
);
