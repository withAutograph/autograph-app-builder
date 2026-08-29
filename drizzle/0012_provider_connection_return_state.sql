ALTER TABLE "vercel_installation_authorization_state"
  ADD COLUMN "return_to" text NOT NULL DEFAULT '/';
--> statement-breakpoint
ALTER TABLE "vercel_installation_authorization_state"
  ADD COLUMN "resume_key" text;
--> statement-breakpoint
ALTER TABLE "github_installation_authorization_state"
  ADD COLUMN "return_to" text NOT NULL DEFAULT '/';
--> statement-breakpoint
ALTER TABLE "github_installation_authorization_state"
  ADD COLUMN "resume_key" text;
