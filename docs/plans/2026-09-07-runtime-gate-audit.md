# Active runtime gate audit

Do not start another full walkthrough merely to discover predictable preconditions.
This audit is incomplete until the outstanding items below are resolved.

## Removed in this change

- App Builder's five-minute validation-command deadline.
- App Builder's fifteen-minute installation, generation, snapshot, and cache-link
  deadlines. Provider failures and user cancellation remain authoritative.

## Outstanding active checks

- `lib/repository/target-planning.ts`: 1 MiB command-output cap, 32-change and
  256 KiB-per-change limits, mandatory existing-app topology read, and missing
  changes rejection.
- `lib/agent/target-execution.ts`: readiness inspection still compares
  dependency/source/workspace/image/identity receipts and exact tool versions.
  `agent/tools/target_execution_status.ts` calls it in the live tool path.
- Planning and application also contain selected-proposal/content checks. These
  must be distinguished from incidental cache and source metadata: removing
  them indiscriminately can apply different work than the user approved.

The attempted combined removal of the outstanding checks was rejected by the
execution safety reviewer. No equivalent removal was retried. Separate ordinary
capacity/metadata cleanup from changes that could alter the selected work, and
obtain a scoped decision before proceeding with the rejected changes.

## Kept

Credential protection, cross-user session isolation, actual command errors,
explicit Build approval, and separate approval for repository publication and
other outward effects. Networking remains `allow-all`.

## Evidence

Focused target-validation tests: 6 passed. No new full walkthrough was started
for this audit. This is not a claim that all runtime gates have been removed.
