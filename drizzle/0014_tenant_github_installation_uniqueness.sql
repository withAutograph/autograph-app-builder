DROP INDEX IF EXISTS "hosted_github_installation_id_uidx";
DROP INDEX IF EXISTS "hosted_github_installation_binding_id_uidx";
CREATE UNIQUE INDEX "hosted_github_installation_binding_id_tenant_uidx"
  ON "hosted_github_installation_binding" ("installation_id", "issuer", "audience", "workspace_id", "owner_user_id");
