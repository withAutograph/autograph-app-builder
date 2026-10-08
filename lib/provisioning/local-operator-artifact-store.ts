/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Permission masks enforce owner isolation; immutable selection ordinals retry sequentially after atomic concurrent publication. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, opendir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  operatorArtifactReferenceSchema,
  operatorArtifactUnavailable,
} from "./hosted-operator-artifact-store";
import type {
  LocalOperatorArtifactAuthority,
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";
import { compiledOperatorReleaseSelectionSchema } from "./hosted-operator-artifact-selection";
import type {
  CompiledOperatorReleaseSelection,
  OperatorArtifactSelections,
} from "./hosted-operator-artifact-selection";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const assertDirectory = async (directory: string) => {
  const info = await lstat(directory);
  const wrongOwnership = info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0;
  const wrongType = !info.isDirectory() || info.isSymbolicLink();
  if ((await realpath(directory)) !== directory || wrongOwnership || wrongType) {
    throw operatorArtifactUnavailable();
  }
};
const privateDirectory = async (directory: string) => {
  await mkdir(directory, { mode: 0o700 });
  await assertDirectory(directory);
};
const ensureDirectory = async (directory: string) => {
  try {
    await privateDirectory(directory);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
    await assertDirectory(directory);
  }
};
/** The normal dev launcher supplies these closed values. No tool input selects this profile. */
export const readLocalOperatorArtifactAuthority = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LocalOperatorArtifactAuthority | undefined> => {
  if (environment.APP_BUILDER_EXECUTION_MODE !== "development") {
    return undefined;
  }
  const closed = [
    environment.APP_BUILDER_EXECUTION_BUNDLE === "local-development",
    environment.APP_BUILDER_LOCAL_ADAPTER === "1",
    environment.EVE_HOSTED_ADAPTER === "0",
    environment.APP_BUILDER_SANDBOX_PROVIDER === "vercel",
  ];
  const runsRoot = environment.APP_BUILDER_DEV_RUNS_ROOT;
  const ownerUid = process.getuid?.();
  if (!closed.every(Boolean) || runsRoot === undefined || ownerUid === undefined) {
    throw operatorArtifactUnavailable();
  }
  if (!path.isAbsolute(runsRoot) || path.resolve(runsRoot) !== runsRoot) {
    throw operatorArtifactUnavailable();
  }
  await assertDirectory(runsRoot);
  const stateRoot = path.dirname(runsRoot);
  await assertDirectory(stateRoot);
  return { kind: "local", ownerUid, stateRoot };
};
const readPrivate = async (file: string): Promise<string | undefined> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw operatorArtifactUnavailable();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw operatorArtifactUnavailable();
    }
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
};
const removeTemporary = async (temporary: string) => {
  try {
    await unlink(temporary);
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
    return (await readPrivate(file)) === content;
  } finally {
    await removeTemporary(temporary);
  }
};
const chunkSchema = z.strictObject({
  chunkDigest: z.string(),
  content: z.string(),
  version: z.literal(1),
});

const selectionFrameSchema = z.strictObject({
  callDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  selection: compiledOperatorReleaseSelectionSchema,
  sequence: z.string().regex(/^[1-9][0-9]*$/u),
  version: z.literal(1),
});
const scanSelections = async (directory: string, callDigest?: string) => {
  let latest: z.infer<typeof selectionFrameSchema> | undefined;
  let matched: z.infer<typeof selectionFrameSchema> | undefined;
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      continue;
    }
    const ordinal = /^sequence-(?<ordinal>[1-9][0-9]*)\.json$/u.exec(entry.name)?.groups?.ordinal;
    if (ordinal === undefined) {
      throw operatorArtifactUnavailable();
    }
    const content = await readPrivate(path.join(directory, entry.name));
    if (content === undefined) {
      throw operatorArtifactUnavailable();
    }
    const frame = selectionFrameSchema.parse(JSON.parse(content));
    if (frame.sequence !== ordinal) {
      throw operatorArtifactUnavailable();
    }
    if (latest === undefined || BigInt(frame.sequence) > BigInt(latest.sequence)) {
      latest = frame;
    }
    if (frame.callDigest === callDigest) {
      if (matched !== undefined) {
        throw operatorArtifactUnavailable();
      }
      matched = frame;
    }
  }
  return { latest, matched };
};

