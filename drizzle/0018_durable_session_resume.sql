ALTER TABLE "agent_session" ADD COLUMN "adapter_generation" integer;
ALTER TABLE "agent_session" ADD COLUMN "title" text;
ALTER TABLE "agent_session" ADD COLUMN "stage" text;
ALTER TABLE "agent_session" ADD COLUMN "resumability_state" text;
ALTER TABLE "agent_session" ADD COLUMN "checkpoint_digest" text;
ALTER TABLE "agent_session" ADD COLUMN "checkpoint_progress_digest" text;
ALTER TABLE "agent_session" ADD COLUMN "parent_session_id" text;
ALTER TABLE "agent_session" ADD COLUMN "last_progress_at" timestamptz;

ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_adapter_generation_check"
  CHECK ("adapter_generation" IS NULL OR "adapter_generation" > 0);
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_stage_check"
  CHECK ("stage" IS NULL OR "stage" IN (
    'starting', 'designing', 'prototype', 'planning', 'ready', 'complete', 'needs_attention'
  ));
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_resumability_check"
  CHECK ("resumability_state" IS NULL OR "resumability_state" IN (
    'live', 'checkpoint', 'restart_required', 'terminal'
  ));
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_checkpoint_digest_check"
  CHECK (
    "checkpoint_digest" IS NULL OR
    "checkpoint_digest" ~ '^sha256:[a-f0-9]{64}$'
  );
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_checkpoint_progress_digest_check"
  CHECK (
    "checkpoint_progress_digest" IS NULL OR
    "checkpoint_progress_digest" ~ '^sha256:[a-f0-9]{64}$'
  );

CREATE INDEX "agent_session_recent_idx" ON "agent_session" (
  "issuer", "audience", "workspace_id", "owner_user_id", "updated_at" DESC, "session_id" DESC
);
