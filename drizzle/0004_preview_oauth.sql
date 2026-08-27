CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_uidx" ON "user" ("email");
--> statement-breakpoint
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_uidx" ON "session" ("token");
--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");
--> statement-breakpoint
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "issuer" text NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_account_id_uidx" ON "account" ("issuer", "account_id");
--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");
--> statement-breakpoint
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
--> statement-breakpoint
CREATE TABLE "jwks" (
  "id" text PRIMARY KEY NOT NULL,
  "public_key" text NOT NULL,
  "private_key" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "alg" text,
  "crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "client_secret" text,
  "client_discovery_id" text,
  "disabled" boolean DEFAULT false,
  "skip_consent" boolean,
  "enable_end_session" boolean,
  "subject_type" text,
  "scopes" text[],
  "client_credentials_scopes" text[] DEFAULT '{}',
  "user_id" text REFERENCES "user"("id"),
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text[],
  "tos" text,
  "policy" text,
  "software_id" text,
  "software_version" text,
  "software_statement" text,
  "redirect_uris" text[] NOT NULL,
  "post_logout_redirect_uris" text[],
  "backchannel_logout_uri" text,
  "backchannel_logout_session_required" boolean,
  "token_endpoint_auth_method" text,
  "application_type" text,
  "jwks" text,
  "jwks_uri" text,
  "grant_types" text[],
  "response_types" text[],
  "require_pkce" boolean,
  "dpop_bound_access_tokens" boolean DEFAULT false,
  "reference_id" text,
  "metadata" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_client_id_uidx" ON "oauth_client" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauth_client_user_id_idx" ON "oauth_client" ("user_id");
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "name" text NOT NULL,
  "access_token_ttl" integer,
  "refresh_token_ttl" integer,
  "signing_algorithm" text,
  "signing_key_id" text,
  "allowed_scopes" text[],
  "custom_claims" jsonb,
  "dpop_bound_access_tokens_required" boolean DEFAULT false,
  "disabled" boolean DEFAULT false,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "policy_version" integer DEFAULT 1,
  "metadata" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_resource_identifier_uidx" ON "oauth_resource" ("identifier");
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "resource_id" text NOT NULL REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE,
  "metadata" jsonb,
  "created_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_resource_client_resource_uidx" ON "oauth_client_resource" ("client_id", "resource_id");
--> statement-breakpoint
CREATE INDEX "oauth_client_resource_client_id_idx" ON "oauth_client_resource" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauth_client_resource_resource_id_idx" ON "oauth_client_resource" ("resource_id");
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id"),
  "session_id" text REFERENCES "session"("id") ON DELETE SET NULL,
  "user_id" text NOT NULL REFERENCES "user"("id"),
  "reference_id" text,
  "authorization_code_id" text,
  "resources" text[],
  "requested_user_info_claims" text[],
  "expires_at" timestamptz,
  "created_at" timestamptz,
  "revoked" timestamptz,
  "rotated_at" timestamptz,
  "rotation_replay_response" text,
  "rotation_replay_expires_at" timestamptz,
  "auth_time" timestamptz,
  "confirmation" jsonb,
  "scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_refresh_token_token_uidx" ON "oauth_refresh_token" ("token");
--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_client_id_idx" ON "oauth_refresh_token" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_session_id_idx" ON "oauth_refresh_token" ("session_id");
--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_user_id_idx" ON "oauth_refresh_token" ("user_id");
--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_authorization_code_id_idx" ON "oauth_refresh_token" ("authorization_code_id");
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id"),
  "session_id" text REFERENCES "session"("id") ON DELETE SET NULL,
  "user_id" text REFERENCES "user"("id"),
  "reference_id" text,
  "authorization_code_id" text,
  "resources" text[],
  "requested_user_info_claims" text[],
  "refresh_id" text REFERENCES "oauth_refresh_token"("id"),
  "expires_at" timestamptz,
  "created_at" timestamptz,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_token_token_uidx" ON "oauth_access_token" ("token");
--> statement-breakpoint
CREATE INDEX "oauth_access_token_client_id_idx" ON "oauth_access_token" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauth_access_token_session_id_idx" ON "oauth_access_token" ("session_id");
--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_idx" ON "oauth_access_token" ("user_id");
--> statement-breakpoint
CREATE INDEX "oauth_access_token_authorization_code_id_idx" ON "oauth_access_token" ("authorization_code_id");
--> statement-breakpoint
CREATE INDEX "oauth_access_token_refresh_id_idx" ON "oauth_access_token" ("refresh_id");
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id"),
  "user_id" text REFERENCES "user"("id"),
  "reference_id" text,
  "resources" text[],
  "requested_user_info_claims" text[],
  "scopes" text[] NOT NULL,
  "created_at" timestamptz,
  "updated_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "oauth_consent_client_id_idx" ON "oauth_consent" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_idx" ON "oauth_consent" ("user_id");
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamptz NOT NULL
);
