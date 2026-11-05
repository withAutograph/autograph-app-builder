# Local recovered session projection

Local Builder development keeps one logical public session while native Eve can
move its executor through ordinary source handoffs. A response stream opened
before that handoff can remain attached to an older executor. It must not hide a
later genuine approval decision or leave an already answered card actionable.

For recovered local sessions, public reads and pre-control reconciliation must
observe the complete current native snapshot through the existing owned recovery
lineage, including while an earlier response reader remains open. Reconcile only
the read projection. Keep its shared event array alive for existing readers;
retain every prior event unchanged and in order. Admit a repeated immutable event
once, reject conflicting IDs or reordered history, and append only independently
observed native events. Concurrent snapshot and stream reads must not duplicate
public events or replace a reader's array.

This changes no workflow journal, approval, execution result, recovery receipt,
native executor selection or provider operation. A completed prior response is
not resubmitted. An unknown response remains unknown. Conflicting or incomplete
native history fails closed, preserving the saved session and evidence.

Qualification must reproduce an open old response reader while a current native
snapshot contains its real resolution and a later input batch. Public GET must
show only that current batch; a normal response must target it once. Also verify
late duplicate stream events, conflicts, reordered history, unchanged public
cursors and the existing nonrecovered local path. Then observe the same saved app
through the public interface before claiming runtime recovery.
