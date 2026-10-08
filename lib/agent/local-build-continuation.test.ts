/* oxlint-disable typescript/no-unsafe-type-assertion -- Minimal hook session metadata exercises the actual owner-bound local file contract; approval classification has separate real Eve context checks. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { HookContext } from "eve/hooks";
import {
  recordLocalBuildDecision,
  readLocalBuildDecision,
  continueApprovedLocalBuild,
  claimLocalBuildMessage,
} from "./local-build-continuation";
import { readInternalBuildMarker } from "./approved-build-continuation";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});
const fixture = async () => {
  const stateRoot = await realpath(await mkdtemp(path.join(tmpdir(), "approved-build-local-")));
  roots.push(stateRoot);
  const runs = path.join(stateRoot, "runs");
  await mkdir(runs, { mode: 0o700 });
  for (const [name, value] of Object.entries({
    APP_BUILDER_DEV_RUNS_ROOT: runs,
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_HOSTED_ADAPTER: "0",
  })) {
    vi.stubEnv(name, value);
  }
  const decision = {
    adapterSessionId: "original-local-session",
    decision: "runnable" as const,
    scope: {
      appId: "spend-review",
      appSpecDigest: "a".repeat(64),
      proposalDigest: "b".repeat(64),
      sessionId: "original-local-session",
      workspaceId: "private-workspace",
    },
    turnId: "stopped-turn14",
    turnSequence: 13,
    version: 1 as const,
    workflowPhase: "validation_failed",
  };
  // SAFETY: The file recorder consumes exactly the supplied immutable session id and turn coordinates.
  const ctx = {
    session: { id: decision.adapterSessionId, turn: { id: decision.turnId, sequence: 13 } },
  } as Pick<HookContext, "session">;
  await recordLocalBuildDecision(ctx, decision);
  return { ctx, decision, stateRoot };
};
describe("actual private local approved build continuation", () => {
  it("reserves one same-session dispatch and authenticates only its exact delivered event", async () => {
    const f = await fixture();
    const dispatch = vi.fn(async (_message: string) => {
      await Promise.resolve();
    });
    const input = {
      active: false,
      dispatch,
      pendingInput: false,
      sessionId: f.decision.adapterSessionId,
    };
    await continueApprovedLocalBuild(input);
    await continueApprovedLocalBuild(input);
    expect(dispatch).toHaveBeenCalledOnce();
    const marker = readInternalBuildMarker(dispatch.mock.calls[0]?.[0] ?? "");
    if (marker?.operationId === undefined || marker.nonce === undefined) {
      throw new Error("Expected real private reservation marker");
    }
    // SAFETY: The marker claimer consumes exactly these supplied session and turn coordinates.
    const delivered = {
      session: { id: f.decision.adapterSessionId, turn: { id: "delivered15", sequence: 14 } },
    } as Pick<HookContext, "session">;
    expect(
      await claimLocalBuildMessage(delivered, {
        messageSequence: 0,
        nonce: marker.nonce,
        operationId: marker.operationId,
        turnId: "delivered15",
      }),
    ).toBe(true);
    expect(
      await claimLocalBuildMessage(delivered, {
        messageSequence: 1,
        nonce: marker.nonce,
        operationId: marker.operationId,
        turnId: "delivered15",
      }),
    ).toBe(false);
    expect(
      await claimLocalBuildMessage(delivered, {
        messageSequence: 0,
        nonce: "f".repeat(64),
        operationId: "forged",
        turnId: "delivered15",
      }),
    ).toBe(false);
  });
  it("never resends unknown submission and honors active/input/current-owner boundaries", async () => {
    const f = await fixture();
    const dispatch = vi.fn(async (_message: string) => {
      await Promise.resolve();
      throw new Error("lost acknowledgement");
    });
    const input = {
      active: false,
      dispatch,
      pendingInput: false,
      sessionId: f.decision.adapterSessionId,
    };
    expect(await continueApprovedLocalBuild({ ...input, active: true })).toBe(false);
    expect(await continueApprovedLocalBuild({ ...input, pendingInput: true })).toBe(false);
    await continueApprovedLocalBuild(input);
    await continueApprovedLocalBuild(input);
    expect(dispatch).toHaveBeenCalledOnce();
    await chmod(f.stateRoot, 0o755);
    await expect(readLocalBuildDecision(f.decision.adapterSessionId)).rejects.toThrow();
  });
});
