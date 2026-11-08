import type { SandboxEnvironment } from "eve/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createVerifyAppBehaviorTool } from "../../agent/tools/verify_app_behavior";
import { executeProductReadback } from "./product-behavior";
import { workingPreviewState } from "./working-preview-state";

type Dependencies = Parameters<typeof createVerifyAppBehaviorTool>[0];

const mocks = vi.hoisted(() => ({
  authority: vi.fn<Dependencies["authority"]>(),
  current: vi.fn(() => true),
  eligible: vi.fn(() => true),
  evidence: vi.fn<Dependencies["record"]>(),
  generation: vi.fn(() => 0),
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

// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./product-behavior dependency used by this test.
vi.mock("./product-behavior", () => ({ executeProductReadback: mocks.readback }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./working-preview-state dependency used by this test.
vi.mock("./working-preview-state", () => ({
  hasLiveWorkingPreview: mocks.hasLive,
  workingPreviewState: { get: () => mocks.preview },
}));

const verifyAppBehavior = createVerifyAppBehaviorTool({
  authority: mocks.authority,
  capture: () =>
    mocks.eligible()
      ? { commandId: "command", previewGeneration: 0, sourceGeneration: mocks.generation() }
      : undefined,
  generation: mocks.generation,
  hasLive: mocks.hasLive,
  isCurrent: mocks.current,
  preview: () => workingPreviewState.get(),
  readback: executeProductReadback,
  record: mocks.evidence,
  workflow: () => ({
    appSpec: {
      content:
        "## Acceptance walkthrough\n\nCreate a durable draft and read it back.\n\n## Build handoff",
      digest: "a".repeat(64),
    },
    applyReceipt: { digest: "b".repeat(64) },
    phase: "applied",
  }),
});

const scenario = {
  body: { title: "Draft" },
  markerField: "marker",
  outcomeId: "durable-draft",
  readPath: "/api/drafts/current",
  readPointer: "/draft/marker",
  writePath: "/api/drafts",
};
const unexpectedOperation = () => {
  throw new Error("Unexpected tool context or sandbox operation");
};
const getSandbox = vi.fn(() =>
  Promise.resolve({
    id: "sandbox-one",
    readFile: unexpectedOperation,
    readBinaryFile: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeFile: unexpectedOperation,
    writeBinaryFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    run: unexpectedOperation,
    spawn: unexpectedOperation,
    removePath: unexpectedOperation,
    resolvePath: unexpectedOperation,
    delete: unexpectedOperation,
    stop: unexpectedOperation,
  }),
);
const context: Parameters<typeof verifyAppBehavior.execute>[1] = {
  abortSignal: new AbortController().signal,
  callId: "verify-app-behavior",
  getSandbox: (environment?: SandboxEnvironment<object | undefined>) => {
    if (environment !== undefined) {
      throw new Error("Unexpected sandbox environment");
    }
    return getSandbox();
  },
  getToken: unexpectedOperation,
  requireAuth: unexpectedOperation,
  session: {
    auth: { current: null, initiator: null },
    id: "session-one",
    turn: { id: "verify-app-behavior-turn", sequence: 0 },
  },
  toolName: "verify_app_behavior",
};

describe("verify_app_behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasLive.mockReturnValue(true);
    mocks.eligible.mockReturnValue(true);
    mocks.current.mockReturnValue(true);
    mocks.generation.mockReturnValue(0);
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

  it("rejects an older preview after implementation repair before probing it", async () => {
    mocks.eligible.mockReturnValue(false);
    await expect(
      verifyAppBehavior.execute(
        { acceptedOutcomeText: "Create a durable draft and read it back.", scenario },
        context,
      ),
    ).rejects.toThrow("Reopen the working preview");
    expect(mocks.readback).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();
  });
  it("rejects outcome text absent from the accepted walkthrough", async () => {
    await expect(
      verifyAppBehavior.execute(
        { acceptedOutcomeText: "Invent an unrelated acceptance outcome.", scenario },
        context,
      ),
    ).rejects.toThrow("not present in the accepted walkthrough");
    expect(getSandbox).not.toHaveBeenCalled();
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
    expect(result).toMatchObject({ eligibility: "current", evidence, productStatus: "unassessed" });
    expect(mocks.readback).toHaveBeenCalledWith(
      expect.objectContaining({
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing asymmetric test matcher.
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
  it.each(["passed", "failed", "blocked"] as const)(
    "retains an in-flight %s observation after source or runtime replacement without current credit",
    async (status) => {
      const evidence = { coverage: "action-readback-only", reason: "Observed result.", status };
      mocks.readback.mockImplementationOnce(() => {
        mocks.current.mockReturnValue(false);
        return Promise.resolve(evidence);
      });
      const result = await verifyAppBehavior.execute(
        { acceptedOutcomeText: "Create a durable draft and read it back.", scenario },
        context,
      );
      expect(result).toMatchObject({
        eligibility: "historical-only",
        evidence,
        productStatus: "unassessed",
      });
      expect(mocks.evidence).toHaveBeenCalledWith(
        expect.objectContaining({
          provenance: { commandId: "command", previewGeneration: 0, sourceGeneration: 0 },
          result: evidence,
        }),
      );
    },
  );
  it("does not bind an old specification to a new source generation after asynchronous setup", async () => {
    mocks.generation.mockReturnValueOnce(0).mockReturnValue(1);
    await expect(
      verifyAppBehavior.execute(
        { acceptedOutcomeText: "Create a durable draft and read it back.", scenario },
        context,
      ),
    ).rejects.toThrow("Reopen the working preview");
    expect(mocks.readback).not.toHaveBeenCalled();
  });
});
