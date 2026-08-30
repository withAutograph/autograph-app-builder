import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const hostedStorageMigrationTags = [
  "0001_hosted_eve_bridge",
  "0002_hosted_workspace_membership",
  "0003_hosted_retention_indexes",
  "0004_preview_oauth",
  "0005_github_publication_journal",
  "0006_tenant_github_publication",
  "0007_github_installation_authorization",
  "0008_sandbox_execution_lease",
  "0009_builder_provider_integrations",
  "0010_better_auth_organizations",
  "0011_self_service_onboarding",
  "0012_provider_connection_return_state",
  "0013_passkey_onboarding",
  "0014_tenant_github_installation_uniqueness",
] as const;

const contractSourcePaths = [
  "lib/db/schema.ts",
  "lib/db/postgres-hosted-admin.ts",
  "lib/eve/postgres-hosted-store.ts",
  "lib/eve/postgres-workspace-membership.ts",
  "lib/auth/postgres-github-installation-state.ts",
  "lib/sandbox/postgres-execution-lease-store.ts",
  "lib/repository/postgres-github-publication-receipt-store.ts",
  "lib/repository/postgres-github-publication-store.ts",
  "lib/repository/postgres-github-installation-store.ts",
  "lib/integrations/postgres-vercel-installation.ts",
  "lib/integrations/vercel-installation.ts",
  "lib/auth/postgres-organization-user-authority.ts",
  "lib/auth/passkey-onboarding.ts",
] as const;

