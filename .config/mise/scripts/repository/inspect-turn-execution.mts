import { readLocalTurnExecutionEvidence } from "../../../../lib/eve/read-local-turn-evidence";
import type { NativeTurnSelector } from "../../../../lib/eve/turn-execution-evidence";

const values = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const value = process.argv[i + 1];
  if (!flag?.startsWith("--") || value === undefined || values.has(flag)) {
    throw new Error("Use unique --name value arguments.");
  }
  values.set(flag, value);
}
const cycleRoot = values.get("--cycle-root");
const sessionId = values.get("--session-id");
if (cycleRoot === undefined || sessionId === undefined) {
  throw new Error("--cycle-root and --session-id are required.");
}
const selectors: NativeTurnSelector[] = [];
const turnId = values.get("--turn-id");
const messageIndex = values.get("--message-index");
const deliveryId = values.get("--delivery-id");
if (turnId !== undefined) {
  selectors.push({ turnId });
}
if (messageIndex !== undefined) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(messageIndex) || !Number.isSafeInteger(Number(messageIndex))) {
    throw new Error("--message-index must be a native event index.");
  }
  selectors.push({ messageIndex: Number(messageIndex) });
}
if (deliveryId !== undefined) {
  selectors.push({ deliveryId });
}
if (selectors.length > 1) {
  throw new Error("Choose one native turn, message index or delivery ID.");
}
for (const flag of [
  "--cycle-root",
  "--session-id",
  "--turn-id",
  "--message-index",
  "--delivery-id",
]) {
  values.delete(flag);
}
if (values.size !== 0) {
  throw new Error("Unknown execution-evidence argument.");
}
try {
  const result = await readLocalTurnExecutionEvidence({
    cycleRoot,
    selector: selectors[0],
    sessionId,
  });
  console.log(JSON.stringify(result, null, 2));
} catch {
  // Never print private Native responses, messages, credentials, paths or provider diagnostics.
  console.error(
    "Local execution evidence is unavailable; no continuation or action was submitted.",
  );
  process.exitCode = 1;
}
