/** Eve's streamed event writer rejects serialized chunks above this provider ceiling. */
export const EVE_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const nativeActionResultEventType = "action.result" as const;

/** Match prototype-v2's physical chunk granularity, leaving runtime stamp headroom. */
export const EVE_NATIVE_RESULT_PAGE_BYTES = Math.floor(EVE_MAX_PAYLOAD_BYTES / 8);

export interface EvePayload {
  data: object;
  type: string;
}

export const serializedPayloadBytes = (payload: EvePayload): number => {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new TypeError("The Eve payload must serialize to JSON text.");
  }
  return Buffer.byteLength(serialized, "utf-8");
};

export interface NativeActionResultMetadata {
  at?: string;
  callId: string;
  deliveryIds?: readonly string[];
  id?: string;
  toolName: string;
  turnId: string;
  sequence?: number;
  stepIndex?: number;
}

interface NativeEventStamp {
  at: string;
  deliveryIds?: readonly string[];
  id: string;
}

const nativeEventStamp = (metadata: NativeActionResultMetadata): NativeEventStamp => {
  const stamp: NativeEventStamp = {
    at: metadata.at ?? "+999999-12-31T23:59:59.999Z",
    id: metadata.id ?? "evt_00000000000000000000000000",
  };
  if (metadata.deliveryIds !== undefined && metadata.deliveryIds.length > 0) {
    stamp.deliveryIds = metadata.deliveryIds;
  }
  return stamp;
};

/** Unknown runtime counters reserve the longest safe integer representation. */
export const nativeActionResultFrame = <T>(output: T, metadata: NativeActionResultMetadata) => ({
  data: {
    result: {
      callId: metadata.callId,
      kind: "tool-result" as const,
      output,
      toolName: metadata.toolName,
    },
    sequence: metadata.sequence ?? Number.MAX_SAFE_INTEGER,
    status: "completed" as const,
    stepIndex: metadata.stepIndex ?? Number.MAX_SAFE_INTEGER,
    turnId: metadata.turnId,
  },
  meta: nativeEventStamp(metadata),
  type: nativeActionResultEventType,
});

/** The native stream writer emits JSON followed by one newline. */
// Generic output preserves each tool's validated domain shape at this shared serializer boundary.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const serializedNativeActionResultBytes = <T>(
  output: T,
  metadata: NativeActionResultMetadata,
): number => serializedPayloadBytes(nativeActionResultFrame(output, metadata)) + 1;

export interface NativeFrameDiagnostic {
  eventType: "action.result";
  toolName: string;
  serializedBytes: number;
  maximumBytes: number;
}

/** Diagnostics contain frame names and counts only, never tool output or IDs. */
export const logNativeFrameDiagnostic = (diagnostic: NativeFrameDiagnostic): void => {
  console.info("builder.native_action_result_frame", diagnostic);
};

export class NativeFrameOverflowError extends Error {
  readonly diagnostic: NativeFrameDiagnostic;

  constructor(diagnostic: NativeFrameDiagnostic) {
    super(`The Eve native frame exceeds its payload envelope: ${JSON.stringify(diagnostic)}`);
    this.name = "NativeFrameOverflowError";
    this.diagnostic = diagnostic;
  }
}

/** Assert the complete output fits; callers must page authoritative content. */
export const fitOutputNativeFrame = <T>(
  output: T,
  metadata: NativeActionResultMetadata,
  maximumBytes = EVE_MAX_PAYLOAD_BYTES,
): T => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("The payload envelope must be a positive safe byte count.");
  }
  const serializedBytes = serializedNativeActionResultBytes(output, metadata);
  if (serializedBytes > maximumBytes) {
    throw new NativeFrameOverflowError({
      eventType: nativeActionResultEventType,
      maximumBytes,
      serializedBytes,
      toolName: metadata.toolName,
    });
  }
  return output;
};

