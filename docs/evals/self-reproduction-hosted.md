# Hosted self-reproduction eval

The on-demand GitHub workflow runs on an Ubuntu runner. It calls the App Builder's
`POST /api/evals/self-reproduction` controller using GitHub OIDC; the controller
starts a detached Vercel Sandbox with its own project OIDC. Neither a self-hosted
runner nor a static Vercel key is required. Generation and comparison use the same
`mise run eval:self-reproduction` entrypoint as local runs.

Implementation is integrated locally. Hosted deployment, the first GitHub dispatch,
and end-to-end artifact retrieval still require acceptance; local tests do not
establish that these work in the deployed environment.

## Deployment configuration

Apply checked-in PostgreSQL migration `0022_hosted_self_reproduction` through the
normal migration task before enabling the controller. It adds durable run records
and private artifact storage. Existing application tables are unchanged.

The controller requires the linked deployment's `DATABASE_URL`,
`VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`, `VERCEL_ENV` (or `VERCEL_TARGET_ENV`), and
`VERCEL_GIT_COMMIT_SHA`. The existing deployment-owned Arrusted reader requires
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
`APP_BUILDER_TEMPLATE_READER_INSTALLATION_ID`. Its installation credential is
restricted to the canonical private Arrusted repository with read permissions.
App private keys and database credentials stay in the controller.

Set `SELF_REPRODUCTION_GITHUB_AUDIENCE` in the Vercel deployment and the same named
GitHub repository/environment variable. Set GitHub's
`SELF_REPRODUCTION_CONTROLLER_URL` to the full HTTPS controller endpoint. Removing
the deployment audience disables the endpoint. The workflow uses the
`self-reproduction` GitHub environment and accepts only `workflow_dispatch` from
`withAutograph/autograph-app-builder` on `refs/heads/main`. Repository ID, workflow,
ref, issuer, audience, and individual run/attempt are verified server-side.
The caller cannot choose source, prompts, commands, or another run's artifacts.

Dispatch **App Builder self-reproduction** from GitHub Actions after deployment
and migration. The client obtains a fresh GitHub token on every request, polls
status, and uploads retained evidence even when the evaluator fails. The status
is execution completion, not a product-quality passing score.

## Worker lifecycle

The worker clones the public Builder repository at the controller deployment's
revision and canonical Arrusted `main` using a short-lived reader token. It
installs the repository-owned toolchain and frozen dependencies, PostgreSQL and
Chromium, then runs the live eval with candidate runtime, capability probe,
reference runtime, and production navigation enabled. Source credentials are
removed before generation. Arrusted revision and generation evidence remain in
the report; the candidate is never patched by the evaluator.

The reference uses an isolated PostgreSQL process instead of Docker. This is an
explicit `--postgres-backend process` option; normal local runs retain Docker.
Sandbox networking remains `allow-all`, and persistence snapshots are disabled.
The worker has a 45-minute provider cleanup deadline. The GitHub client allows
50 minutes for completion and evidence retrieval within a 60-minute job.

On each authorized status call the controller obtains its current Vercel identity
and atomically replaces a private worker file outside source and reports. The
native evaluator verifies its project, owner, environment, signature and time
claims before using it. Its owned preload refreshes long-running child processes;
malformed or rejected replacements cannot overwrite the last verified identity.
This avoids assuming that the initial invocation token lasts for the entire eval.

Durable reservations prevent another worker from being launched for the same
GitHub run/attempt. Unknown creation outcomes remain interrupted; they do not
trigger a replacement generation. The controller retains private artifacts before
stopping a known worker. If the client disappears, the provider deadline still
bounds worker lifetime; missing collection remains missing evidence.

Artifacts are `worker.log` and `evidence.tar.gz`, containing reports, candidate
source and diagnostic captures while excluding runtime directories, dependencies,
environment files and symlinks. Authorized artifact responses are streamed with
private/no-store headers. Extract the archive locally to open `index.html`.
Partial evidence and failures must remain visible; no aggregate passing threshold
or hosted publication credit is inferred from a completed worker.

## Validation boundaries

Focused tests exercise signed workflow authorization, duplicate reservation and
stale updates, artifact isolation, worker bootstrap, private response streaming,
credential replacement, and client failure retention. Actual isolated PostgreSQL
acceptance verifies reservation races and artifact reads across new connections.
These are harness checks. A deployed controller, private template clone, live
worker, token renewal and GitHub artifact download still need a hosted acceptance
receipt before being reported as proven.

Official references: [Vercel OIDC](https://vercel.com/docs/oidc),
[response streaming](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions).
