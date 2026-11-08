/* oxlint-disable eslint/no-bitwise -- Assert actual owner-only Unix permissions of the persisted reservation. */
/* oxlint-disable typescript/no-non-null-assertion, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Focused fixtures provide only consumed native coordinates; real stores and producer paths validate authority separately. */
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member -- Native lifecycle observations and durable store transitions are deliberately ordered; fixture ports preserve their asynchronous interface. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Hook fixture supplies the immutable session and turn coordinates consumed by actual private filesystem ports. */
import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { HookContext } from "eve/hooks";
import {
  recordLocalAuthoringDecision,
  continueLocalPreapprovalAuthoring,
  claimLocalAuthoringMessage,
  readLocalAuthoringDispatchState,
} from "./local-preapproval-authoring";
import { authoringScopeDigest, readInternalAuthoringMarker } from "./preapproval-authoring";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "authoring-")));
  roots.push(root);
  await mkdir(path.join(root, "runs"), { mode: 0o700 });
  for (const [key, value] of Object.entries({
    APP_BUILDER_DEV_RUNS_ROOT: path.join(root, "runs"),
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_HOSTED_ADAPTER: "0",
  })) {
    vi.stubEnv(key, value);
  }
  const scope = {
    authoritySessionId: "logical",
    appId: "app",
    appSpecDigest: "a".repeat(64),
    acceptedByCallId: "accept",
    artifactPath: "app.md",
    artifactRevision: "revision",
    sourceReceiptDigest: "b".repeat(64),
    workspaceId: "sandbox",
    workspaceDigest: "c".repeat(64),
    planningStateDigest: "d".repeat(64),
  };
  const decision = {
    version: 1 as const,
    kind: "preapproval-authoring-decision-v1" as const,
    adapterSessionId: "logical",
    turnId: "turn1",
    turnSequence: 1,
    decision: "runnable" as const,
    scope,
    scopeDigest: authoringScopeDigest(scope),
  };
  const ctx = { session: { id: "logical", turn: { id: "turn1", sequence: 1 } } } as Pick<
    HookContext,
    "session"
  >;
  await recordLocalAuthoringDecision(ctx, decision);
  const assertCurrent = vi.fn(async () => {});
  return { assertCurrent, ctx, decision, root };
};
describe("private local drafting reservation", () => {
  it("persists private single-link reservation before exactly one dispatch and authenticates exact delivery", async () => {
    const f = await fixture();
    let message = "";
    const dispatch = vi.fn(async (value: string) => {
      message = value;
      const names = await readdir(path.join(f.root, "preapproval-authoring-continuations"));
      const dir = path.join(f.root, "preapproval-authoring-continuations", names[0]);
      const op = (await readdir(dir)).find((file) => file.endsWith(".op.json"))!;
      const info = await stat(path.join(dir, op));
      expect(info.nlink).toBe(1);
      expect(info.mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(dir, op), "utf-8")).toContain("nonce");
    });
    const input = {
      sessionId: "logical",
      active: false,
      pendingInput: false,
      dispatch,
      assertCurrent: f.assertCurrent,
    };
    expect(await continueLocalPreapprovalAuthoring(input)).toBe("queued");
    expect(await continueLocalPreapprovalAuthoring(input)).toBe("queued");
    expect(dispatch).toHaveBeenCalledOnce();
    const marker = readInternalAuthoringMarker(message)!;
    const ctx = { session: { id: "logical", turn: { id: "turn2", sequence: 2 } } } as Pick<
      HookContext,
      "session"
    >;
    const claim = {
      nonce: marker.nonce,
      operationId: marker.operationId,
      turnId: "turn2",
      messageSequence: 0,
      scopeDigest: f.decision.scopeDigest,
    };
    expect(await claimLocalAuthoringMessage(ctx, { ...claim, scopeDigest: "d".repeat(64) })).toBe(
      false,
    );
    expect(await claimLocalAuthoringMessage(ctx, claim)).toBe(true);
    expect(await claimLocalAuthoringMessage(ctx, claim)).toBe(true);
    expect(await claimLocalAuthoringMessage(ctx, { ...claim, messageSequence: 1 })).toBe(false);
  });
  it("never resends a lost acknowledgement even after a second GET", async () => {
    const f = await fixture();
    const dispatch = vi.fn(async () => {
      throw new Error("lost ack");
    });
    const input = {
      sessionId: "logical",
      active: false,
      pendingInput: false,
      dispatch,
      assertCurrent: f.assertCurrent,
    };
    expect(await continueLocalPreapprovalAuthoring(input)).toBe("unknown");
    expect(await continueLocalPreapprovalAuthoring(input)).toBe("unknown");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await readLocalAuthoringDispatchState("logical")).toBe("unknown");
  });
  it("rechecks current owner and pending proposal boundary before dispatch", async () => {
    await fixture();
    const dispatch = vi.fn<() => Promise<void>>().mockResolvedValue();
    const assertCurrent = vi.fn(async () => {
      throw new Error("new proposal");
    });
    expect(
      await continueLocalPreapprovalAuthoring({
        sessionId: "logical",
        active: false,
        pendingInput: false,
        dispatch,
        assertCurrent,
      }),
    ).toBe("blocked");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await readLocalAuthoringDispatchState("logical")).toBe("blocked");
  });
  it("refuses active/pending calls without reserving or dispatching", async () => {
    const f = await fixture();
    const dispatch = vi.fn<() => Promise<void>>().mockResolvedValue();
    for (const flags of [
      { active: true, pendingInput: false },
      { active: false, pendingInput: true },
    ]) {
      expect(
        await continueLocalPreapprovalAuthoring({
          ...flags,
          sessionId: "logical",
          dispatch,
          assertCurrent: f.assertCurrent,
        }),
      ).toBe("idle");
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.assertCurrent).not.toHaveBeenCalled();
  });
});
