import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { appBaselineReceiptSchema, appBaselineSelectionSchema } from "../repository/app-baseline";
import { openAppBaselineSource } from "./app-baseline-sandbox";
import type { AppBaselineSourceOpening } from "./app-baseline-sandbox";

const repository = { name: "arrusted", owner: "example", repositoryId: "100" };
const selected = () => {
  const selection = appBaselineSelectionSchema.parse({
    appId: "spend-review",
    historical: { commitSha: "a".repeat(40), ...repository, treeSha: "b".repeat(40) },
    selectedByCallId: "select",
    sessionId: "session-one",
    source: { commitSha: "a".repeat(40), kind: "commit" },
  });
  const unsigned = {
    ...selection,
    platform: { commitSha: "c".repeat(40), ref: "refs/heads/platform", treeSha: "d".repeat(40) },
    platformSourceDigest: "e".repeat(64),
    projectedByCallId: "prepare",
    removedFiles: 1,
    restoredFiles: 1,
    retainedReleaseFiles: 1,
    sourceDigest: "f".repeat(64),
    unexposedReleaseDigest: "0".repeat(64),
    version: 1,
  };
  return {
    receipt: appBaselineReceiptSchema.parse({
      ...unsigned,
      digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
    }),
    selection,
  };
};
interface Compute {
  id: string;
  baselinePrepared: boolean;
}
const sourceOpening = (prepared: boolean) => {
  const baseline = selected();
  const compute: Compute = { baselinePrepared: prepared, id: "sandbox" };
  const events: string[] = [];
  const restore = vi.fn(async (sandbox: Compute) => {
    events.push("restore baseline");
    sandbox.baselinePrepared = true;
    await Promise.resolve();
  });
  const input: AppBaselineSourceOpening<Compute> = {
    baseline,
    bindSource() {
      events.push("bind source");
    },
    isPrepared: async (sandbox) => await Promise.resolve(sandbox.baselinePrepared),
    openSandbox: async () => {
      events.push("open compute");
      return await Promise.resolve(compute);
    },
    repository,
    restore,
    sessionId: "session-one",
  };
  return { baseline, compute, events, input, restore };
};

describe("app baseline source continuity", () => {
  it("restores replacement compute before returning it to app-source inspection", async () => {
    const f = sourceOpening(false);
    const sandbox = await openAppBaselineSource(f.input);
    expect(sandbox.baselinePrepared).toBe(true);
    expect(f.events).toEqual(["bind source", "open compute", "restore baseline"]);
    expect(f.restore).toHaveBeenCalledWith(f.compute, f.baseline);
  });
  it("leaves healthy authored compute intact without replaying projection", async () => {
    const f = sourceOpening(true);
    await openAppBaselineSource(f.input);
    expect(f.events).toEqual(["bind source", "open compute"]);
    expect(f.restore).not.toHaveBeenCalled();
  });
  it("parks a pending selection before exposing any unprojected app source", async () => {
    const f = sourceOpening(false);
    f.input.baseline = { selection: f.baseline.selection };
    await expect(openAppBaselineSource(f.input)).rejects.toThrow("Retry resolve_github_source");
    expect(f.events).toEqual([]);
  });
  it("rejects another session or an absent repository before compute opens", async () => {
    const f = sourceOpening(false);
    await expect(openAppBaselineSource({ ...f.input, sessionId: "other-session" })).rejects.toThrow(
      "different Builder session or repository",
    );
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Exercise an absent source binding.
    await expect(openAppBaselineSource({ ...f.input, repository: undefined })).rejects.toThrow(
      "Retry resolve_github_source",
    );
    expect(f.events).toEqual([]);
  });
});
