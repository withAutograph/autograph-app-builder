# Builder draft maintenance

## Status: deferred deployment follow-up

The 30-day cleanup service and operator command are implemented. Scheduled
execution is deliberately deferred. This document does not authorize creation
of a scheduler, a production secret, or a production cleanup run.

## Existing operator command

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

## Proposed scheduled delivery

After explicit deployment approval, use a daily Vercel Cron invocation of a
dedicated authenticated maintenance Route Handler. Reuse the existing cleanup
service and deployment-managed database connection. Normal builder mutations
remain Server Actions; this endpoint is only a scheduler boundary.

- Configure a production-only `CRON_SECRET` through the approved project secret
  management process. Never commit or log its value.
- Reject missing or incorrect authorization before opening the database. Fail
  closed when the secret is absent; do not accept a cron user-agent as authority.
- Keep the fixed 30-day inactivity policy. Accept no tenant, cutoff, retention,
  or arbitrary deletion parameters from the caller.
- Delete only abandoned active drafts. Preserve archived drafts, recently saved
  drafts, and every durable handoff. Repeated invocations must be safe.
- Return sanitized success/failure information and record the removed count,
  without draft contents, credentials, or raw database errors.
- Do not introduce `after()` jobs, browser timers, or production database access
  from GitHub Actions to implement scheduling.

See [Vercel's cron authentication documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).

## Acceptance before enabling

1. Test missing/wrong credentials, an absent configured secret, and authorized
   invocation against an isolated database.
2. Verify the 30-day boundary, active-only deletion, tenant-independent cleanup,
   repeated invocation, and concurrent save/cleanup behavior using the actual
   database service. Recent saves must survive.
3. Verify failures remain observable without leaking sensitive details.
4. Obtain deployment approval, configure the production secret and schedule,
   and verify the deployed route and schedule match the reviewed commit.
5. Record the first scheduled invocation's result. Repository configuration or
   an operator command alone is not evidence of a deployed, working schedule.

To stop future execution, disable the schedule. That does not restore already
deleted drafts; recovery would require the deployment's existing backup process.