export const hostedStorageExpectedColumns = [
  ["account", "access_token", "text", false],
  ["account", "access_token_expires_at", "timestamp with time zone", false],
  ["account", "account_id", "text", true],
  ["account", "created_at", "timestamp with time zone", true],
  ["account", "id", "text", true],
  ["account", "id_token", "text", false],
  ["account", "issuer", "text", true],
  ["account", "password", "text", false],
  ["account", "provider_id", "text", true],
  ["account", "refresh_token", "text", false],
  ["account", "refresh_token_expires_at", "timestamp with time zone", false],
  ["account", "scope", "text", false],
  ["account", "updated_at", "timestamp with time zone", true],
  ["account", "user_id", "text", true],
  ["agent_operation", "audience", "text", true],
  ["agent_operation", "client_request_id", "text", true],
  ["agent_operation", "created_at", "timestamp with time zone", true],
  ["agent_operation", "issuer", "text", true],
  ["agent_operation", "kind", "text", true],
  ["agent_operation", "operation_id", "text", true],
  ["agent_operation", "owner_user_id", "text", true],
  ["agent_operation", "record", "jsonb", true],
  ["agent_operation", "request_digest", "text", true],
  ["agent_operation", "session_id", "text", false],
  ["agent_operation", "state", "text", true],
  ["agent_operation", "updated_at", "timestamp with time zone", true],
  ["agent_operation", "workspace_id", "text", true],
  ["agent_session", "adapter_session_id", "text", true],
  ["agent_session", "audience", "text", true],
  ["agent_session", "created_at", "timestamp with time zone", true],
  ["agent_session", "issuer", "text", true],
  ["agent_session", "owner_user_id", "text", true],
  ["agent_session", "record", "jsonb", true],
  ["agent_session", "session_id", "text", true],
  ["agent_session", "updated_at", "timestamp with time zone", true],
  ["agent_session", "workspace_id", "text", true],
  ["github_installation_authorization_state", "audience", "text", true],
  ["github_installation_authorization_state", "authority_digest", "text", true],
  [
    "github_installation_authorization_state",
    "consumed_at",
    "timestamp with time zone",
    false,
  ],
  [
    "github_installation_authorization_state",
    "created_at",
    "timestamp with time zone",
    true,
  ],
  [
    "github_installation_authorization_state",
    "expires_at",
    "timestamp with time zone",
    true,
  ],
  ["github_installation_authorization_state", "issuer", "text", true],
  ["github_installation_authorization_state", "owner_user_id", "text", true],
  ["github_installation_authorization_state", "resume_key", "text", false],
  ["github_installation_authorization_state", "return_to", "text", true],
  ["github_installation_authorization_state", "state_digest", "text", true],
  ["github_installation_authorization_state", "workspace_id", "text", true],
  [
    "github_publication_journal",
    "created_at",
    "timestamp with time zone",
    true,
  ],
  ["github_publication_journal", "idempotency_key", "text", true],
  ["github_publication_journal", "kind", "text", true],
  ["github_publication_journal", "proposal_digest", "text", true],
  ["github_publication_journal", "receipt_digest", "text", true],
  ["github_publication_journal", "record", "jsonb", true],
  ["github_publication_journal", "status", "text", true],
  [
    "github_publication_journal",
    "updated_at",
    "timestamp with time zone",
    true,
  ],
  [
    "github_publication_proposal",
    "created_at",
    "timestamp with time zone",
    true,
  ],
  ["github_publication_proposal", "idempotency_key", "text", true],
  ["github_publication_proposal", "kind", "text", true],
  ["github_publication_proposal", "proposal", "jsonb", true],
  ["github_publication_proposal", "proposal_digest", "text", true],
  ["hosted_github_installation", "account_id", "text", true],
  ["hosted_github_installation", "account_login", "text", true],
  ["hosted_github_installation", "account_type", "text", true],
  ["hosted_github_installation", "active", "boolean", true],
  ["hosted_github_installation", "audience", "text", true],
  ["hosted_github_installation", "installation_id", "text", true],
  ["hosted_github_installation", "issuer", "text", true],
  ["hosted_github_installation", "owner_user_id", "text", true],
  [
    "hosted_github_installation",
    "updated_at",
    "timestamp with time zone",
    true,
  ],
  ["hosted_github_installation", "workspace_id", "text", true],
  ["hosted_github_installation_binding", "account_id", "text", true],
  ["hosted_github_installation_binding", "account_login", "text", true],
  ["hosted_github_installation_binding", "account_type", "text", true],
  ["hosted_github_installation_binding", "active", "boolean", true],
  ["hosted_github_installation_binding", "audience", "text", true],
  ["hosted_github_installation_binding", "installation_id", "text", true],
  ["hosted_github_installation_binding", "issuer", "text", true],
  ["hosted_github_installation_binding", "owner_user_id", "text", true],
  [
    "hosted_github_installation_binding",
    "updated_at",
    "timestamp with time zone",
    true,
  ],
  ["hosted_github_installation_binding", "workspace_id", "text", true],
  ["hosted_github_publication_journal", "audience", "text", true],
  [
    "hosted_github_publication_journal",
    "created_at",
    "timestamp with time zone",
    true,
  ],
  ["hosted_github_publication_journal", "idempotency_key", "text", true],
  ["hosted_github_publication_journal", "issuer", "text", true],
  ["hosted_github_publication_journal", "kind", "text", true],
  ["hosted_github_publication_journal", "owner_user_id", "text", true],
  ["hosted_github_publication_journal", "proposal_digest", "text", true],
  ["hosted_github_publication_journal", "receipt_digest", "text", true],
  ["hosted_github_publication_journal", "record", "jsonb", true],
  ["hosted_github_publication_journal", "status", "text", true],
  [
    "hosted_github_publication_journal",
    "updated_at",
    "timestamp with time zone",
    true,
  ],
  ["hosted_github_publication_journal", "workspace_id", "text", true],
  ["hosted_github_publication_proposal", "audience", "text", true],
  [
    "hosted_github_publication_proposal",
    "created_at",
    "timestamp with time zone",
    true,
  ],
  ["hosted_github_publication_proposal", "idempotency_key", "text", true],
  ["hosted_github_publication_proposal", "issuer", "text", true],
  ["hosted_github_publication_proposal", "kind", "text", true],
  ["hosted_github_publication_proposal", "owner_user_id", "text", true],
  ["hosted_github_publication_proposal", "proposal", "jsonb", true],
  ["hosted_github_publication_proposal", "proposal_digest", "text", true],
  ["hosted_github_publication_proposal", "workspace_id", "text", true],
  ["hosted_vercel_installation", "active", "boolean", true],
  ["hosted_vercel_installation", "audience", "text", true],
  ["hosted_vercel_installation", "display_name", "text", true],
  ["hosted_vercel_installation", "encrypted_token", "text", true],
  ["hosted_vercel_installation", "installation_id", "text", true],
  ["hosted_vercel_installation", "issuer", "text", true],
  ["hosted_vercel_installation", "owner_user_id", "text", true],
  ["hosted_vercel_installation", "plan", "text", true],
  ["hosted_vercel_installation", "scope_id", "text", true],
  ["hosted_vercel_installation", "scope_type", "text", true],
  ["hosted_vercel_installation", "slug", "text", true],
  ["hosted_vercel_installation", "token_iv", "text", true],
  ["hosted_vercel_installation", "token_key_version", "text", true],
  ["hosted_vercel_installation", "token_tag", "text", true],
  [
    "hosted_vercel_installation",
    "updated_at",
    "timestamp with time zone",
    true,
  ],
  ["hosted_vercel_installation", "workspace_id", "text", true],
  ["hosted_workspace_membership", "active", "boolean", true],
  ["hosted_workspace_membership", "audience", "text", true],
  ["hosted_workspace_membership", "issuer", "text", true],
  ["hosted_workspace_membership", "owner_user_id", "text", true],
  [
    "hosted_workspace_membership",
    "updated_at",
    "timestamp with time zone",
    true,
  ],
  ["hosted_workspace_membership", "workspace_id", "text", true],
  ["jwks", "alg", "text", false],
  ["jwks", "created_at", "timestamp with time zone", true],
  ["jwks", "crv", "text", false],
  ["jwks", "expires_at", "timestamp with time zone", false],
  ["jwks", "id", "text", true],
  ["jwks", "private_key", "text", true],
  ["jwks", "public_key", "text", true],
  ["oauth_access_token", "authorization_code_id", "text", false],
  ["oauth_access_token", "client_id", "text", true],
  ["oauth_access_token", "confirmation", "jsonb", false],
  ["oauth_access_token", "created_at", "timestamp with time zone", false],
  ["oauth_access_token", "expires_at", "timestamp with time zone", false],
  ["oauth_access_token", "id", "text", true],
  ["oauth_access_token", "reference_id", "text", false],
  ["oauth_access_token", "refresh_id", "text", false],
  ["oauth_access_token", "requested_user_info_claims", "text[]", false],
  ["oauth_access_token", "resources", "text[]", false],
  ["oauth_access_token", "revoked", "timestamp with time zone", false],
  ["oauth_access_token", "scopes", "text[]", true],
  ["oauth_access_token", "session_id", "text", false],
  ["oauth_access_token", "token", "text", false],
  ["oauth_access_token", "user_id", "text", false],
  ["oauth_client", "application_type", "text", false],
  ["oauth_client", "backchannel_logout_session_required", "boolean", false],
  ["oauth_client", "backchannel_logout_uri", "text", false],
  ["oauth_client", "client_credentials_scopes", "text[]", false],
  ["oauth_client", "client_discovery_id", "text", false],
  ["oauth_client", "client_id", "text", true],
  ["oauth_client", "client_secret", "text", false],
  ["oauth_client", "contacts", "text[]", false],
  ["oauth_client", "created_at", "timestamp with time zone", false],
  ["oauth_client", "disabled", "boolean", false],
  ["oauth_client", "dpop_bound_access_tokens", "boolean", false],
  ["oauth_client", "enable_end_session", "boolean", false],
  ["oauth_client", "grant_types", "text[]", false],
  ["oauth_client", "icon", "text", false],
  ["oauth_client", "id", "text", true],
  ["oauth_client", "jwks", "text", false],
  ["oauth_client", "jwks_uri", "text", false],
  ["oauth_client", "metadata", "jsonb", false],
  ["oauth_client", "name", "text", false],
  ["oauth_client", "policy", "text", false],
  ["oauth_client", "post_logout_redirect_uris", "text[]", false],
  ["oauth_client", "redirect_uris", "text[]", true],
  ["oauth_client", "reference_id", "text", false],
  ["oauth_client", "require_pkce", "boolean", false],
  ["oauth_client", "response_types", "text[]", false],
  ["oauth_client", "scopes", "text[]", false],
  ["oauth_client", "skip_consent", "boolean", false],
  ["oauth_client", "software_id", "text", false],
  ["oauth_client", "software_statement", "text", false],
  ["oauth_client", "software_version", "text", false],
  ["oauth_client", "subject_type", "text", false],
  ["oauth_client", "token_endpoint_auth_method", "text", false],
  ["oauth_client", "tos", "text", false],
  ["oauth_client", "updated_at", "timestamp with time zone", false],
  ["oauth_client", "uri", "text", false],
  ["oauth_client", "user_id", "text", false],
  ["oauth_client_assertion", "expires_at", "timestamp with time zone", true],
  ["oauth_client_assertion", "id", "text", true],
  ["oauth_client_resource", "client_id", "text", true],
  ["oauth_client_resource", "created_at", "timestamp with time zone", false],
  ["oauth_client_resource", "id", "text", true],
  ["oauth_client_resource", "metadata", "jsonb", false],
  ["oauth_client_resource", "resource_id", "text", true],
  ["oauth_consent", "client_id", "text", true],
  ["oauth_consent", "created_at", "timestamp with time zone", false],
  ["oauth_consent", "id", "text", true],
  ["oauth_consent", "reference_id", "text", false],
  ["oauth_consent", "requested_user_info_claims", "text[]", false],
  ["oauth_consent", "resources", "text[]", false],
  ["oauth_consent", "scopes", "text[]", true],
  ["oauth_consent", "updated_at", "timestamp with time zone", false],
  ["oauth_consent", "user_id", "text", false],
  ["oauth_refresh_token", "auth_time", "timestamp with time zone", false],
  ["oauth_refresh_token", "authorization_code_id", "text", false],
  ["oauth_refresh_token", "client_id", "text", true],
  ["oauth_refresh_token", "confirmation", "jsonb", false],
  ["oauth_refresh_token", "created_at", "timestamp with time zone", false],
  ["oauth_refresh_token", "expires_at", "timestamp with time zone", false],
  ["oauth_refresh_token", "id", "text", true],
  ["oauth_refresh_token", "reference_id", "text", false],
  ["oauth_refresh_token", "requested_user_info_claims", "text[]", false],
  ["oauth_refresh_token", "resources", "text[]", false],
  ["oauth_refresh_token", "revoked", "timestamp with time zone", false],
  ["oauth_refresh_token", "rotated_at", "timestamp with time zone", false],
  [
    "oauth_refresh_token",
    "rotation_replay_expires_at",
    "timestamp with time zone",
    false,
  ],
  ["oauth_refresh_token", "rotation_replay_response", "text", false],
  ["oauth_refresh_token", "scopes", "text[]", true],
  ["oauth_refresh_token", "session_id", "text", false],
  ["oauth_refresh_token", "token", "text", true],
  ["oauth_refresh_token", "user_id", "text", true],
  ["oauth_resource", "access_token_ttl", "integer", false],
  ["oauth_resource", "allowed_scopes", "text[]", false],
  ["oauth_resource", "created_at", "timestamp with time zone", false],
  ["oauth_resource", "custom_claims", "jsonb", false],
  ["oauth_resource", "disabled", "boolean", false],
  ["oauth_resource", "dpop_bound_access_tokens_required", "boolean", false],
  ["oauth_resource", "id", "text", true],
  ["oauth_resource", "identifier", "text", true],
  ["oauth_resource", "metadata", "jsonb", false],
  ["oauth_resource", "name", "text", true],
  ["oauth_resource", "policy_version", "integer", false],
  ["oauth_resource", "refresh_token_ttl", "integer", false],
  ["oauth_resource", "signing_algorithm", "text", false],
  ["oauth_resource", "signing_key_id", "text", false],
  ["oauth_resource", "updated_at", "timestamp with time zone", false],
  ["passkey", "aaguid", "text", false],
  ["passkey", "backed_up", "boolean", true],
  ["passkey", "counter", "integer", true],
  ["passkey", "created_at", "timestamp with time zone", false],
  ["passkey", "credential_id", "text", true],
  ["passkey", "device_type", "text", true],
  ["passkey", "id", "text", true],
  ["passkey", "name", "text", false],
  ["passkey", "public_key", "text", true],
  ["passkey", "transports", "text", false],
  ["passkey", "user_id", "text", true],
  ["passkey_onboarding", "created_at", "timestamp with time zone", true],
  ["passkey_onboarding", "deployment_id", "text", true],
  ["passkey_onboarding", "expires_at", "timestamp with time zone", true],
  ["passkey_onboarding", "id", "text", true],
  ["passkey_onboarding", "origin", "text", true],
  ["passkey_onboarding", "rp_id", "text", true],
  ["passkey_onboarding", "token_digest", "text", true],
  ["passkey_onboarding", "user_handle", "text", true],
  ["personal_workspace", "created_at", "timestamp with time zone", true],
  ["personal_workspace", "organization_id", "text", true],
  ["personal_workspace", "user_id", "text", true],
  ["sandbox_execution_lease", "acquired_at", "timestamp with time zone", true],
  ["sandbox_execution_lease", "adapter_session_id", "text", true],
  ["sandbox_execution_lease", "audience", "text", true],
  ["sandbox_execution_lease", "epoch", "integer", true],
  ["sandbox_execution_lease", "expires_at", "timestamp with time zone", true],
  ["sandbox_execution_lease", "heartbeat_at", "timestamp with time zone", true],
  ["sandbox_execution_lease", "issuer", "text", true],
  ["sandbox_execution_lease", "owner_user_id", "text", true],
  ["sandbox_execution_lease", "policy_digest", "text", true],
  ["sandbox_execution_lease", "provider_sandbox_id", "text", true],
  ["sandbox_execution_lease", "record", "jsonb", true],
  ["sandbox_execution_lease", "released_at", "timestamp with time zone", false],
  ["sandbox_execution_lease", "state", "text", true],
  ["sandbox_execution_lease", "workspace_id", "text", true],
  ["session", "active_organization_id", "text", false],
  ["session", "created_at", "timestamp with time zone", true],
  ["session", "expires_at", "timestamp with time zone", true],
  ["session", "id", "text", true],
  ["session", "impersonated_by", "text", false],
  ["session", "ip_address", "text", false],
  ["session", "token", "text", true],
  ["session", "updated_at", "timestamp with time zone", true],
  ["session", "user_agent", "text", false],
  ["session", "user_id", "text", true],
  ["user", "ban_expires", "timestamp with time zone", false],
  ["user", "ban_reason", "text", false],
  ["user", "banned", "boolean", false],
  ["user", "created_at", "timestamp with time zone", true],
  ["user", "email", "text", true],
  ["user", "email_verified", "boolean", true],
  ["user", "id", "text", true],
  ["user", "image", "text", false],
  ["user", "name", "text", true],
  ["user", "role", "text", false],
  ["user", "updated_at", "timestamp with time zone", true],
  ["vercel_installation_authorization_state", "audience", "text", true],
  ["vercel_installation_authorization_state", "authority_digest", "text", true],
  [
    "vercel_installation_authorization_state",
    "consumed_at",
    "timestamp with time zone",
    false,
  ],
  [
    "vercel_installation_authorization_state",
    "created_at",
    "timestamp with time zone",
    true,
  ],
  [
    "vercel_installation_authorization_state",
    "expires_at",
    "timestamp with time zone",
    true,
  ],
  ["vercel_installation_authorization_state", "issuer", "text", true],
  ["vercel_installation_authorization_state", "owner_user_id", "text", true],
  ["vercel_installation_authorization_state", "resume_key", "text", false],
  ["vercel_installation_authorization_state", "return_to", "text", true],
  ["vercel_installation_authorization_state", "state_digest", "text", true],
  ["vercel_installation_authorization_state", "workspace_id", "text", true],
  ["verification", "created_at", "timestamp with time zone", true],
  ["verification", "expires_at", "timestamp with time zone", true],
  ["verification", "id", "text", true],
  ["verification", "identifier", "text", true],
  ["verification", "updated_at", "timestamp with time zone", true],
  ["verification", "value", "text", true],
] as const;

