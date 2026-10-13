/* oxlint-disable anti-slop/no-module-mocking -- Eve owns the state singleton and tool registration; isolate those runtime boundaries while exercising the real status and acceptance tools. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import status from "../../agent/tools/artifact_workflow_status";
import accept from "../../agent/tools/accept_ui_preview";

interface TestWorkflow {
  artifacts: { revision: string; sessionId: string }[];
  appSpec?: {
    appId: string;
    artifactPath: string;
    artifactRevision: string;
    approvalReceipt?: { token: string };
    content?: string;
    digest: string;
    uiRevision?: string;
    walkthrough?: string;
  };
  dependencyReceipt?: { digest: string };
  identityReceipt?: { digest: string };
  phase: string;
  proposal?: { digest: string };
  uiPreview?: { appId: string; revision: string; sourceDigest?: string };
  version: number;
  workspace: object;
}
const mocks = vi.hoisted(() => {
  const state: TestWorkflow = { artifacts: [], phase: "empty", version: 17, workspace: {} };
  return { state, update: vi.fn() };
});
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T): T => value }));
vi.mock("./prototype-artifacts", () => ({ prototypeArtifactReceipt: <T>(value: T): T => value }));
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 17,
  appBuilderWorkflowState: { get: () => mocks.state },
  updateExactWorkflow: mocks.update,
}));
const revision = "a".repeat(64);
const artifactRevision = "b".repeat(64);
const currentUiRevision = "c".repeat(64);
const acceptedUiRevision = "d".repeat(64);
// SAFETY: These tools only read session.id and callId; no other Eve services are invoked.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately minimal Eve tool context for isolated synchronous tools.
const context = { callId: "accept", session: { id: "session" } } as Parameters<
  typeof status.execute
>[1];

describe("UI preview revision recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = {
      artifacts: [{ revision: artifactRevision, sessionId: "session" }],
      phase: "ui_previewed",
      uiPreview: { appId: "example", revision, sourceDigest: revision },
      version: 17,
      workspace: {},
    };
  });
  it("recovers the UI revision separately from document revisions and finalizes it", () => {
    const receipt = status.execute({}, context);
    expect(receipt).toMatchObject({
      artifacts: [{ revision: artifactRevision }],
      uiPreview: { revision },
    });
    if (!("uiPreview" in receipt) || !receipt.uiPreview) {
      throw new Error("Missing UI receipt");
    }
    expect(accept.execute({ expectedRevision: receipt.uiPreview.revision }, context)).toEqual({
      accepted: true,
      appId: "example",
      revision,
    });
    expect(mocks.update).toHaveBeenCalledOnce();
  });
  it("still rejects a document revision and a genuinely replaced UI revision", () => {
    expect(() => {
      void accept.execute({ expectedRevision: artifactRevision }, context);
    }).toThrow("changed before finalization");
    mocks.state = { ...mocks.state, uiPreview: { appId: "example", revision: "c".repeat(64) } };
    expect(() => {
      void accept.execute({ expectedRevision: revision }, context);
    }).toThrow("changed before finalization");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not invent a UI revision before one has been recorded", () => {
    mocks.state = { artifacts: [], phase: "workspace_prepared", version: 17, workspace: {} };
    expect(status.execute({}, context)).not.toHaveProperty("uiPreview");
  });
  it("keeps the accepted UI reference visible in a planned phase without claiming current UI source", () => {
    mocks.state = {
      appSpec: {
        appId: "example",
        approvalReceipt: { token: "private-approval-token" },
        artifactPath: "apps/example/APP_SPEC.md",
        artifactRevision,
        content: "private app-spec source bytes",
        digest: "e".repeat(64),
        uiRevision: acceptedUiRevision,
        walkthrough: "private walkthrough text",
      },
      artifacts: [{ revision: artifactRevision, sessionId: "session" }],
      dependencyReceipt: { digest: "f".repeat(64) },
      identityReceipt: { digest: "1".repeat(64) },
      phase: "planned",
      proposal: { digest: "2".repeat(64) },
      version: 17,
      workspace: {},
    };

    const receipt = status.execute({}, context);
    expect(receipt).toMatchObject({
      acceptedUIReference: { appId: "example", revision: acceptedUiRevision },
      appSpec: { uiRevision: acceptedUiRevision },
      phase: "planned",
    });
    expect(receipt).not.toHaveProperty("uiPreview");
    expect(receipt).not.toHaveProperty("currentUI");
    expect(receipt).not.toHaveProperty("acceptedUIReference.sourceDigest");
    expect(receipt).not.toHaveProperty("sourceFiles");
    expect(receipt).not.toHaveProperty("permissions");
    expect(receipt.appSpec).not.toHaveProperty("content");
    expect(receipt.appSpec).not.toHaveProperty("walkthrough");
    expect(receipt.appSpec).not.toHaveProperty("approvalReceipt");
  });
  it("leaves the accepted UI reference absent for legacy AppSpecs without one", () => {
    mocks.state = {
      appSpec: {
        appId: "legacy-example",
        artifactPath: "apps/legacy-example/APP_SPEC.md",
        artifactRevision,
        digest: "3".repeat(64),
      },
      artifacts: [],
      dependencyReceipt: { digest: "4".repeat(64) },
      identityReceipt: { digest: "5".repeat(64) },
      phase: "planned",
      proposal: { digest: "6".repeat(64) },
      version: 17,
      workspace: {},
    };

    const receipt = status.execute({}, context);
    expect(receipt).not.toHaveProperty("acceptedUIReference");
    expect(receipt.appSpec).not.toHaveProperty("uiRevision");
    expect(receipt).not.toHaveProperty("uiPreview");
  });
  it("keeps an early component-backed UI receipt distinct from accepted AppSpec metadata", () => {
    mocks.state = {
      artifacts: [],
      phase: "ui_accepted",
      uiPreview: { appId: "example", revision: currentUiRevision, sourceDigest: "7".repeat(64) },
      version: 17,
      workspace: {},
    };

    const receipt = status.execute({}, context);
    expect(receipt).toMatchObject({
      uiPreview: {
        appId: "example",
        revision: currentUiRevision,
        sourceDigest: "7".repeat(64),
      },
    });
    expect(receipt).not.toHaveProperty("acceptedUIReference");
    expect(receipt).not.toHaveProperty("appSpec");
  });
});
