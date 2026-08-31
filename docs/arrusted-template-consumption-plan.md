---
title: "App Builder consumption of the Arrusted template"
created_at: 2026-08-31
type: implementation-plan
topic: arrusted-template-consumption
status: active
---

# App Builder consumption of the Arrusted template

Every new App Builder application starts with a detached clone of the private
`https://github.com/withAutograph/arrusted-development.git` at
`refs/heads/main`. The source transport resolves that ref once, records the
observed commit/tree, verifies the successful Arrusted `Template readiness`
GitHub Check Run for that exact SHA, and runs the repository-owned planning,
generation, and validation contract from that exact source. App Builder does
not reconstruct a starter project from a generic internal template.

## Clone boundary

The canonical remote and ref are constants, never user input. The source
transport mints one per-acquisition installation token through the existing
Autograph GitHub App. Its only deployment configuration beyond the existing
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` is
`APP_BUILDER_TEMPLATE_READER_INSTALLATION_ID`. That installation must be in
selected-repositories mode and contain exactly the one private repository
`withAutograph/arrusted-development`; it is never selected from a user’s
publishing installation.

This deliberately accepts the existing App private key’s shared-registration
blast radius: the dedicated installation narrows routine reader tokens, but is
not equivalent to a separate reader App.

The token request is constrained to `Contents: read` and `Checks: read`.
App Builder validates both the token permissions and the installation’s live
repository inventory before cloning. It uses the token only to validate that
inventory, make the one direct workspace clone, and read Check Runs for the
resolved SHA. The source transport writes it only to a temporary owner-only
askpass credential file, removes the file on every success or failure path,
and restores `deny-all` networking after cloning. It disables prompts,
inherited Git configuration, hooks, SSH/file protocols, and submodules, and
refuses an origin, ref, tree, or clean-worktree mismatch. The token, reader
installation ID, authorization header, and credential digest never appear in
the receipt, Git remote/config, persisted sandbox files, or command output.

An existing repository remains an explicit allowlisted local source. It never
falls through to the fresh-template clone path.

## Provenance and execution

New template clones produce source-receipt V4. The receipt binds the canonical
repository, requested ref, source SHA/tree, adapter eligibility and contract
digests, and a digest of the successful readiness Check Run's immutable
metadata (ID, name, completion time, and conclusion). Before fixed target
commands, the locked dependency closure is bootstrapped once under a fixed
allowlist, keyed by source SHA and sandbox platform, made read-only, and
followed by a restored `deny-all` network policy. V3 receipts remain readable
for sessions that began before clone provenance existed.

## Readiness admission

Arrusted CI runs `mise run repository:template-readiness -- --expected-sha <sha>`
in its `Template readiness` job. It produces its own sanitized JSON attestation,
while App Builder independently checks the completed successful Check Run through
GitHub's commit Check Runs API using the reader token and records the metadata
digest above. The Check Run is admission evidence only; it is not a control
file, provider credential, or authorization for any App Builder provider
mutation.

A newly pushed Arrusted `main` commit is unavailable to new-app sessions until
that exact commit's `Template readiness` job has completed successfully. The
resolver stops before dependency bootstrap or target commands when the evidence
is missing, pending, failed, malformed, or bound to another SHA/tree. This
makes the Arrusted push and its CI proof an ordered deployment boundary rather
than treating a default-branch update as readiness by itself.

App Builder performs one fixed HTTPS detached clone directly into the
session-owned `/workspace/repository`. That checkout resolves the ref, emits
the closed source-inspection snapshot used for the V4 receipt, and becomes the
prepared workspace after exact-SHA readiness admission. It verifies the
remote, ref, SHA, tree, clean status, and submodule absence before recording
the prepared-workspace manifest. Approval and preparation re-verify that same
checkout; they do not fetch, clone, or reconstruct it. All fixed repository
planning, generation, apply, and validation commands run from this detached
workspace clone. It is never mutated by user work or published directly.

Fresh-repository publication still requires its own approval and provider
read-back. Its result is a new parentless `main` commit containing the reviewed
generated workspace, not Arrusted history or an upstream remote.

## Validation

The source boundary is tested for exact requested reader permissions, rejection
of unavailable, broad, or mismatched installations, canonical origin/ref
resolution, detached checkout state, immutable V4 receipt validation, clone
drift rejection, and token cleanup on success and failure. Explicit existing
repository behavior remains unchanged. Local and hosted runtime paths use the
same clone provenance contract and fail closed before bootstrap when reader
configuration, token minting, cloning, or readiness evidence is unavailable.
