import type { DurableHostedSessionRecord } from "./hosted-store";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function recoveryPromptForSession(record: DurableHostedSessionRecord): string | undefined {
  const { checkpoint } = record;
  if (checkpoint === undefined) {
    return;
  }
  const messages = checkpoint.events
    .filter(
      (event): event is Extract<typeof event, { type: "assistant_message" }> =>
        event.type === "assistant_message",
    )
    .slice(-20)
    .map(({ text }) => text)
    .join("\n\n")
    .slice(-12_000);
  const historicalMessageCount = checkpoint.events.filter(
    (event) => event.type === "assistant_message",
  ).length;
  const excerpted = historicalMessageCount > 20 || messages.length >= 12_000;
  return [
    "Continue this interrupted Autograph App Builder session from its durable checkpoint.",
    `Product title: ${record.title}`,
    record.appId === undefined ? undefined : `App id: ${record.appId}`,
    checkpoint.prototype === undefined
      ? undefined
      : `Prototype: ${checkpoint.prototype.path} (${checkpoint.prototype.digest})`,
    checkpoint.inputRequests === undefined
      ? undefined
      : `Outstanding unresolved product requests from the prior runtime (the exact prior request IDs are retained for reconciliation): ${JSON.stringify(checkpoint.inputRequests)}`,
    checkpoint.truncatedBeforeIndex === undefined
      ? undefined
      : `This legacy checkpoint discarded its first ${checkpoint.truncatedBeforeIndex} public events. Those events are not recoverable from this checkpoint; ask the user for missing context instead of inventing it.`,
    excerpted
      ? `The conversation below is an excerpt. Read complete retained history through authenticated autograph_get for session ${record.sessionId}, starting at cursor ${checkpoint.truncatedBeforeIndex ?? 0}, before relying on earlier decisions.`
      : undefined,
    messages.length === 0 ? undefined : `Prior product conversation:\n${messages}`,
    checkpoint.inputRequests === undefined
      ? undefined
      : "Reissue every unresolved product request before later work. Do not infer that any of them was answered or approved.",
    "Preserve the prior product decisions, revalidate current source access before any repository work, and continue from the next unfinished product step.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}
