CREATE TABLE "builder_handoff" (
  "handoff_id" text PRIMARY KEY NOT NULL,
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "creation_request_id" text NOT NULL,
  "request_digest" text NOT NULL,
  "intent" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "redeemed_at" timestamptz,
  "session_id" text,
  CONSTRAINT "builder_handoff_id_check"
    CHECK ("handoff_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "builder_handoff_creation_request_id_check"
    CHECK ("creation_request_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "builder_handoff_request_digest_check"
    CHECK ("request_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "builder_handoff_intent_check"
    CHECK (jsonb_typeof("intent") = 'object'),
  CONSTRAINT "builder_handoff_time_check"
    CHECK ("created_at" < "expires_at"),
  CONSTRAINT "builder_handoff_redemption_check"
    CHECK (
      ("redeemed_at" IS NULL AND "session_id" IS NULL) OR
      (
        "redeemed_at" BETWEEN "created_at" AND "expires_at" AND
        "session_id" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "builder_handoff_creation_uidx" ON "builder_handoff" (
  "issuer", "audience", "workspace_id", "owner_user_id", "creation_request_id"
);

CREATE INDEX "builder_handoff_expiry_idx" ON "builder_handoff" ("expires_at");
