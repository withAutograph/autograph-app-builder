CREATE INDEX "agent_session_retention_idx" ON "agent_session" (
  "issuer", "audience", "workspace_id", "owner_user_id", "updated_at"
);
CREATE INDEX "agent_operation_retention_idx" ON "agent_operation" (
  "issuer", "audience", "workspace_id", "owner_user_id", "updated_at", "state"
);