/** Check and report only the final outgoing result, not intermediate page trials. */
export const checkedNativeToolResult = <T>(
  output: T,
  metadata: NativeActionResultMetadata,
  maximumBytes = EVE_MAX_PAYLOAD_BYTES,
): T => {
  logNativeFrameDiagnostic({
    eventType: nativeActionResultEventType,
    maximumBytes,
    serializedBytes: serializedNativeActionResultBytes(output, metadata),
    toolName: metadata.toolName,
  });
  return fitOutputNativeFrame(output, metadata, maximumBytes);
};

const isContinuationByte = (byte: number): boolean => byte >= 0x80 && byte <= 0xbf;

const isValidUtf8Offset = (offsetBytes: number, bytes: Buffer): boolean => {
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > bytes.byteLength) {
    return false;
  }
  return offsetBytes === 0 || !isContinuationByte(bytes[offsetBytes] ?? 0);
};

/**
 * Find the largest UTF-8-safe prefix that keeps the complete serialized payload
 * within Eve's event envelope. The caller supplies the whole output shape so
 * metadata and JSON escaping are included in the measurement.
 */
export interface Utf8PayloadChunk<T> {
  content: string;
  nextOffsetBytes: number;
  payload: T;
}

export const largestUtf8PayloadChunk = <T>(input: {
  content: string;
  offsetBytes: number;
  makePayload: (content: string, nextOffsetBytes: number) => T;
  measurePayloadBytes?: (payload: T) => number;
  maxBytes?: number;
}): Utf8PayloadChunk<T> => {
  const bytes = Buffer.from(input.content, "utf-8");
  const { offsetBytes } = input;
  const maxBytes = input.maxBytes ?? EVE_MAX_PAYLOAD_BYTES;
  if (!isValidUtf8Offset(offsetBytes, bytes)) {
    throw new Error("The payload chunk offset must identify a UTF-8 character boundary.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("The payload envelope must be a positive safe byte count.");
  }
  // The final frame can be smaller because its continuation cursor disappears.
  // Check it before relying on prefix-size monotonicity during binary search.
  const completeContent = bytes.subarray(offsetBytes).toString("utf-8");
  const completePayload = input.makePayload(completeContent, bytes.byteLength);
  const completeSerialized = JSON.stringify(completePayload);
  if (completeSerialized === undefined) {
    throw new TypeError("The Eve payload chunk must serialize to JSON text.");
  }
  const completeBytes =
    input.measurePayloadBytes?.(completePayload) ?? Buffer.byteLength(completeSerialized, "utf-8");
  if (completeBytes <= maxBytes && bytes.byteLength > offsetBytes) {
    return {
      content: completeContent,
      nextOffsetBytes: bytes.byteLength,
      payload: completePayload,
    };
  }

  const boundaryAtOrBefore = (requestedEnd: number) => {
    let boundary = requestedEnd;
    while (boundary > offsetBytes && boundary < bytes.byteLength) {
      const byte = bytes[boundary] ?? 0;
      if (!isContinuationByte(byte)) {
        break;
      }
      boundary -= 1;
    }
    return boundary;
  };

  let low = offsetBytes;
  let high = bytes.byteLength;
  let best: Utf8PayloadChunk<T> | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const end = boundaryAtOrBefore(middle);
    if (end === offsetBytes && bytes.byteLength > offsetBytes) {
      low = Math.max(low + 1, middle + 1);
      continue;
    }
    const chunk = bytes.subarray(offsetBytes, end).toString("utf-8");
    const payload = input.makePayload(chunk, end);
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      throw new TypeError("The Eve payload chunk must serialize to JSON text.");
    }
    const payloadBytes =
      input.measurePayloadBytes?.(payload) ?? Buffer.byteLength(serialized, "utf-8");
    if (payloadBytes <= maxBytes) {
      best = { content: chunk, nextOffsetBytes: end, payload };
      low = middle + 1;
    } else {
      high = end - 1;
    }
  }

  if (best === undefined || best.nextOffsetBytes === offsetBytes) {
    throw new Error(
      `The Eve payload envelope cannot fit another UTF-8 character within ${maxBytes} serialized bytes. Reduce fixed metadata or use the provider-supported envelope size.`,
    );
  }
  return best;
};
