# Builder draft maintenance

Run `mise run maintenance:builder-drafts` from the checkout with the intended
deployment's existing managed environment. The command calls the shared cleanup
service and prints only the number removed. It deletes **active** drafts whose
last activity is more than 30 days old; archived drafts and durable handoffs are
not removed. This is database-wide maintenance across tenants, not a user-scoped
operation. It accepts no retention override.

This is an operator entry point, not an installed schedule. Before scheduling it,
the deployment operator must supply an approved scheduler and the existing
deployment environment/credential boundary. The repository currently has no
scheduled maintenance workflow or authenticated cron route. No new secret,
production database access from CI, or worker infrastructure is added here.

Do not run cleanup from user requests or Server Actions. The command exits
nonzero on failure without printing potentially sensitive database errors.
