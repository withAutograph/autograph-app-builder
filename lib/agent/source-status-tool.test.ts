import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "eve/tools";
import type { SourceWorkflowState } from "@/lib/agent/source-state";

const mocks = vi.hoisted(() => ({
  state: { version: 3, phase: "empty" } as SourceWorkflowState,
  acquireCanonicalArrustedTemplate: vi.fn(),
  canAutoSelectDevelopmentSource: vi.fn(() => false),
  developmentSourceReceipt: vi.fn(),
}));

vi.mock("@/lib/agent/source-state", () => ({
  APP_BUILDER_SOURCE_VERSION: 3,
  sourceWorkflowState: {
    get: () => mocks.state,
    update: (update: (current: SourceWorkflowState) => SourceWorkflowState) => {
      mocks.state = update(mocks.state);
    },
  },
}));

vi.mock("@/lib/repository/arrusted-template", () => ({
  acquireCanonicalArrustedTemplate: mocks.acquireCanonicalArrustedTemplate,
}));

vi.mock("@/lib/repository/development-source", () => ({
  canAutoSelectDevelopmentSource: mocks.canAutoSelectDevelopmentSource,
  developmentSourceReceipt: mocks.developmentSourceReceipt,
}));

import sourceStatus from "../../agent/tools/source_status";

const receipt = {
  version: 3,
  sourceKind: "fresh-template",
  sourcePath: "/workspace/repository",
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
  adapter: "arrusted-development-v0",
  eligibilityDigest: "c".repeat(64),
  contractDigest: "e".repeat(64),
  releaseEnabled: false,
  digest: "d".repeat(64),
} as const;

describe("source_status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = { version: 3, phase: "empty" };
    mocks.canAutoSelectDevelopmentSource.mockReturnValue(false);
    mocks.acquireCanonicalArrustedTemplate.mockResolvedValue(receipt);
  });

  it("automatically acquires and binds the canonical starter for an empty hosted flow", async () => {
    const sandbox = { id: "sandbox" };
    const getSandbox = vi.fn(async () => sandbox);

    const result = await sourceStatus.execute({}, {
      callId: "source-status-call",
      getSandbox,
    } as unknown as ToolContext);

    expect(getSandbox).toHaveBeenCalledOnce();
    expect(mocks.acquireCanonicalArrustedTemplate).toHaveBeenCalledWith({
      sandbox,
      callId: "source-status-call",
    });
    expect(result).toEqual({
      version: 3,
      phase: "acquisition_approved",
      receipt,
    });
    expect(mocks.state).toEqual({
      version: 3,
      phase: "acquisition_approved",
      receipt,
      approvedByCallId: "source-status-call",
    });
  });

  it("does not reacquire an already bound source", async () => {
    mocks.state = {
      version: 3,
      phase: "acquisition_approved",
      receipt,
      approvedByCallId: "first-call",
    };

    const result = await sourceStatus.execute({}, {
      callId: "retry-call",
      getSandbox: vi.fn(),
    } as unknown as ToolContext);

    expect(mocks.acquireCanonicalArrustedTemplate).not.toHaveBeenCalled();
    expect(result).toEqual({
      version: 3,
      phase: "acquisition_approved",
      receipt,
    });
  });
});