export const hostedStorageExpectedIndexes = [
  ["account", "account_issuer_account_id_uidx"],
  ["account", "account_pkey"],
  ["account", "account_user_id_idx"],
  ["agent_operation", "agent_operation_idempotency_idx"],
  ["agent_operation", "agent_operation_retention_idx"],
  ["agent_operation", "agent_operation_tenant_pk"],
  ["agent_session", "agent_session_adapter_id_idx"],
  ["agent_session", "agent_session_owner_idx"],
  ["agent_session", "agent_session_retention_idx"],
  ["agent_session", "agent_session_tenant_pk"],
  [
    "github_installation_authorization_state",
    "github_installation_authorization_state_expiry_idx",
  ],
  [
    "github_installation_authorization_state",
    "github_installation_authorization_state_pkey",
  ],
  ["github_publication_journal", "github_publication_journal_idempotency_idx"],
  ["github_publication_journal", "github_publication_journal_pk"],
  ["github_publication_journal", "github_publication_journal_status_idx"],
  [
    "github_publication_proposal",
    "github_publication_proposal_idempotency_idx",
  ],
  ["github_publication_proposal", "github_publication_proposal_pk"],
  ["hosted_github_installation", "hosted_github_installation_id_tenant_uidx"],
  ["hosted_github_installation", "hosted_github_installation_pk"],
  [
    "hosted_github_installation_binding",
    "hosted_github_installation_binding_id_tenant_uidx",
  ],
  [
    "hosted_github_installation_binding",
    "hosted_github_installation_binding_pk",
  ],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_idempotency_uidx",
  ],
  ["hosted_github_publication_journal", "hosted_github_publication_journal_pk"],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_status_idx",
  ],
  [
    "hosted_github_publication_proposal",
    "hosted_github_publication_proposal_idempotency_uidx",
  ],
  [
    "hosted_github_publication_proposal",
    "hosted_github_publication_proposal_pk",
  ],
  ["hosted_vercel_installation", "hosted_vercel_installation_id_uidx"],
  ["hosted_vercel_installation", "hosted_vercel_installation_pk"],
  ["hosted_workspace_membership", "hosted_workspace_membership_pk"],
  ["jwks", "jwks_pkey"],
  ["oauth_access_token", "oauth_access_token_authorization_code_id_idx"],
  ["oauth_access_token", "oauth_access_token_client_id_idx"],
  ["oauth_access_token", "oauth_access_token_pkey"],
  ["oauth_access_token", "oauth_access_token_refresh_id_idx"],
  ["oauth_access_token", "oauth_access_token_session_id_idx"],
  ["oauth_access_token", "oauth_access_token_token_uidx"],
  ["oauth_access_token", "oauth_access_token_user_id_idx"],
  ["oauth_client", "oauth_client_client_id_uidx"],
  ["oauth_client", "oauth_client_pkey"],
  ["oauth_client", "oauth_client_user_id_idx"],
  ["oauth_client_assertion", "oauth_client_assertion_pkey"],
  ["oauth_client_resource", "oauth_client_resource_client_id_idx"],
  ["oauth_client_resource", "oauth_client_resource_client_resource_uidx"],
  ["oauth_client_resource", "oauth_client_resource_pkey"],
  ["oauth_client_resource", "oauth_client_resource_resource_id_idx"],
  ["oauth_consent", "oauth_consent_client_id_idx"],
  ["oauth_consent", "oauth_consent_pkey"],
  ["oauth_consent", "oauth_consent_user_id_idx"],
  ["oauth_refresh_token", "oauth_refresh_token_authorization_code_id_idx"],
  ["oauth_refresh_token", "oauth_refresh_token_client_id_idx"],
  ["oauth_refresh_token", "oauth_refresh_token_pkey"],
  ["oauth_refresh_token", "oauth_refresh_token_session_id_idx"],
  ["oauth_refresh_token", "oauth_refresh_token_token_uidx"],
  ["oauth_refresh_token", "oauth_refresh_token_user_id_idx"],
  ["oauth_resource", "oauth_resource_identifier_uidx"],
  ["oauth_resource", "oauth_resource_pkey"],
  ["passkey", "passkey_credential_id_uidx"],
  ["passkey", "passkey_pkey"],
  ["passkey", "passkey_user_id_idx"],
  ["passkey_onboarding", "passkey_onboarding_expires_at_idx"],
  ["passkey_onboarding", "passkey_onboarding_pkey"],
  ["passkey_onboarding", "passkey_onboarding_token_digest_uidx"],
  ["passkey_onboarding", "passkey_onboarding_user_handle_uidx"],
  ["personal_workspace", "personal_workspace_organization_id_uidx"],
  ["personal_workspace", "personal_workspace_pkey"],
  ["sandbox_execution_lease", "sandbox_execution_lease_orphan_idx"],
  ["sandbox_execution_lease", "sandbox_execution_lease_subject_active_idx"],
  ["sandbox_execution_lease", "sandbox_execution_lease_tenant_pk"],
  ["sandbox_execution_lease", "sandbox_execution_lease_workspace_active_idx"],
  ["session", "session_pkey"],
  ["session", "session_token_uidx"],
  ["session", "session_user_id_idx"],
  ["user", "user_email_lower_uidx"],
  ["user", "user_email_uidx"],
  ["user", "user_pkey"],
  [
    "vercel_installation_authorization_state",
    "vercel_installation_authorization_state_expiry_idx",
  ],
  [
    "vercel_installation_authorization_state",
    "vercel_installation_authorization_state_pkey",
  ],
  ["verification", "verification_identifier_idx"],
  ["verification", "verification_pkey"],
] as const;

