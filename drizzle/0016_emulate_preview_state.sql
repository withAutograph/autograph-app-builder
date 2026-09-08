CREATE TABLE "emulate_preview_state" (
	"namespace" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "emulate_preview_state_namespace_check" CHECK (length("namespace") BETWEEN 3 AND 1024),
	CONSTRAINT "emulate_preview_state_state_check" CHECK (octet_length("state") BETWEEN 2 AND 8388608),
	CONSTRAINT "emulate_preview_state_timestamp_check" CHECK ("created_at" <= "updated_at")
);
