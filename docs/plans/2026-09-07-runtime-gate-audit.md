# Active runtime gate audit

Do not start another full walkthrough merely to discover predictable preconditions. This audit is incomplete until the outstanding items below are resolved.

## Removed in this change

- App Builder's five-minute validation-command deadline.
- App Builder's fifteen-minute installation, generation, snapshot, and cache-link deadlines. Provider failures and user cancellation remain authoritative.
- Planning's 1 MiB command-output cap, 32-change limit, and 256 KiB-per-change limit. Actual JSON/schema parsing remains required.
- The mandatory topology-file read/digest for existing-app planning. Selected app identity and change preimages remain bound to the intended work.
- Readiness comparisons between observed cache receipt/manifest/content/layout metadata and the recorded cache. Exact Git/mise/Bun version matching is also removed; required executable availability is still reported and checked.

## Outstanding active checks

- `lib/agent/target-execution.ts`: source-workspace inspection and the combined proposal/source/dependency/image identity binding remain. Actual backend/image resolution remains required. A cache miss can still leave the image unresolved; this change does not claim that all cache-miss blockers are eliminated. `agent/tools/target_execution_status.ts` calls it in the live tool path.
- Planning and application also contain selected-proposal/content checks. These must be distinguished from incidental cache and source metadata: removing them indiscriminately can apply different work than the user approved.

The initial combined removal was rejected by the execution safety reviewer. The user then explicitly approved separate capacity/metadata cleanup while preserving approved-work checks. The planning changes above were permitted; removing the combined execution-readiness checks was rejected again. Those readiness checks initially remained unchanged. A later explicit function-specific authorization permitted removal of observed-cache equality and exact-version comparisons. Source inspection/image configuration removal was rejected again; those portions remain unchanged, and no workaround was attempted.

## Kept

Credential protection, cross-user session isolation, actual command errors, explicit Build approval, and separate approval for repository publication and other outward effects. Networking remains `allow-all`.

## Evidence

Focused target-validation tests: 6 passed. Focused planning tests: 6 passed. Existing target-execution tests: 5 passed; these cover preserved proposal bindings and environment resolution, not a new end-to-end cache-miss proof. No new full walkthrough was started for this audit. This is not a claim that all runtime gates have been removed.