export const hostedStorageExpectedConstraints = [
  ["account", "account_pkey"],
  ["account", "account_user_id_fkey"],
  ["agent_operation", "agent_operation_tenant_pk"],
  ["agent_session", "agent_session_tenant_pk"],
  [
    "github_installation_authorization_state",
    "github_installation_authorization_authority_digest_check",
  ],
  [
    "github_installation_authorization_state",
    "github_installation_authorization_state_consumed_check",
  ],
  [
    "github_installation_authorization_state",
    "github_installation_authorization_state_digest_check",
  ],
  [
    "github_installation_authorization_state",
    "github_installation_authorization_state_pkey",
  ],
  [
    "github_installation_authorization_state",
    "github_installation_authorization_state_time_check",
  ],
  [
    "github_publication_journal",
    "github_publication_journal_idempotency_key_check",
  ],
  ["github_publication_journal", "github_publication_journal_kind_check"],
  ["github_publication_journal", "github_publication_journal_pk"],
  [
    "github_publication_journal",
    "github_publication_journal_proposal_digest_check",
  ],
  [
    "github_publication_journal",
    "github_publication_journal_receipt_digest_check",
  ],
  ["github_publication_journal", "github_publication_journal_record_check"],
  ["github_publication_journal", "github_publication_journal_status_check"],
  ["github_publication_journal", "github_publication_journal_timestamp_check"],
  ["github_publication_proposal", "github_publication_proposal_digest_check"],
  [
    "github_publication_proposal",
    "github_publication_proposal_idempotency_key_check",
  ],
  ["github_publication_proposal", "github_publication_proposal_kind_check"],
  ["github_publication_proposal", "github_publication_proposal_pk"],
  ["github_publication_proposal", "github_publication_proposal_record_check"],
  ["hosted_github_installation", "hosted_github_installation_account_id_check"],
  [
    "hosted_github_installation",
    "hosted_github_installation_account_type_check",
  ],
  ["hosted_github_installation", "hosted_github_installation_id_check"],
  ["hosted_github_installation", "hosted_github_installation_pk"],
  [
    "hosted_github_installation_binding",
    "hosted_github_installation_binding_account_id_check",
  ],
  [
    "hosted_github_installation_binding",
    "hosted_github_installation_binding_account_type_check",
  ],
  [
    "hosted_github_installation_binding",
    "hosted_github_installation_binding_id_check",
  ],
  [
    "hosted_github_installation_binding",
    "hosted_github_installation_binding_pk",
  ],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_idempotency_check",
  ],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_kind_check",
  ],
  ["hosted_github_publication_journal", "hosted_github_publication_journal_pk"],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_proposal_digest_check",
  ],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_receipt_digest_check",
  ],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_record_check",
  ],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_status_check",
  ],
  [
    "hosted_github_publication_journal",
    "hosted_github_publication_journal_timestamp_check",
  ],
  [
    "hosted_github_publication_proposal",
    "hosted_github_publication_proposal_digest_check",
  ],
  [
    "hosted_github_publication_proposal",
    "hosted_github_publication_proposal_idempotency_check",
  ],
  [
    "hosted_github_publication_proposal",
    "hosted_github_publication_proposal_kind_check",
  ],
  [
    "hosted_github_publication_proposal",
    "hosted_github_publication_proposal_pk",
  ],
  [
    "hosted_github_publication_proposal",
    "hosted_github_publication_proposal_record_check",
  ],
  ["hosted_vercel_installation", "hosted_vercel_installation_pk"],
  ["hosted_vercel_installation", "hosted_vercel_installation_scope_type_check"],
  ["hosted_workspace_membership", "hosted_workspace_membership_pk"],
  ["jwks", "jwks_pkey"],
  ["oauth_access_token", "oauth_access_token_client_id_fkey"],
  ["oauth_access_token", "oauth_access_token_pkey"],
  ["oauth_access_token", "oauth_access_token_refresh_id_fkey"],
  ["oauth_access_token", "oauth_access_token_session_id_fkey"],
  ["oauth_access_token", "oauth_access_token_user_id_fkey"],
  ["oauth_client", "oauth_client_pkey"],
  ["oauth_client", "oauth_client_user_id_fkey"],
  ["oauth_client_assertion", "oauth_client_assertion_pkey"],
  ["oauth_client_resource", "oauth_client_resource_client_id_fkey"],
  ["oauth_client_resource", "oauth_client_resource_pkey"],
  ["oauth_client_resource", "oauth_client_resource_resource_id_fkey"],
  ["oauth_consent", "oauth_consent_client_id_fkey"],
  ["oauth_consent", "oauth_consent_pkey"],
  ["oauth_consent", "oauth_consent_user_id_fkey"],
  ["oauth_refresh_token", "oauth_refresh_token_client_id_fkey"],
  ["oauth_refresh_token", "oauth_refresh_token_pkey"],
  ["oauth_refresh_token", "oauth_refresh_token_session_id_fkey"],
  ["oauth_refresh_token", "oauth_refresh_token_user_id_fkey"],
  ["oauth_resource", "oauth_resource_pkey"],
  ["passkey", "passkey_pkey"],
  ["passkey", "passkey_user_id_fkey"],
  ["passkey_onboarding", "passkey_onboarding_pkey"],
  ["passkey_onboarding", "passkey_onboarding_time_check"],
  ["personal_workspace", "personal_workspace_organization_id_fkey"],
  ["personal_workspace", "personal_workspace_pkey"],
  ["personal_workspace", "personal_workspace_user_id_fkey"],
  ["sandbox_execution_lease", "sandbox_execution_lease_epoch_check"],
  ["sandbox_execution_lease", "sandbox_execution_lease_policy_digest_check"],
  ["sandbox_execution_lease", "sandbox_execution_lease_release_check"],
  ["sandbox_execution_lease", "sandbox_execution_lease_state_check"],
  ["sandbox_execution_lease", "sandbox_execution_lease_tenant_pk"],
  ["sandbox_execution_lease", "sandbox_execution_lease_time_check"],
  ["session", "session_pkey"],
  ["session", "session_user_id_fkey"],
  ["user", "user_pkey"],
  [
    "vercel_installation_authorization_state",
    "vercel_installation_authorization_authority_digest_check",
  ],
  [
    "vercel_installation_authorization_state",
    "vercel_installation_authorization_state_consumed_check",
  ],
  [
    "vercel_installation_authorization_state",
    "vercel_installation_authorization_state_digest_check",
  ],
  [
    "vercel_installation_authorization_state",
    "vercel_installation_authorization_state_pkey",
  ],
  [
    "vercel_installation_authorization_state",
    "vercel_installation_authorization_state_time_check",
  ],
  ["verification", "verification_pkey"],
] as const;

const migrationRowSchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{64}$/u),
    createdAt: z.string().regex(/^\d+$/u),
  })
  .strict();
const columnRowSchema = z
  .object({
    table: z.string(),
    column: z.string(),
    type: z.string(),
    notNull: z.boolean(),
  })
  .strict();
const namedObjectRowSchema = z
  .object({ table: z.string(), name: z.string() })
  .strict();

export const hostedStorageReadBackSchema = z
  .object({
    transactionReadOnly: z.literal(true),
    migrations: z.array(migrationRowSchema),
    columns: z.array(columnRowSchema),
    indexes: z.array(namedObjectRowSchema),
    constraints: z.array(namedObjectRowSchema),
  })
  .strict();

export type HostedStorageReadBack = z.infer<typeof hostedStorageReadBackSchema>;

export async function loadHostedStorageContract(repositoryRoot: string) {
  const [migrationFiles, rawJournal] = await Promise.all([
    Promise.all(
      hostedStorageMigrationTags.map(async (tag) => ({
        tag,
        content: await readFile(
          resolve(repositoryRoot, "drizzle", `${tag}.sql`),
          "utf8",
        ),
      })),
    ),
    readFile(resolve(repositoryRoot, "drizzle/meta/_journal.json"), "utf8"),
  ]);
  const journal = z
    .object({
      version: z.literal("7"),
      dialect: z.literal("postgresql"),
      entries: z.array(
        z
          .object({
            idx: z.number().int().nonnegative(),
            version: z.literal("7"),
            when: z.number().int().positive(),
            tag: z.string(),
            breakpoints: z.literal(true),
          })
          .strict(),
      ),
    })
    .strict()
    .parse(JSON.parse(rawJournal));
  if (
    JSON.stringify(journal.entries.map(({ idx }) => idx)) !==
      JSON.stringify(hostedStorageMigrationTags.map((_, index) => index)) ||
    JSON.stringify(journal.entries.map(({ tag }) => tag)) !==
      JSON.stringify(hostedStorageMigrationTags) ||
    journal.entries.some(
      (entry, index) =>
        index > 0 && entry.when <= journal.entries[index - 1]!.when,
    )
  ) {
    throw new Error("Hosted storage migration journal is not exact.");
  }
  for (const migration of migrationFiles) {
    const isApprovedIndexReplacement =
      migration.tag === "0014_tenant_github_installation_uniqueness" &&
      /^DROP INDEX IF EXISTS "hosted_github_installation_id_uidx";\nDROP INDEX IF EXISTS "hosted_github_installation_binding_id_uidx";\nCREATE UNIQUE INDEX "hosted_github_installation_binding_id_tenant_uidx"[\s\S]*$/u.test(
        migration.content,
      );
    if (
      (!isApprovedIndexReplacement &&
        /\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/iu.test(migration.content)) ||
      (![
        "0009_builder_provider_integrations",
        "0010_better_auth_organizations",
        "0011_self_service_onboarding",
        "0012_provider_connection_return_state",
      ].includes(migration.tag) &&
        /\b(?:UPDATE|INSERT\s+INTO)\b/iu.test(migration.content)) ||
      /\bALTER\b[\s\S]*\bDROP\b/iu.test(migration.content)
    ) {
      throw new Error("Hosted storage migration is not additive-only.");
    }
  }
  const sourceFiles = await Promise.all(
    contractSourcePaths.map(async (path) => ({
      path,
      digest: sha256(await readFile(resolve(repositoryRoot, path), "utf8")),
    })),
  );
  const migrations = migrationFiles.map(({ tag, content }, index) => ({
    tag,
    hash: sha256(content),
    createdAt: String(journal.entries[index]!.when),
  }));
  return {
    migrations,
    migrationDigest: sha256(JSON.stringify(migrations)),
    storageContractDigest: sha256(JSON.stringify(sourceFiles)),
  };
}

