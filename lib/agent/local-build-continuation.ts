/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop -- Private permissions protect owner isolation; each directory must be verified before creating its child. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HookContext } from "eve/hooks";
import { readLocalEveCycleBinding } from "../eve/local-cycle-binding";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import {
  approvedBuildDecisionSchema,
  internalBuildContinuationSchema,
  internalBuildMessage,
} from "./approved-build-continuation";
import type { ApprovedBuildDecision } from "./approved-build-continuation";
import { z } from "zod";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("The original local build continuation is unavailable.");
const ownedDirectory = async (directory: string) => {
  const info = await lstat(directory);
  const owner = info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  if (
    !owner ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  ) {
    throw unavailable();
  }
};
const root = async () => {
  const authority =
    process.env.APP_BUILDER_DEV_RUNS_ROOT === undefined
      ? undefined
      : await readLocalOperatorArtifactAuthority();
  if (authority !== undefined) {
    return authority.stateRoot;
  }
  const environment = process.env;
  const cycle = environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE;
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development" ||
    environment.APP_BUILDER_LOCAL_ADAPTER !== "1" ||
    environment.EVE_HOSTED_ADAPTER !== "0"
  ) {
    throw unavailable();
  }
  if (cycle === undefined) {
    throw unavailable();
  }
  readLocalEveCycleBinding(cycle);
  const directory = path.dirname(cycle);
  await ownedDirectory(directory);
  return directory;
};
const directory = async (sessionId: string) => {
  const stateRoot = await root();
  const base = path.join(stateRoot, "approved-build-continuations");
  for (const candidate of [base, path.join(base, hash(z.string().min(1).parse(sessionId)))]) {
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    await ownedDirectory(candidate);
  }
  return path.join(base, hash(sessionId));
};
const read = async (file: string): Promise<string | undefined> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
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
const write = async (file: string, content: string, once = false) => {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    if (once) {
      try {
        await link(temporary, file);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
      }
      return (await read(file)) === content;
    }
    await rename(temporary, file);
    return true;
  } finally {
    await remove(temporary);
  }
};
const localOperationSchema = z.strictObject({
  marker: internalBuildContinuationSchema,
  operationId: z.string(),
  version: z.literal(1),
});
export const recordLocalBuildDecision = async (
  ctx: Pick<HookContext, "session">,
  decision: ApprovedBuildDecision,
) => {
  const owned = await directory(ctx.session.id);
  const file = path.join(owned, "decision.json");
  const existing = await read(file);
  const current =
    existing === undefined ? undefined : approvedBuildDecisionSchema.parse(JSON.parse(existing));
  if ((current?.turnSequence ?? -1) > decision.turnSequence) {
    return;
  }
  await write(file, JSON.stringify(approvedBuildDecisionSchema.parse(decision)));
};
export const readLocalBuildDecision = async (
  sessionId: string,
): Promise<ApprovedBuildDecision | undefined> => {
  const content = await read(path.join(await directory(sessionId), "decision.json"));
  if (content === undefined) {
    return undefined;
  }
  const decision = approvedBuildDecisionSchema.parse(JSON.parse(content));
  if (decision.adapterSessionId !== sessionId) {
    throw unavailable();
  }
  return decision;
};
export const claimLocalBuildMessage = async (
  ctx: Pick<HookContext, "session">,
  input: { messageSequence: number; nonce: string; operationId: string; turnId: string },
) => {
  const owned = await directory(ctx.session.id);
  const op = hash(input.operationId);
  const content = await read(path.join(owned, `${op}.op.json`));
  if (content === undefined) {
    return false;
  }
  const operation = localOperationSchema.parse(JSON.parse(content));
  if (
    operation.marker.nonce !== input.nonce ||
    operation.marker.decision.turnSequence >= ctx.session.turn.sequence
  ) {
    return false;
  }
  return await write(
    path.join(owned, `${op}.delivered.json`),
    JSON.stringify({ messageSequence: input.messageSequence, turnId: input.turnId }),
    true,
  );
};
/** The existing local service owns the one active response; this function never replaces a session or retries an unknown dispatch. */
export const continueApprovedLocalBuild = async (input: {
  sessionId: string;
  pendingInput: boolean;
  active: boolean;
  dispatch: (message: string) => Promise<void>;
}): Promise<boolean> => {
  if (input.active || input.pendingInput) {
    return false;
  }
  const decision = await readLocalBuildDecision(input.sessionId);
  if (decision?.decision !== "runnable" || decision.scope === undefined) {
    return false;
  }
  const owned = await directory(input.sessionId);
  const identity = `${input.sessionId}:${decision.turnId}`;
  const operationId = `approved_build_${hash(identity)}`;
  const op = hash(operationId);
  const file = path.join(owned, `${op}.op.json`);
  if ((await read(file)) !== undefined) {
    return true;
  }
  const nonce = randomBytes(32).toString("hex");
  const operation = { marker: { decision, nonce }, operationId, version: 1 };
  if (!(await write(file, JSON.stringify(operation), true))) {
    return true;
  }
  const current = await readLocalBuildDecision(input.sessionId);
  if (
    current?.decision !== "runnable" ||
    current.turnId !== decision.turnId ||
    JSON.stringify(current.scope) !== JSON.stringify(decision.scope)
  ) {
    return false;
  }
  // Reservation is durable before SDK submission. Its existence prevents any replay after a lost acknowledgement.
  try {
    await input.dispatch(internalBuildMessage(operationId, nonce));
    await write(path.join(owned, `${op}.accepted.json`), JSON.stringify({ accepted: true }), true);
  } catch {
    await write(
      path.join(owned, `${op}.unknown.json`),
      JSON.stringify({ outcome: "unknown" }),
      true,
    );
  }
  return true;
};
