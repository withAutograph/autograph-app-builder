import { expect, it } from "vitest";
import { authorizeRepeatablePrivateApplyCalls } from "./native-recovery-repeatable-apply";

const scope = {
  appId: "app",
  appSpecDigest: "spec",
  proposalDigest: "proposal",
  workspaceId: "workspace",
  sessionId: "logical",
};
const fixture = () => ({
  descriptor: { logicalSessionId: "logical" },
  binding: { ownerRunId: "physical", logicalSessionId: "logical" },
  payload: {
    binding: { ownerRunId: "physical", logicalSessionId: "logical" },
    candidates: [
      {
        origin: { slot: 24 },
        serializedContext: {
          "eve.sessionId": "logical",
          "autograph-app-builder.private-apply-authority.v1": {
            // SAFETY: Synthetic authority is mutated only to the exact fixture scope.
            grant: null as typeof scope | null,
            pending: [{ callId: "call", scope: { ...scope } }],
          },
          "autograph-app-builder.workflow.v17": {
            phase: "planned",
            appSpec: { digest: "spec" },
            proposal: { digest: "proposal", target: { contract: { appId: "app" } } },
            workspace: { workspaceId: "workspace", workspaceDigest: "workspace-digest" },
            // SAFETY: Synthetic receipt variants are assigned by the cases below.
            applyReceipt: undefined as
              | {
                  appliedByCallId: string;
                  appSpecDigest: string;
                  proposalDigest: string;
                  workspaceDigest: string;
                }
              | undefined,
            // SAFETY: Synthetic failure variants use the same call-bound receipt fields.
            applyFailure: undefined as
              | {
                  appliedByCallId: string;
                  appSpecDigest: string;
                  proposalDigest: string;
                  workspaceDigest: string;
                }
              | undefined,
          },
        },
        sessionState: {
          snapshot: {
            session: {
              sessionId: "logical",
              history: [
                {
                  role: "assistant",
                  content: [
                    { type: "tool-call", toolName: "apply_app_creation", toolCallId: "call" },
                    { type: "tool-approval-request", toolCallId: "call", approvalId: "approval" },
                  ],
                },
                {
                  role: "tool",
                  content: [
                    { type: "tool-approval-response", approvalId: "approval", approved: true },
                  ],
                },
                { role: "assistant", content: "retained terminal text" },
              ],
            },
          },
        },
      },
    ],
  },
});
const context = (input: ReturnType<typeof fixture>) =>
  input.payload.candidates[0].serializedContext;
it("authorizes only exact retained pending scope without changing any state", () => {
  const input = fixture();
  const before = structuredClone(input);
  expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual(["call"]);
  expect(input).toEqual(before);
});
it("a matching current grant alone is not original-call authority", () => {
  const input = fixture();
  const authority = context(input)["autograph-app-builder.private-apply-authority.v1"];
  authority.pending = [];
  authority.grant = scope;
  expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual([]);
});
for (const mismatch of [
  "workspaceId",
  "proposalDigest",
  "appSpecDigest",
  "appId",
  "sessionId",
] as const) {
  it(`rejects changed ${mismatch} original call scope`, () => {
    const input = fixture();
    context(input)["autograph-app-builder.private-apply-authority.v1"].pending[0].scope[mismatch] =
      "different";
    expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual([]);
  });
}
for (const phase of ["applied", "apply_failed"]) {
  it(`allows genuine ${phase} call-bound receipt with current scope and rejects other call receipt`, () => {
    const input = fixture();
    const state = context(input);
    const authority = state["autograph-app-builder.private-apply-authority.v1"];
    authority.pending = [];
    authority.grant = scope;
    const workflow = state["autograph-app-builder.workflow.v17"];
    workflow.phase = phase;
    const receipt = {
      appliedByCallId: "call",
      appSpecDigest: "spec",
      proposalDigest: "proposal",
      workspaceDigest: "workspace-digest",
    };
    if (phase === "applied") {
      workflow.applyReceipt = receipt;
    } else {
      workflow.applyFailure = receipt;
    }
    expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual(["call"]);
    receipt.appliedByCallId = "other";
    expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual([]);
  });
}
it("rejects wrong physical owner and logical identity", () => {
  const input = fixture();
  input.binding.ownerRunId = "other";
  expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual([]);
  input.binding.ownerRunId = "physical";
  input.descriptor.logicalSessionId = "other";
  expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual([]);
});
it("does not authorize other tools, denied approvals, completed calls, or missing state", () => {
  const input = fixture();
  const session = input.payload.candidates[0].sessionState.snapshot.session;
  for (const history of [
    [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolName: "external_mutation", toolCallId: "call" }],
      },
    ],
    [...session.history, { role: "tool", content: [{ type: "tool-result", toolCallId: "call" }] }],
    [
      session.history[0],
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "approval", approved: false }],
      },
    ],
  ]) {
    expect(
      authorizeRepeatablePrivateApplyCalls({
        ...input,
        payload: {
          ...input.payload,
          candidates: [
            {
              ...input.payload.candidates[0],
              sessionState: { snapshot: { session: { ...session, history } } },
            },
          ],
        },
      }),
    ).toEqual([]);
  }
  expect(authorizeRepeatablePrivateApplyCalls({ ...input, payload: {} })).toEqual([]);
});

it("validates every old candidate while selecting the greatest slot without changing input", () => {
  const input = fixture();
  const latest = input.payload.candidates[0];
  const older = structuredClone(latest);
  older.origin.slot = 2;
  older.sessionState.snapshot.session.history = [];
  input.payload.candidates = [older, latest, { ...older, origin: { slot: 3 } }];
  const before = structuredClone(input);
  expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual(["call"]);
  expect(input).toEqual(before);
  const malformed = {
    ...older,
    sessionState: {
      snapshot: { session: { sessionId: "logical", history: [{ role: 7, content: [] }] } },
    },
  };
  expect(
    authorizeRepeatablePrivateApplyCalls({
      ...input,
      payload: { ...input.payload, candidates: [latest, malformed] },
    }),
  ).toEqual([]);
});
it("preserves first-candidate selection for equal greatest apply slots", () => {
  const input = fixture();
  const denied = structuredClone(input.payload.candidates[0]);
  denied.sessionState.snapshot.session.history = [];
  input.payload.candidates.push(denied);
  expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual(["call"]);
  input.payload.candidates.reverse();
  expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual([]);
});
