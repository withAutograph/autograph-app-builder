ALTER TABLE "agent_operation" ADD COLUMN "send_cancellation_revision_at_dispatch" integer;
--> statement-breakpoint
ALTER TABLE "agent_operation" ADD CONSTRAINT "agent_operation_send_cancellation_revision_check" CHECK ("send_cancellation_revision_at_dispatch" >= 0);
--> statement-breakpoint
CREATE INDEX "agent_operation_unsettled_send_ack_idx" ON "agent_operation" ("issuer", "audience", "workspace_id", "owner_user_id", "session_id", "created_at", "operation_id") WHERE "kind" = 'send' AND "state" IN ('reserved', 'submission_unknown') AND "record"->'sendDelivery' IS NOT NULL AND "record"->'internalBuildContinuation' IS NULL;
