/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Permission masks isolate the OS owner; manifests verify ordered acknowledged chunks with bounded memory. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LocalOperatorArtifactAuthority } from "../provisioning/hosted-operator-artifact-store";
import type {
  ValidationLogKey,
  ValidationLogReference,
  ValidationLogStore,
} from "./validation-log";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const keySchema = z.strictObject({
  attemptDigest: digest,
  channel: z.enum(["stdout", "stderr"]),
  command: z.string().min(1),
  logId: z.uuid(),
  sessionId: z.string().min(1),
});
const chunkSchema = z.strictObject({ content: z.string(), digest });
const referenceSchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  channel: z.enum(["stdout", "stderr"]),
  chunkCount: z.number().int().nonnegative(),
  completion: z.enum(["complete", "interrupted", "unavailable"]).optional(),
  digest,
  logId: z.uuid(),
});
const hash = (content: string) => createHash("sha256").update(content, "utf-8").digest("hex");
const unavailable = () =>
  new Error("Private validation log is unavailable for this owner and session.");
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
    if ((await read(file)) !== content) {
      throw unavailable();
    }
  } finally {
    await remove(temporary);
  }
};

/** Native private files implement the same immutable log contract as hosted storage; sanitization remains in ValidationLogWriter. */
export const createLocalValidationLogStore = async (input: {
  authority: LocalOperatorArtifactAuthority;
  sessionId: string;
  assertCurrentOwner: () => Promise<void>;
}): Promise<ValidationLogStore> => {
  await input.assertCurrentOwner();
  await directory(input.authority.stateRoot);
  const root = path.join(input.authority.stateRoot, "validation-logs");
  await directory(root, true);
  const owned = path.join(
    root,
    hash(JSON.stringify({ authority: input.authority, sessionId: input.sessionId })),
  );
  await directory(owned, true);
  const assertKey = async (key: ValidationLogKey) => {
    const parsed = keySchema.parse(key);
    if (parsed.sessionId !== input.sessionId) {
      throw unavailable();
    }
    await input.assertCurrentOwner();
    await directory(input.authority.stateRoot);
    await directory(root);
    await directory(owned);
    return hash(JSON.stringify(parsed));
  };
  const readChunk = async (
    key: ValidationLogKey,
    index: number,
  ): Promise<{ content: string; digest: string } | undefined> => {
    const scope = await assertKey(key);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw unavailable();
    }
    const bytes = await read(path.join(owned, `${scope}.chunk-${index}.json`));
    await input.assertCurrentOwner();
    if (bytes === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional chunk reads return an explicit value on both paths.
      return undefined;
    }
    const chunk = chunkSchema.parse(JSON.parse(bytes));
    if (hash(chunk.content) !== chunk.digest) {
      throw unavailable();
    }
    return chunk;
  };
  const readReference = async (
    key: ValidationLogKey,
  ): Promise<ValidationLogReference | undefined> => {
    const scope = await assertKey(key);
    const content = await read(path.join(owned, `${scope}.manifest.json`));
    await input.assertCurrentOwner();
    if (content === undefined) {
      return undefined;
    }
    const reference = referenceSchema.parse(JSON.parse(content));
    if (reference.channel !== key.channel || reference.logId !== key.logId) {
      throw unavailable();
    }
    return reference;
  };
  return {
    getChunk: readChunk,
    getReference: readReference,
    async publish(key, referenceInput) {
      const scope = await assertKey(key);
      const reference = referenceSchema.parse(referenceInput);
      if (reference.channel !== key.channel || reference.logId !== key.logId) {
        throw unavailable();
      }
      const combined = createHash("sha256");
      let bytes = 0;
      for (let index = 0; index < reference.chunkCount; index += 1) {
        const chunk = await readChunk(key, index);
        if (chunk === undefined) {
          throw unavailable();
        }
        combined.update(chunk.content, "utf-8");
        bytes += Buffer.byteLength(chunk.content, "utf-8");
      }
      if (bytes !== reference.bytes || combined.digest("hex") !== reference.digest) {
        throw unavailable();
      }
      await writeOnce(path.join(owned, `${scope}.manifest.json`), JSON.stringify(reference));
      await input.assertCurrentOwner();
    },
    async putChunk(key, index, content, chunkDigest) {
      const scope = await assertKey(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        digest.parse(chunkDigest) !== hash(content)
      ) {
        throw unavailable();
      }
      await writeOnce(
        path.join(owned, `${scope}.chunk-${index}.json`),
        JSON.stringify({ content, digest: chunkDigest }),
      );
      await input.assertCurrentOwner();
    },
    async removeStaged(key) {
      const scope = await assertKey(key);
      if ((await readReference(key)) !== undefined) {
        return;
      }
      const entries = await opendir(owned);
      for await (const entry of entries) {
        if (entry.name.startsWith(`${scope}.chunk-`) && entry.name.endsWith(".json")) {
          await input.assertCurrentOwner();
          await remove(path.join(owned, entry.name));
        }
      }
      await input.assertCurrentOwner();
    },
  };
};
