import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";

import { publicEveEventSchema } from "../mcp/contracts";

/** The caller supplies identities read from authenticated state, never a browser payload. */
export interface HistoricalApprovalReplayBinding {
  issuer: string;
  audience: string;
  workspaceId: string;
  ownerUserId: string;
  sessionId: string;
  adapterSessionId: string;
  adapterGeneration: number;
}

type PublicEvent = z.infer<typeof publicEveEventSchema>;

/**
 * Validate a complete private-history replay against the published public checkpoint.
 * This is read-only: callers must reauthorize and compare-and-set the checkpoint after
 * verification, so a concurrent owner, adapter, or checkpoint change cannot be applied.
 */
export const verifyHistoricalApprovalReplay = async (input: {
  trustedBinding: HistoricalApprovalReplayBinding;
  replayBinding: HistoricalApprovalReplayBinding;
  trustedEventCount: number;
  trustedEvents: AsyncIterable<PublicEvent>;
  replayEvents: AsyncIterable<PublicEvent>;
  nativeTail: { complete: boolean; nextNativeIndex: number; nativeTailIndex: number };
}): Promise<{ replayEventCount: number }> => {
  const bindingFields = [
    "issuer",
    "audience",
    "workspaceId",
    "ownerUserId",
    "sessionId",
    "adapterSessionId",
  ] as const;
  if (
    bindingFields.some(
      (field) =>
        input.trustedBinding[field].length === 0 ||
        input.trustedBinding[field] !== input.replayBinding[field],
    ) ||
    !Number.isSafeInteger(input.trustedBinding.adapterGeneration) ||
    input.trustedBinding.adapterGeneration < 1 ||
    input.trustedBinding.adapterGeneration !== input.replayBinding.adapterGeneration
  ) {
    throw new Error("Historical approval replay binding mismatch.");
  }
  const { nativeTail } = input;
  const validTail = [
    nativeTail.complete,
    Number.isSafeInteger(nativeTail.nextNativeIndex),
    Number.isSafeInteger(nativeTail.nativeTailIndex),
    nativeTail.nextNativeIndex >= 0,
    nativeTail.nativeTailIndex >= -1,
    nativeTail.nextNativeIndex === nativeTail.nativeTailIndex + 1,
    Number.isSafeInteger(input.trustedEventCount),
    input.trustedEventCount >= 0,
  ].every(Boolean);
  if (!validTail) {
    throw new Error("Historical approval replay is incomplete.");
  }

  const prefix = input.trustedEvents[Symbol.asyncIterator]();
  let count = 0;
  for await (const raw of input.replayEvents) {
    const replay = publicEveEventSchema.parse(raw);
    if (replay.index !== count) {
      throw new Error("Historical approval replay index mismatch.");
    }
    if (count < input.trustedEventCount) {
      const next = await prefix.next();
      if (next.done === true) {
        throw new Error("Trusted approval checkpoint prefix is truncated.");
      }
      const expected = publicEveEventSchema.parse(next.value);
      if (expected.index !== count || !isDeepStrictEqual(expected, replay)) {
        throw new Error("Historical approval replay prefix mismatch.");
      }
    }
    count += 1;
  }
  const remainder = await prefix.next();
  if (count < input.trustedEventCount || remainder.done !== true) {
    throw new Error("Historical approval replay prefix is truncated or inconsistent.");
  }
  return { replayEventCount: count };
};
