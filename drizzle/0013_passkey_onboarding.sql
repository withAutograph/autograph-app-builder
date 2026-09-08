CREATE TABLE "passkey" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "public_key" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL,
  "counter" integer NOT NULL,
  "device_type" text NOT NULL,
  "backed_up" boolean NOT NULL,
  "transports" text,
  "created_at" timestamptz,
  "aaguid" text
);

CREATE UNIQUE INDEX "passkey_credential_id_uidx" ON "passkey" ("credential_id");
CREATE INDEX "passkey_user_id_idx" ON "passkey" ("user_id");

CREATE TABLE "passkey_onboarding" (
  "id" text PRIMARY KEY NOT NULL,
  "token_digest" text NOT NULL,
  "deployment_id" text NOT NULL,
  "origin" text NOT NULL,
  "rp_id" text NOT NULL,
  "user_handle" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "passkey_onboarding_time_check" CHECK ("created_at" < "expires_at")
);

CREATE UNIQUE INDEX "passkey_onboarding_token_digest_uidx" ON "passkey_onboarding" ("token_digest");
CREATE UNIQUE INDEX "passkey_onboarding_user_handle_uidx" ON "passkey_onboarding" ("user_handle");
CREATE INDEX "passkey_onboarding_expires_at_idx" ON "passkey_onboarding" ("expires_at");