/** Private owner/session/app filesystem state; the app Sandbox never receives this root. */
export const createLocalOperatorArtifactStorage = async (input: {
  authority: LocalOperatorArtifactAuthority;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}): Promise<{ selections: OperatorArtifactSelections; store: OperatorArtifactStore }> => {
  const storageRoot = path.join(input.authority.stateRoot, "operator-artifacts");
  await assertDirectory(input.authority.stateRoot);
  await ensureDirectory(storageRoot);
  const directory = async (context: OperatorArtifactContext) => {
    await input.assertCurrentOwner(context);
    if (JSON.stringify(context.authority) !== JSON.stringify(input.authority)) {
      throw operatorArtifactUnavailable();
    }
    await assertDirectory(input.authority.stateRoot);
    await assertDirectory(storageRoot);
    const owned = path.join(storageRoot, hash(JSON.stringify(context)));
    await ensureDirectory(owned);
    return owned;
  };
  const store: OperatorArtifactStore = {
    async put(context, chunk) {
      const ref = operatorArtifactReferenceSchema.parse(chunk.artifactRef);
      if (
        ref.split("/")[3] !== context.target.appId ||
        !Number.isSafeInteger(chunk.chunkIndex) ||
        chunk.chunkIndex < 0 ||
        !chunk.content
      ) {
        throw operatorArtifactUnavailable();
      }
      const owned = await directory(context);
      const content = JSON.stringify({
        chunkDigest: hash(chunk.content),
        content: chunk.content,
        version: 1,
      });
      if (!(await writeOnce(path.join(owned, `${hash(ref)}-${chunk.chunkIndex}.json`), content))) {
        throw operatorArtifactUnavailable();
      }
      await input.assertCurrentOwner(context);
    },
    async read(context, artifactRef, chunkIndex): Promise<string | undefined> {
      const ref = operatorArtifactReferenceSchema.parse(artifactRef);
      if (
        ref.split("/")[3] !== context.target.appId ||
        !Number.isSafeInteger(chunkIndex) ||
        chunkIndex < 0
      ) {
        throw operatorArtifactUnavailable();
      }
      const owned = await directory(context);
      const content = await readPrivate(path.join(owned, `${hash(ref)}-${chunkIndex}.json`));
      await input.assertCurrentOwner(context);
      if (content === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The optional store read contract requires an explicit value on each return path.
        return undefined;
      }
      const chunk = chunkSchema.parse(JSON.parse(content));
      if (hash(chunk.content) !== chunk.chunkDigest) {
        throw operatorArtifactUnavailable();
      }
      return chunk.content;
    },
  };
  const selectionDirectory = async (context: OperatorArtifactContext, appSpecDigest: string) => {
    const owned = await directory(context);
    const selectionRoot = path.join(
      owned,
      `selection-${z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(appSpecDigest)}`,
    );
    await ensureDirectory(selectionRoot);
    return selectionRoot;
  };
  const selections: OperatorArtifactSelections = {
    async read(context, appSpecDigest): Promise<CompiledOperatorReleaseSelection | undefined> {
      const owned = await selectionDirectory(context, appSpecDigest);
      const { latest } = await scanSelections(owned);
      await input.assertCurrentOwner(context);
      if (latest === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The optional store read contract requires an explicit value on each return path.
        return undefined;
      }
      if (
        latest.selection.appId !== context.target.appId ||
        latest.selection.appSpecDigest !== appSpecDigest
      ) {
        throw operatorArtifactUnavailable();
      }
      return latest.selection;
    },
    async record(context, callId, selectionInput) {
      const selection = compiledOperatorReleaseSelectionSchema.parse(selectionInput);
      if (
        selection.appId !== context.target.appId ||
        selection.artifactRef.split("/")[2] !== "generated-release" ||
        selection.artifactRef.split("/")[3] !== selection.appId
      ) {
        throw operatorArtifactUnavailable();
      }
      const owned = await selectionDirectory(context, selection.appSpecDigest);
      const callDigest = hash(z.string().min(1).parse(callId));
      for (;;) {
        await input.assertCurrentOwner(context);
        const { latest, matched } = await scanSelections(owned, callDigest);
        if (matched !== undefined) {
          if (JSON.stringify(matched.selection) !== JSON.stringify(selection)) {
            throw operatorArtifactUnavailable();
          }
          await input.assertCurrentOwner(context);
          return selection;
        }
        // oxlint-disable-next-line unicorn/prefer-bigint-literals -- The repository TypeScript target cannot emit bigint literal syntax; supported Node uses the native constructor.
        const sequence = (BigInt(latest?.sequence ?? "0") + BigInt(1)).toString();
        const content = JSON.stringify({ callDigest, selection, sequence, version: 1 });
        if (await writeOnce(path.join(owned, `sequence-${sequence}.json`), content)) {
          await input.assertCurrentOwner(context);
          return selection;
        }
        // A concurrent owned publisher completed this ordinal first. Re-read the immutable index.
      }
    },
  };
  return { selections, store };
};
