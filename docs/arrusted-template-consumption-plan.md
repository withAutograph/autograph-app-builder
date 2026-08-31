---
title: "App Builder consumption of the Arrusted template"
created_at: 2026-08-31
type: implementation-plan
topic: arrusted-template-consumption
status: active
---

# App Builder consumption of the Arrusted template

Every new App Builder application starts with a detached clone of
`https://github.com/withAutograph/arrusted-development.git` at
`refs/heads/main`. The source transport resolves that ref once, records the
observed commit/tree, verifies the successful Arrusted `Template readiness`
check for that exact SHA, and runs the repository-owned planning, generation,
and validation contract from that exact source. App Builder does not
reconstruct a starter project from a generic internal template.

## Clone boundary

The canonical remote and ref are constants, never user input. The source
transport uses an empty credential environment, disables prompts, inherited Git
configuration, hooks, SSH/file protocols, and submodules, and refuses an origin,
ref, tree, or clean-worktree mismatch. This is host protection before template
bytes are trusted; the corresponding Arrusted readiness contract owns the
template's submodule, LFS, lockfile, and application-command guarantees.

An existing repository remains an explicit allowlisted local source. It never
falls through to the fresh-template clone path.

## Provenance and execution

New template clones produce source-receipt V4. The receipt binds the canonical
repository, requested ref, source SHA/tree, adapter eligibility and contract
digests, and the successful readiness-check attestation digest. Before fixed
target commands, the locked dependency closure is bootstrapped once under a
fixed allowlist, keyed by source SHA and sandbox platform, made read-only, and
followed by a restored `deny-all` network policy. V3 receipts remain readable for sessions
that began before clone provenance existed.

The reviewed clone is copied into the session-owned workspace and all fixed
repository planning, generation, apply, and validation commands operate from
that workspace. The original clone is never mutated by user work or published
directly.

Fresh-repository publication still requires its own approval and provider
read-back. Its result is a new parentless `main` commit containing the reviewed
generated workspace, not Arrusted history or an upstream remote.

## Validation

The source boundary is tested for canonical origin/ref resolution, detached
checkout state, immutable V4 receipt validation, clone drift rejection, and
the unchanged behavior of explicit existing repositories. Local and hosted
runtime paths use the same clone provenance contract for new apps.
