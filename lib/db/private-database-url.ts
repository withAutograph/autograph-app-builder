import { closeSync, readSync } from "node:fs";

import { parseHostedDatabaseUrl } from "./postgres-connection-policy";

const MAX_SECRET_BYTES = 8_192;

export function readPrivateDatabaseUrl(fd: number): string {
  if (!Number.isInteger(fd) || fd < 0) {
    throw new Error("The database URL fd was invalid.");
  }
  const frame = Buffer.alloc(MAX_SECRET_BYTES + 1);
  let length = 0;
  try {
    while (length < frame.length) {
      const count = readSync(fd, frame, length, frame.length - length, null);
      if (count === 0) break;
      length += count;
    }
  } finally {
    closeSync(fd);
  }
  if (length === 0 || length > MAX_SECRET_BYTES) {
    frame.fill(0);
    throw new Error("The database URL secret frame was empty or oversized.");
  }
  const databaseUrl = frame.subarray(0, length).toString("utf8");
  frame.fill(0);
  if (/[\0\r\n]/u.test(databaseUrl)) {
    throw new Error("The database URL secret frame was malformed.");
  }
  return parseHostedDatabaseUrl(databaseUrl);
}
