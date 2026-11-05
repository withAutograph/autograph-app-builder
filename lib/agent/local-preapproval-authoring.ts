/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop -- Private permissions protect owner isolation; each directory must be verified before creating its child. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { HookContext } from "eve/hooks";
import { readLocalEveCycleBinding } from "../eve/local-cycle-binding";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import {
  preapprovalAuthoringDecisionSchema,
  internalAuthoringContinuationSchema,
  internalAuthoringMessage,
} from "./preapproval-authoring";
import type { PreapprovalAuthoringDecision } from "./preapproval-authoring";
import { z } from "zod";

/** Optional local feature; explicit configured custody errors still fail closed. */
export const localAuthoringConfigured = (): boolean =>
  process.env.APP_BUILDER_EXECUTION_MODE === "development" &&
  process.env.APP_BUILDER_EXECUTION_BUNDLE === "local-development" &&
  (process.env.APP_BUILDER_DEV_RUNS_ROOT !== undefined ||
    process.env.APP_BUILDER_LOCAL_EVE_CYCLE_FILE !== undefined);

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new Error("The original local authoring continuation is unavailable.");
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
  const base = path.join(stateRoot, "preapproval-authoring-continuations");
  for (const candidate of [base, path.join(base, hash(z.string().min(1).parse(sessionId)))]) {
    try {
      await mkdir(candidate, { mode: 0o700 });
      const parent = await open(path.dirname(candidate), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
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
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    ) {
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
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (once) {
      try {
        await link(temporary, file);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
      }
      await remove(temporary);
      const directoryHandle = await open(path.dirname(file), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return (await read(file)) === content;
    }
    await rename(temporary, file);
    const directoryHandle = await open(path.dirname(file), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return true;
  } finally {
    await remove(temporary);
  }
};
const localOperationSchema = z.strictObject({
  marker: internalAuthoringContinuationSchema,
  operationId: z.string(),
  version: z.literal(1),
});
const writeLocalAuthoringDecision = async (
  ctx: Pick<HookContext, "session">,
  decision: PreapprovalAuthoringDecision,
) => {
  const owned = await directory(ctx.session.id);
  const file = path.join(owned, "decision.json");
  const existing = await read(file);
  const current =
    existing === undefined
      ? undefined
      : preapprovalAuthoringDecisionSchema.parse(JSON.parse(existing));
  if ((current?.turnSequence ?? -1) > decision.turnSequence) {
    return;
  }
  await write(file, JSON.stringify(preapprovalAuthoringDecisionSchema.parse(decision)));
};
const decisionWrites = new Map<string, Promise<void>>();
/** Serialize same-owner hook observations so an older turn cannot replace a newer decision. */
export const recordLocalAuthoringDecision = async (
  ctx: Pick<HookContext, "session">,
  decision: PreapprovalAuthoringDecision,
): Promise<void> => {
  const prior = decisionWrites.get(ctx.session.id) ?? Promise.resolve();
  const work = (async () => {
    try {
      await prior;
    } catch {
      /* The failed prior observation remains visible to its caller. */
    }
    await writeLocalAuthoringDecision(ctx, decision);
  })();
  decisionWrites.set(ctx.session.id, work);
  try {
    await work;
  } finally {
    if (decisionWrites.get(ctx.session.id) === work) {
      decisionWrites.delete(ctx.session.id);
    }
  }
};
export const readLocalAuthoringDecision = async (
  sessionId: string,
): Promise<PreapprovalAuthoringDecision | undefined> => {
  const content = await read(path.join(await directory(sessionId), "decision.json"));
  if (content === undefined) {
    return undefined;
  }
  const decision = preapprovalAuthoringDecisionSchema.parse(JSON.parse(content));
  if (decision.adapterSessionId !== sessionId) {
    throw unavailable();
  }
  return decision;
};
/** Persist explicit Stop before any later internal delivery can claim an earlier turn. */
export const blockLocalAuthoringContinuation = async (
  sessionId: string,
  turnId?: string,
): Promise<void> => {
  const decision = await readLocalAuthoringDecision(sessionId);
  if (decision === undefined || (turnId !== undefined && decision.turnId !== turnId)) {
    return;
  }
  await write(
    path.join(await directory(sessionId), "cancelled.json"),
    JSON.stringify({ turnSequence: decision.turnSequence }),
  );
};
const cancelledAuthoringSequence = async (owned: string): Promise<number> => {
  const value = await read(path.join(owned, "cancelled.json"));
  return value === undefined
    ? -1
    : z.strictObject({ turnSequence: z.number().int().nonnegative() }).parse(JSON.parse(value))
        .turnSequence;
};
/** Read the reserved intent only after authenticating its private owner and nonce. Never an execution grant. */
export const readLocalAuthoringMarkerScope = async (
  ctx: Pick<HookContext, "session">,
  input: { operationId: string; nonce: string },
): Promise<string | undefined> => {
  const content = await read(
    path.join(await directory(ctx.session.id), `${hash(input.operationId)}.op.json`),
  );
  if (content === undefined) {
    return undefined;
  }
  const operation = localOperationSchema.parse(JSON.parse(content));
  if (
    operation.operationId !== input.operationId ||
    operation.marker.nonce !== input.nonce ||
    operation.marker.decision.adapterSessionId !== ctx.session.id
  ) {
    return undefined;
  }
  return operation.marker.decision.scopeDigest;
};
export const claimLocalAuthoringMessage = async (
  ctx: Pick<HookContext, "session">,
  input: {
    messageSequence: number;
    nonce: string;
    operationId: string;
    turnId: string;
    scopeDigest: string;
  },
) => {
  const owned = await directory(ctx.session.id);
  const op = hash(input.operationId);
  const content = await read(path.join(owned, `${op}.op.json`));
  if (content === undefined) {
    return false;
  }
  const operation = localOperationSchema.parse(JSON.parse(content));
  const wrongOwner =
    operation.operationId !== input.operationId ||
    operation.marker.decision.adapterSessionId !== ctx.session.id;
  const wrongMarker =
    operation.marker.decision.scopeDigest !== input.scopeDigest ||
    operation.marker.nonce !== input.nonce;
  const wrongTurn =
    operation.marker.decision.turnSequence >= ctx.session.turn.sequence ||
    operation.marker.decision.turnSequence <= (await cancelledAuthoringSequence(owned));
  if (wrongOwner || wrongMarker || wrongTurn) {
    return false;
  }
  return await write(
    path.join(owned, `${op}.delivered.json`),
    JSON.stringify({ messageSequence: input.messageSequence, turnId: input.turnId }),
    true,
  );
};
/** Project uncertainty as uncertainty, independently of the ordinary response stream. */
export const readLocalAuthoringDispatchState = async (
  sessionId: string,
): Promise<"unknown" | "blocked" | undefined> => {
  const decision = await readLocalAuthoringDecision(sessionId);
  if (decision?.decision !== "runnable") {
    return undefined;
  }
  const owned = await directory(sessionId);
  const identity = hash(`${sessionId}:${decision.turnId}`);
  const op = hash(`preapproval_authoring_${identity}`);
  const [blocked, reservation] = await Promise.all([
    read(path.join(owned, `${op}.blocked.json`)),
    read(path.join(owned, `${op}.op.json`)),
  ]);
  if (blocked !== undefined) {
    return "blocked";
  }
  if (reservation === undefined) {
    return undefined;
  }
  localOperationSchema.parse(JSON.parse(reservation));
  const [delivered, accepted] = await Promise.all([
    read(path.join(owned, `${op}.delivered.json`)),
    read(path.join(owned, `${op}.accepted.json`)),
  ]);
  return delivered === undefined && accepted === undefined ? "unknown" : undefined;
};
/** The existing local service owns the one active response; this function never replaces a session or retries an unknown dispatch. */
export const continueLocalPreapprovalAuthoring = async (input: {
  sessionId: string;
  pendingInput: boolean;
  active: boolean;
  dispatch: (message: string) => Promise<void>;
  assertCurrent: (decision: PreapprovalAuthoringDecision) => Promise<void>;
  // oxlint-disable-next-line sonarjs/max-union-size -- Callers must distinguish inactive, accepted, uncertain and pre-dispatch blocked outcomes without treating unknown as retryable.
}): Promise<"idle" | "queued" | "unknown" | "blocked"> => {
  if (input.active || input.pendingInput) {
    return "idle";
  }
  const decision = await readLocalAuthoringDecision(input.sessionId);
  if (decision?.decision !== "runnable" || decision.scope === undefined) {
    return "idle";
  }
  const owned = await directory(input.sessionId);
  if (decision.turnSequence <= (await cancelledAuthoringSequence(owned))) {
    return "blocked";
  }
  const identity = `${input.sessionId}:${decision.turnId}`;
  const operationId = `preapproval_authoring_${hash(identity)}`;
  const op = hash(operationId);
  const file = path.join(owned, `${op}.op.json`);
  if ((await read(file)) !== undefined) {
    if ((await read(path.join(owned, `${op}.blocked.json`))) !== undefined) {
      return "blocked";
    }
    const delivered = await read(path.join(owned, `${op}.delivered.json`));
    const accepted = await read(path.join(owned, `${op}.accepted.json`));
    return delivered !== undefined || accepted !== undefined ? "queued" : "unknown";
  }
  const nonce = randomBytes(32).toString("hex");
  const operation = { marker: { decision, nonce }, operationId, version: 1 };
  if (!(await write(file, JSON.stringify(operation), true))) {
    return "unknown";
  }
  const blocked = async () => {
    await write(
      path.join(owned, `${op}.blocked.json`),
      JSON.stringify({ outcome: "rejected-before-dispatch" }),
      true,
    );
    return "blocked" as const;
  };
  const current = await readLocalAuthoringDecision(input.sessionId);
  if (
    current?.decision !== "runnable" ||
    current.turnId !== decision.turnId ||
    !isDeepStrictEqual(current, decision)
  ) {
    return await blocked();
  }
  // Reservation is durable before SDK submission. Its existence prevents any replay after a lost acknowledgement.
  try {
    await input.assertCurrent(decision);
    if (!isDeepStrictEqual(await readLocalAuthoringDecision(input.sessionId), decision)) {
      return await blocked();
    }
  } catch {
    return await blocked();
  }
  try {
    await input.dispatch(internalAuthoringMessage(operationId, nonce));
    await write(path.join(owned, `${op}.accepted.json`), JSON.stringify({ accepted: true }), true);
    return "queued";
  } catch {
    await write(
      path.join(owned, `${op}.unknown.json`),
      JSON.stringify({ outcome: "unknown" }),
      true,
    );
    return "unknown";
  }
};
