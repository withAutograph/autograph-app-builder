/** Eve's streamed event writer rejects serialized chunks above this provider ceiling. */
export const EVE_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

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
export const largestUtf8PayloadChunk = <T>(input: {
  content: string;
  offsetBytes: number;
  makePayload: (content: string, nextOffsetBytes: number) => T;
  maxBytes?: number;
}): { content: string; nextOffsetBytes: number; payload: T } => {
  const bytes = Buffer.from(input.content, "utf-8");
  const { offsetBytes } = input;
  const maxBytes = input.maxBytes ?? EVE_MAX_PAYLOAD_BYTES;
  if (!isValidUtf8Offset(offsetBytes, bytes)) {
    throw new Error("The payload chunk offset must identify a UTF-8 character boundary.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("The payload envelope must be a positive safe byte count.");
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
  let best: { content: string; nextOffsetBytes: number; payload: T } | undefined;
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
    if (Buffer.byteLength(serialized, "utf-8") <= maxBytes) {
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
