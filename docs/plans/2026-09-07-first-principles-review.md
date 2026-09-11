# First-principles review

The product job is to turn a brief into a useful app, preserve the user's selected work, and obtain approval before consequential outward effects. An internal API should request only information it actually consumes.

## Deleted

- Ignored expected-digest inputs from workspace preparation, dependency setup, and planning. These operations already read their current session state; requiring the model to repeat unused values added no correctness.
- Unused session/environment arguments from dependency setup.
- The unused validation-overlay path helper and its self-referential test.
- Mock responses and eval assertions claiming stale planning/dependency inputs were rejected when the tools actually ignored those inputs.

Dependency setup documentation now describes its actual behavior: recording checkout-backed planning state, not installing or verifying a dependency cache. Repository execution remains responsible for actual installation failures.

## Deliberately unchanged

Approval, selected proposal/content checks, user isolation, credential handling, and the working sandbox execution path remain unchanged. Their removal is not needed to delete the unused APIs above.

Do not infer that a model-discovered tool is unused merely because ordinary code does not import it. Removing another tool or the dependency state machine requires evidence about its actual consumers, not just a reference search. No new framework, caching layer, automation, or runtime preflight is introduced.
