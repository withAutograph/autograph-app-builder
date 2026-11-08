/* oxlint-disable typescript/no-non-null-assertion, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Focused fixtures provide only consumed native coordinates; real stores and producer paths validate authority separately. */
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, unicorn/no-await-expression-member -- Native lifecycle observations and durable store transitions are deliberately ordered; fixture ports preserve their asynchronous interface. */
import { describe, expect, it } from "vitest";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  decidePreapprovalAuthoring,
  internalAuthoringMessage,
  readInternalAuthoringMarker,
  preapprovalAuthoringDecisionSchema,
} from "./preapproval-authoring";

const hash = (letter: string) => letter.repeat(64);
const accepted = (durable = false): AppBuilderWorkflowState =>
  // SAFETY: Only consumed immutable authoring-intent fields are modeled. No tool, provider, file or approval execution port exists.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Other workflow receipt fields are opaque and cannot authorize any effect here.
  ({
    version: 17,
    phase: "app_spec_accepted",
    preparedByCallId: "prepare",
    appSpec: {
      appId: "stock-review",
      acceptedByCallId: "accept-call",
      digest: hash("a"),
      artifactPath: "prototype/stock-review/app-spec.md",
      artifactRevision: hash("b"),
      ...(durable ? { version: 2 } : { content: "accepted inline legacy intent" }),
    },
    artifacts: durable
      ? [{ path: "prototype/stock-review/app-spec.md", revision: hash("b"), sessionId: "logical" }]
      : [],
    sourceReceipt: { digest: hash("c") },
    workspace: { workspaceId: "workspace", workspaceDigest: hash("d") },
  }) as unknown as AppBuilderWorkflowState;
const input = (state = accepted()) => ({
  state,
  adapterSessionId: "logical",
  turnId: "turn",
  turnSequence: 4,
  completed: true,
  pendingInput: false,
  pendingApproval: false,
  blocked: false,
  sourcePrerequisite: false,
});
describe("preapproval drafting intent", () => {
  it.each([false, true])(
    "continues a clean accepted intent using legacy=%s without an execution grant",
    (durable) => {
      const decision = decidePreapprovalAuthoring(input(accepted(durable)));
      expect(decision.decision).toBe("runnable");
      expect(decision.scope?.authoritySessionId).toBe("logical");
      expect(decision).not.toHaveProperty("approval");
      expect(preapprovalAuthoringDecisionSchema.parse(decision)).toEqual(decision);
    },
  );
  it("does not activate a read-only workflow with no accepted product intent", () => {
    const state = { version: 17, phase: "empty" } as AppBuilderWorkflowState;
    expect(decidePreapprovalAuthoring(input(state)).decision).toBe("blocked");
  });
  it.each(["pendingInput", "pendingApproval", "blocked", "sourcePrerequisite"] as const)(
    "halts at %s",
    (key) => {
      expect(decidePreapprovalAuthoring({ ...input(), [key]: true }).decision).not.toBe("runnable");
    },
  );
  it("records a running turn as working, never dispatchable", () => {
    expect(decidePreapprovalAuthoring({ ...input(), completed: false }).decision).toBe("working");
  });
  it("stops authoring when a real proposal exists, before any Build approval", () => {
    const state = {
      ...accepted(),
      phase: "planned",
      proposal: { digest: hash("e") },
    } as unknown as AppBuilderWorkflowState;
    expect(decidePreapprovalAuthoring(input(state)).decision).toBe("planned");
  });
  it("never relabels another session's accepted artifact", () => {
    const state = accepted(true);
    if (!("artifacts" in state)) {
      throw new Error("fixture");
    }
    state.artifacts[0].sessionId = "foreign";
    expect(decidePreapprovalAuthoring(input(state)).decision).toBe("blocked");
  });
  it("keeps source, workspace and acceptance changes in distinct immutable scopes", () => {
    const first = decidePreapprovalAuthoring(input());
    const state = accepted();
    if (!("workspace" in state)) {
      throw new Error("fixture");
    }
    state.workspace.workspaceDigest = hash("e");
    expect(decidePreapprovalAuthoring(input(state)).scopeDigest).not.toBe(first.scopeDigest);
    expect(() =>
      preapprovalAuthoringDecisionSchema.parse({ ...first, scopeDigest: hash("f") }),
    ).toThrow();
  });
  it("uses an explicitly unapproved marker instead of an approved-build marker", () => {
    const message = internalAuthoringMessage("draft_operation", hash("f"));
    expect(readInternalAuthoringMarker(message)).toMatchObject({
      nonce: hash("f"),
      operationId: "draft_operation",
    });
    expect(readInternalAuthoringMarker("untrusted text")).toBeUndefined();
    expect(message).not.toContain("autograph-private-build:");
    expect(message).toContain("grants no Build");
  });
});
