import { beforeEach, describe, expect, it, vi } from "vitest";

import verifyAppBehavior from "../../agent/tools/verify_app_behavior";

const mocks = vi.hoisted(() => ({
  authority: vi.fn(),
  evidence: vi.fn(),
  hasLive: vi.fn(() => true),
  preview: {
    receipt: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      url: "https://preview.test/__autograph_preview_launch?token=private",
    },
    sandboxId: "sandbox-one",
  },
  readback: vi.fn(),
}));

vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("./product-behavior", () => ({ executeProductReadback: mocks.readback }));
vi.mock("./product-behavior-state", () => ({ recordProductBehaviorEvidence: mocks.evidence }));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: {
    get: () => ({
      appSpec: {
        content:
          "## Acceptance walkthrough\n\nCreate a durable draft and read it back.\n\n## Build handoff",
        digest: "a".repeat(64),
      },
      applyReceipt: { digest: "b".repeat(64) },
      phase: "applied",
    }),
  },
}));
vi.mock("./working-preview-state", () => ({
  hasLiveWorkingPreview: mocks.hasLive,
  workingPreviewState: { get: () => mocks.preview },
}));
vi.mock("../sandbox/deployment-execution-lease", () => ({
  assertHostedSandboxCommandAuthority: mocks.authority,
}));

const scenario = {
  body: { title: "Draft" },
  markerField: "marker",
  outcomeId: "durable-draft",
  readPath: "/api/drafts/current",
  readPointer: "/draft/marker",
  writePath: "/api/drafts",
};
const context = {
  abortSignal: new AbortController().signal,
  getSandbox: vi.fn(() => Promise.resolve({ id: "sandbox-one" })),
  session: { id: "session-one" },
} as unknown as Parameters<typeof verifyAppBehavior.execute>[1];

describe("verify_app_behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasLive.mockReturnValue(true);
  });

  it("blocks before any application request when no current preview exists", async () => {
    mocks.hasLive.mockReturnValue(false);
    await expect(
      verifyAppBehavior.execute(
        { acceptedOutcomeText: "Create a durable draft and read it back.", scenario },
        context,
      ),
    ).rejects.toThrow("current working preview");
    expect(mocks.readback).not.toHaveBeenCalled();
  });

  it("rejects outcome text absent from the accepted walkthrough", async () => {
    await expect(
      verifyAppBehavior.execute(
        { acceptedOutcomeText: "Invent an unrelated acceptance outcome.", scenario },
        context,
      ),
    ).rejects.toThrow("not present in the accepted walkthrough");
    expect(context.getSandbox).not.toHaveBeenCalled();
    expect(mocks.readback).not.toHaveBeenCalled();
  });

  it("records a passing action-readback as partial evidence only", async () => {
    const evidence = {
      coverage: "action-readback-only" as const,
      outcomeId: scenario.outcomeId,
      reason: "Independent application read returned the verifier-written value.",
      status: "passed" as const,
      unassessed: ["restart-durability", "authentication", "tenant-isolation", "child-generation"],
    };
    mocks.readback.mockResolvedValue(evidence);
    const result = await verifyAppBehavior.execute(
      { acceptedOutcomeText: "Create a durable draft and read it back.", scenario },
      context,
    );
    expect(result).toMatchObject({ evidence, productStatus: "unassessed" });
    expect(mocks.readback).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.objectContaining({ launchUrl: mocks.preview.receipt.url }),
        scenario,
      }),
    );
    expect(mocks.evidence).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedOutcomeText: "Create a durable draft and read it back.",
        appSpecDigest: "a".repeat(64),
        applyDigest: "b".repeat(64),
        result: evidence,
      }),
    );
  });
});
