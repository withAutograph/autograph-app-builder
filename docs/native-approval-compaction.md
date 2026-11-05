# Native approval delivery across compaction

The pinned Eve runtime must preserve the SDK's approval replay tail. AI SDK
collects approved tool calls from the final tool-role message. A user-role
resumption note after that message prevents execution and leaves the original
call without its result.

Eve's compaction resumption guard previously appended the last genuine user
message when compaction summarized it away. When the remaining tail held a
pending approved call, this moved the old message after its approval response.
The repository's maintained Eve patch now retains that original user before
recent messages, after an explicitly recognized compaction checkpoint/summary.
Without that prefix it inserts before the recent history. It preserves the
existing no-approval resumption behavior and never relocates a genuine new
message already retained in the recent window.

The lockfile binds this tracked package patch. Use the normal frozen install
and deliberate idle-boundary runtime restart; copying authored patch bytes
alone does not update an already installed or running runtime.

For an already failed private build, ordinary owner-authorized session recovery
uses the maintained native collector/reconciler. Only the exact retained private
apply scope can authorize its original repeatable call. With no recorded result,
provider execution, accepted pending input or coordination, that reconciler may
restore the existing genuine approved response to the SDK replay tail. It does
not fabricate a response, output, approval, grant or successful apply receipt.
The current tool executes normally and rechecks its own authority. This policy
does not apply to uncertain outward operations or the historical uncertain
Preview batch.

Focused regression tests execute real compaction, native collection and
reconciliation, and AI SDK approved-tool dispatch with controlled World/model
ports. They cover summarization, no-checkpoint heuristic compaction, retained
bad-tail recovery, denial, foreign pending scope and genuine new instructions.
Cancellation remains enforced at the actual effect guard: the SDK can invoke
an approved callback with an aborted signal, so authored effects must inspect
that signal before mutation. These tests are source qualification; the actual
saved app's recovered execution remains separate acceptance evidence.

### Local adapter qualification

The local terminal-recovery port applies the same existing pure private-build
repeatability policy inside its current local principal, source reservation,
logical-session binding and cancellation fence. Previously only the hosted
binding supplied that policy, so local recovery correctly refused the pending
original private call as an uncommitted dispatch even after compaction was fixed.
Only the exact retained app/spec/proposal/workspace/session scope and genuine
approved call can be returned; outward effects and unrelated missing results
remain under strict native reconciliation. This is not evidence that an arbitrary
call had no effects and never authorizes replay of the uncertain Preview batch.

A known rejected preparation has no accepted child receipt. A new public recovery
request may reconcile that same immutable local source reservation through the
supported protocol; it does not overwrite the reservation, repeat the original
public request ID or resend an approval response. Tests exercise the actual local
ports, real native collector/reconciler and SDK execution, including refusal for
foreign scopes, another principal, cancellation and outward calls. Actual saved
app recovery remains separately observed runtime evidence.
