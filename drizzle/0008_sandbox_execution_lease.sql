CREATE TABLE "sandbox_execution_lease" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "adapter_session_id" text NOT NULL,
  "provider_sandbox_id" text NOT NULL,
  "epoch" integer NOT NULL,
  "state" text NOT NULL,
  "policy_digest" text NOT NULL,
  "record" jsonb NOT NULL,
  "acquired_at" timestamptz NOT NULL,
  "heartbeat_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "released_at" timestamptz,
  CONSTRAINT "sandbox_execution_lease_tenant_pk" PRIMARY KEY ("issuer", "audience", "workspace_id", "owner_user_id", "adapter_session_id"),
  CONSTRAINT "sandbox_execution_lease_epoch_check" CHECK ("epoch" > 0),
  CONSTRAINT "sandbox_execution_lease_state_check" CHECK ("state" IN ('active', 'released', 'orphaned')),
  CONSTRAINT "sandbox_execution_lease_policy_digest_check" CHECK ("policy_digest" ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT "sandbox_execution_lease_time_check" CHECK ("acquired_at" <= "heartbeat_at" AND "heartbeat_at" < "expires_at"),
  CONSTRAINT "sandbox_execution_lease_release_check" CHECK (("state" = 'released' AND "released_at" IS NOT NULL) OR ("state" <> 'released' AND "released_at" IS NULL))
);
CREATE INDEX "sandbox_execution_lease_workspace_active_idx" ON "sandbox_execution_lease" ("issuer", "audience", "workspace_id", "state", "expires_at");
CREATE INDEX "sandbox_execution_lease_subject_active_idx" ON "sandbox_execution_lease" ("issuer", "audience", "workspace_id", "owner_user_id", "state", "expires_at");
CREATE INDEX "sandbox_execution_lease_orphan_idx" ON "sandbox_execution_lease" ("state", "expires_at");