function tupleColumns(rows: HostedStorageReadBack["columns"]) {
  return rows.map((row) => [row.table, row.column, row.type, row.notNull]);
}

function tupleObjects(rows: Array<{ table: string; name: string }>) {
  return rows.map((row) => [row.table, row.name]);
}

export async function verifyHostedStorageReadBack(input: {
  repositoryRoot: string;
  readBack: unknown;
  observedAt: Date;
}) {
  const readBack = hostedStorageReadBackSchema.parse(input.readBack);
  const contract = await loadHostedStorageContract(input.repositoryRoot);
  if (!Number.isFinite(input.observedAt.getTime())) {
    throw new Error("Hosted storage observation time is invalid.");
  }
  if (
    JSON.stringify(readBack.migrations) !==
    JSON.stringify(
      contract.migrations.map(({ hash, createdAt }) => ({ hash, createdAt })),
    )
  ) {
    throw new Error("Hosted storage migration order or digest drifted.");
  }
  const migrationTimes = readBack.migrations.map(({ createdAt }) =>
    BigInt(createdAt),
  );
  if (
    migrationTimes.some(
      (value, index) => index > 0 && value <= migrationTimes[index - 1]!,
    )
  ) {
    throw new Error("Hosted storage migration journal order is invalid.");
  }
  if (
    JSON.stringify(tupleColumns(readBack.columns)) !==
      JSON.stringify(hostedStorageExpectedColumns) ||
    JSON.stringify(tupleObjects(readBack.indexes)) !==
      JSON.stringify(hostedStorageExpectedIndexes) ||
    JSON.stringify(tupleObjects(readBack.constraints)) !==
      JSON.stringify(hostedStorageExpectedConstraints)
  ) {
    throw new Error("Hosted storage managed schema drifted.");
  }
  const schemaEvidence = {
    columns: readBack.columns,
    indexes: readBack.indexes,
    constraints: readBack.constraints,
  };
  const unsigned = {
    version: 1 as const,
    format: "autograph-hosted-storage-readiness-v1" as const,
    status: "schema-verified" as const,
    observedAt: input.observedAt.toISOString(),
    database: {
      dialect: "postgresql" as const,
      verificationMode: "read-only-transaction" as const,
      maxConnections: 1 as const,
      connectionTimeoutSeconds: 5 as const,
      idleTimeoutSeconds: 5 as const,
      maximumLifetimeSeconds: 60 as const,
      statementTimeoutSeconds: 15 as const,
      lockTimeoutSeconds: 5 as const,
      idleInTransactionTimeoutSeconds: 15 as const,
    },
    migrations: {
      count: contract.migrations.length,
      exactOrder: true as const,
      noPendingMigration: true as const,
      additiveOnly: true as const,
      digest: contract.migrationDigest,
    },
    schema: {
      managedColumnCount: readBack.columns.length,
      managedIndexCount: readBack.indexes.length,
      managedConstraintCount: readBack.constraints.length,
      digest: sha256(JSON.stringify(schemaEvidence)),
    },
    authority: {
      tenantSessionPredicatesBound: true as const,
      liveMembershipPredicateBound: true as const,
      githubJournalCompareAndSetBound: true as const,
      githubJournalExcludedFromTenantRetention: true as const,
      oauthAuthorizationSchemaBound: true as const,
      sandboxExecutionLeaseBound: true as const,
      storageContractDigest: contract.storageContractDigest,
    },
    rollback: {
      destructiveMigrationDetected: false as const,
      automaticDownMigrationAvailable: false as const,
      providerRestorePointRequiredBeforeApply: true as const,
      providerRestorePointStatus: "not-proven" as const,
    },
    containsSecrets: false as const,
    containsTenantIdentifiers: false as const,
  };
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}
