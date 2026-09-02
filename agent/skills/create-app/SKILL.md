---
name: create-app
description: Guide complete creation of a route-owned Next.js app in a supported Autograph repository, from product design through a usable prototype, implementation plan, reviewed changes, and separately approved publication. Use as the primary entry point when a user asks to create, build, or start a new app. Route explicitly bare/local-only Next.js workspace requests to $scaffold-app-workspace.
---

# Create App

Create one validated local app without crossing provider or deployment authority.
Keep product acceptance separate from approval to mutate source and topology.

Use only discovered builder-owned tools. If the required identity, planning,
prototype, apply, review, or publication operation is unavailable, stop at the
last completed receipt and report that implementation gap. Never replace a
missing operation with a raw shell command or generic file write.

## Workflow

1. If the user explicitly requests only a bare Next.js workspace, follow
   [$scaffold-app-workspace](../scaffold-app-workspace/SKILL.md) and stop this
   route-owned flow. Do not interpret a generic “create an app” request as bare
   scaffolding.
2. Resolve one concise user-facing app name and one lowercase kebab-case app id.
   Preserve each explicitly supplied valid value. When either is omitted, infer
   it from the product brief, tell the user the inferred value in one short
   sentence, and continue without confirmation. Derive an inferred id
   deterministically from the chosen name by lowercasing it, replacing each run
   of non-alphanumeric characters with one hyphen, and trimming hyphens. Ask
   only when the result is unsupported, the prepared source proves a real
   workspace/package/prototype collision, or the brief is materially ambiguous.
   The selected adapter's builder-owned identity operation remains authoritative
   for target planning; never construct or guess a repository script path.

3. After an eligible exact source receipt is resolved, automatically inspect
   the source read-only and prepare its isolated builder-owned workspace. Use
   `source_status` once to begin a normal new-app flow; an empty hosted source
   state acquires and internally binds the canonical starter without another
   model-selected setup operation. Do not require `inspect_source` or
   `approve_source_acquisition` on that path. Use
   the runtime's single preselected existing-repository snapshot during local
   development without asking for or displaying its host path. Outside that
   closed binding, retain the explicit allowlisted-path requirement. In hosted
   execution, an inspection or iteration of an app already present in canonical
   Arrusted uses the builder-owned canonical clone as the `fresh-template`
   transport. Do not ask the user for a local checkout path in that case.
   Use
   `workspace_status` to verify preparation, then perform known file reads under
   the exact absolute `workspacePath` returned by preparation. Never pass that
   sandbox path or an internal hosted artifact path to `inspect_repository`.
   Inspect existing workspace identities, current topology, and
   `prototype/<app-id>/app-spec.md`. Do not request approval for supported-source
   inspection, workspace preparation, or non-published prototype artifacts.
   Preserve unrelated changes.
   For a hosted existing repository named as `owner/name`, use only
   `resolve_github_source`; it owns the current access readback, source
   inspection, and isolated preparation without a preceding access tool. When
   it requests GitHub authorization, allow the structured Store In control to
   collect or expand repository access and wait for the parked turn to resume.
   Never ask “Repository selected?”, treat the user's answer as provider
   authority, or request installation/repository ids, SHAs, trees, settings
   changes, or other access mechanics in chat. When the tool returns
   `scope-selection-required`, present its one product-facing GitHub-account
   choice using the exact installation ids as option ids, then retry
   `resolve_github_source` with the selected `selectedInstallationId`. Do not
   make scopes selectable inside an authorization request.
4. If the conventional AppSpec is absent or incomplete, follow
   [$design-app](../design-app/SKILL.md) in this same task. Synthesize its
   build-ready handoff from stated decisions and safe revisable defaults, then
   validate and record it silently. If validation reports technical or schema
   errors, repair completeness and retry automatically. Ask only when an
   unresolved choice materially changes the product; otherwise do not prompt
   for artifact recording or formal AppSpec acceptance.
5. Follow [$plan-app-creation](../plan-app-creation/SKILL.md) automatically to
   produce the canonical validated proposal. A prose outline is not a plan:
   never finish an app-creation turn or claim the plan is ready until
   `plan_app_creation` succeeds for the current artifact bytes. If the visual
   prototype is ready first, continue the silent workflow. For an existing app,
   when planning identifies a replacement without an exact preimage, inspect
   only the exact app-owned paths returned by that error, rebuild the
   replacements, and retry planning without resolving or preparing the source
   again. Never expose this repair or substitute prose. Return only product
   blockers without workarounds or internal validator mechanics.
6. Present the usable prototype and complete proposal, then continue through
   builder-owned preparation, checks, and review automatically and silently.
   Never invoke the target command through generic shell access.
7. Use only the discovered `apply_app_creation` tool. It must rerun readiness,
   bind the exact proposal and earlier receipts, and write only its fresh
   builder-owned overlay. If it records partial failure, stop in
   recovery-required state without automatic retry.
8. After the app changes are prepared, run the fixed local checks automatically.
   The validation tool must persist its pending receipt
   before execution, run only the fixed check and test commands in independent
   copies of the exact applied tree, and stop on pending or failed state without
   automatic redispatch.
9. After checks pass, use `change_set_status` and `accept_change_set` internally
   to recompute the exact proposal and record the durable reviewed receipt.
   Show the complete ordered product/code changes in plain language and offer
   one concrete repository or draft-pull-request next step. Stop unless the
   user chooses to continue. Only then request a separate effect-based approval
   before applying the reviewed paths to a named existing checkout or
   publishing them. One approval never authorizes another outcome.
   Keep internal execution mechanics and no-authority boilerplate out of the
   public conversation.

## Boundaries

- Infer only safe, revisable prototype defaults. Never infer Production
  authority. Never mutate the prepared source or target checkout, or publish
  reviewed changes, without effect-based approval for that exact outcome.
- Never use `$scaffold-app-workspace` as the apply step for a planned route-owned
  app; the complete command owns contract, workspace, and topology composition.
- Never create schema contents merely because the proposal derives a kernel
  schema path.
- Never publish without the separate publication approval. Never reconcile providers, mutate `amp.yaml`, create secrets or environment
  configuration, deploy, or claim admission or Production readiness.
- If the complete command reports stale, conflicting, or ambiguous recovery
  state, reconcile it automatically when safe. Otherwise translate the visible
  product effect into one recommended product choice or an unavailable outcome
  with an alternative. Do not delete or overwrite user-modified state.
- Keep every public update product-facing. Never name internal specifications
  or acceptance, artifact recording, receipts, digests, workspace/source
  machinery, validation gates, protocol operations, or opaque validator and
  blocker copy. Translate unavoidable constraints into the smallest
  product-domain question with a recommended default, or offer a product-level
  alternative when no answer can make the requested outcome available.
