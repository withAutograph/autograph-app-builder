CREATE TABLE "hosted_workspace_membership" (
  "issuer" text NOT NULL,
  "audience" text NOT NULL,
  "workspace_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "hosted_workspace_membership_pk" PRIMARY KEY (
    "issuer", "audience", "workspace_id", "owner_user_id"
  )
);
