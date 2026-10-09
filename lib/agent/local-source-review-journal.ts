/* oxlint-disable eslint/no-bitwise -- Owner permission masks enforce private local storage. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  serializeSourceReviewRecord,
  sourceReviewJournalRecordSchema,
  sourceReviewPairKeySchema,
} from "./product-source-review-journal";
import type { SourceReviewJournal } from "./product-source-review-journal";

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const unavailable = () =>
  new Error("Private source review journal is unavailable for this owner and session.");
const directory = async (root: string, create = false) => {
  if (create) {
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  const info = await lstat(root);
  const wrongOwner = info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0;
  const wrongType = !info.isDirectory() || info.isSymbolicLink();
  if ((await realpath(root)) !== root || wrongOwner || wrongType) {
    throw unavailable();
  }
};
const read = async (file: string): Promise<string | undefined> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw unavailable();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw unavailable();
    }
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
};
const remove = async (file: string) => {
  try {
    await unlink(file);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
};
const writeOnce = async (file: string, content: string) => {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, file);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    const stored = await read(file);
    if (stored === undefined) {
      throw unavailable();
    }
    return sourceReviewJournalRecordSchema.parse(JSON.parse(stored));
  } finally {
    await remove(temporary);
  }
};

export const createLocalSourceReviewJournal = async (input: {
  stateRoot: string;
  ownerScope: string;
  sessionId: string;
  assertCurrentOwner: () => Promise<void>;
}): Promise<SourceReviewJournal> => {
  if (!input.sessionId || !input.ownerScope) {
    throw unavailable();
  }
  await input.assertCurrentOwner();
  await directory(input.stateRoot);
  const root = path.join(input.stateRoot, "source-review-journal");
  await directory(root, true);
  const owned = path.join(root, hash(JSON.stringify([input.ownerScope, input.sessionId])));
  await directory(owned, true);
  const file = async (key: string) => {
    sourceReviewPairKeySchema.parse(key);
    await input.assertCurrentOwner();
    await directory(input.stateRoot);
    await directory(root);
    await directory(owned);
    return path.join(owned, `${key}.json`);
  };
  return {
    async put(key, record) {
      const stored = await writeOnce(await file(key), serializeSourceReviewRecord(record));
      await input.assertCurrentOwner();
      return stored;
    },
    async read(key) {
      const bytes = await read(await file(key));
      await input.assertCurrentOwner();
      return bytes === undefined
        ? undefined
        : sourceReviewJournalRecordSchema.parse(JSON.parse(bytes));
    },
  };
};
