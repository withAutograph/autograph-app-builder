import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import {
  deriveInstalledEveStatus,
  latestInstalledPrototype,
  projectInstalledEveEvents,
  projectInstalledEveEvent,
  toPublicEvent,
} from "./public-events";

const installedEvent = (event: unknown) => event as MessageStreamEvent;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recordedPrototypeEvents(input?: {
  callId?: string;
  content?: string;
  outputDigest?: string;
  resultStatus?: "completed" | "failed" | "rejected";
  resultToolName?: string;
}): MessageStreamEvent[] {
  const callId = input?.callId ?? "call_prototype";
  const content =
    input?.content ??
    "<!doctype html><html><body><button>Review vendor</button></body></html>";
  const path = "prototype/vendor-onboarding/index.html";
  const mediaType = "text/html";
  const artifactDigest = digest(content);
  const revision = digest(
    JSON.stringify({ path, mediaType, digest: artifactDigest }),
  );
  return [
    installedEvent({
      type: "actions.requested",
      data: {
        actions: [
          {
            kind: "tool-call",
            callId,
            toolName: "record_prototype_artifact",
            input: { path, mediaType, content },
          },
        ],
      },
    }),
    installedEvent({
      type: "action.result",
      data: {
        status: input?.resultStatus ?? "completed",
        result: {
          kind: "tool-result",
          callId,
          toolName: input?.resultToolName ?? "record_prototype_artifact",
          output: {
            appId: "vendor-onboarding",
            path,
            mediaType,
            digest: input?.outputDigest ?? artifactDigest,
            revision,
            sessionId: "wrun_1",
            recordedByCallId: callId,
            size: Buffer.byteLength(content),
            reused: false,
          },
        },
      },
    }),
  ];
}

describe("toPublicEvent", () => {
  it("publishes an allowlisted assistant message", () => {
    expect(
      toPublicEvent({
        type: "assistant.message",
        index: 4,
        turnId: "turn_1",
        text: "Done.",
      }),
    ).toEqual({
      type: "assistant_message",
      index: 4,
      turnId: "turn_1",
      text: "Done.",
    });
  });

  it.each(["reasoning.delta", "tool.result", "system.instructions"])(
    "drops %s",
    (type) => {
      expect(
        toPublicEvent({ type, index: 1, text: "secret", message: "secret" }),
      ).toBeNull();
    },
  );
});

describe("installed Eve 0.43 projection", () => {
  it("recovers only the latest receipt-bound HTML prototype", () => {
    const first = recordedPrototypeEvents();
    const second = recordedPrototypeEvents({
      callId: "call_prototype_2",
      content: "<!doctype html><html><body>Updated review queue</body></html>",
    });
    const expected = second[0] as MessageStreamEvent & {
      data: { actions: [{ input: { content: string } }] };
    };

    expect(latestInstalledPrototype([...first, ...second])).toMatchObject({
      path: "prototype/vendor-onboarding/index.html",
      mediaType: "text/html",
      content: expected.data.actions[0].input.content,
    });
    expect(
      latestInstalledPrototype([
        ...first,
        ...recordedPrototypeEvents({
          callId: "call_failed",
          content: "<html>failed replacement</html>",
          resultStatus: "failed",
        }),
      ]),
    ).toEqual(latestInstalledPrototype(first));
  });

  it("rejects unmatched, failed, wrong-tool, and digest-mismatched prototypes", () => {
    const valid = recordedPrototypeEvents();
    expect(latestInstalledPrototype([valid[1]!])).toBeUndefined();
    expect(
      latestInstalledPrototype(
        recordedPrototypeEvents({ resultStatus: "rejected" }),
      ),
    ).toBeUndefined();
    expect(
      latestInstalledPrototype(
        recordedPrototypeEvents({ resultToolName: "another_tool" }),
      ),
    ).toBeUndefined();
    expect(
      latestInstalledPrototype(
        recordedPrototypeEvents({ outputDigest: "f".repeat(64) }),
      ),
    ).toBeUndefined();

    const malformedRequest = structuredClone(valid);
    const requested = malformedRequest[0] as MessageStreamEvent & {
      data: { actions: [{ input: { path: string } }] };
    };
    requested.data.actions[0].input.path =
      "prototype/vendor-onboarding/app-spec.md";
    expect(latestInstalledPrototype(malformedRequest)).toBeUndefined();
  });

  it("projects a stable title and only a closed approval receipt", () => {
    const receipt = {
      format: "autograph-eve-approval-receipt-v2",
      phase: "appspec",
      outcome: "accept-appspec",
      repositoryId: "1234",
      repository: "withAutograph/arrusted-development",
      baseRef: "refs/heads/main",
      baseSha: "a".repeat(40),
      subjectDigest: "b".repeat(64),
    };
    expect(
      projectInstalledEveEvent(
        installedEvent({
          type: "input.requested",
          data: {
            requests: [
              {
                requestId: "req_appspec",
                kind: "tool-approval",
                prompt: "Raw provider prompt",
                action: {
                  kind: "tool-call",
                  toolName: "accept_app_spec",
                  input: {
                    approvalReceipt: receipt,
                    path: "/private/workspace",
                    content: "private AppSpec",
                  },
                },
              },
            ],
          },
        }),
        3,
      ),
    ).toEqual([
      {
        type: "input.requested",
        index: 3,
        request: {
          requestId: "req_appspec",
          kind: "approval",
          title: "Approve AppSpec",
          description: JSON.stringify(receipt),
          allowFreeform: false,
        },
      },
    ]);
  });

  it("keeps a normal local AppSpec approval actionable with a closed subject", () => {
    const projected = projectInstalledEveEvent(
      installedEvent({
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_local_appspec",
              kind: "tool-approval",
              prompt: "Raw provider prompt",
              action: {
                kind: "tool-call",
                toolName: "accept_app_spec",
                input: {
                  appId: "billing-console",
                  expectedArtifactDigest: "1".repeat(64),
                  expectedArtifactRevision: "2".repeat(64),
                  expectedSourceSha: "a".repeat(40),
                  expectedSourceTree: "b".repeat(40),
                  expectedEligibilityDigest: "3".repeat(64),
                  expectedWorkspaceDigest: "4".repeat(64),
                  privateContent: "not projected",
                },
              },
            },
          ],
        },
      }),
      3,
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]?.request).toMatchObject({
      requestId: "req_local_appspec",
      kind: "approval",
      title: "Approve AppSpec",
      allowFreeform: false,
    });
    expect(projected[0]?.request?.description).toContain(
      "autograph-local-approval-subject-v1",
    );
    expect(JSON.stringify(projected)).not.toContain("not projected");
    expect(
      deriveInstalledEveStatus([
        installedEvent({
          type: "input.requested",
          data: {
            requests: [
              {
                requestId: "req_local_appspec",
                kind: "tool-approval",
                prompt: "Raw provider prompt",
                action: {
                  kind: "tool-call",
                  toolName: "accept_app_spec",
                  input: {
                    appId: "billing-console",
                    expectedArtifactDigest: "1".repeat(64),
                    expectedArtifactRevision: "2".repeat(64),
                    expectedSourceSha: "a".repeat(40),
                    expectedSourceTree: "b".repeat(40),
                    expectedEligibilityDigest: "3".repeat(64),
                    expectedWorkspaceDigest: "4".repeat(64),
                  },
                },
              },
            ],
          },
        }),
      ]),
    ).toBe("input_required");
  });

  it("fails closed without exposing a malformed receipt or raw arguments", () => {
    const requested = installedEvent({
      type: "input.requested",
      data: {
        requests: [
          {
            requestId: "req_appspec",
            kind: "tool-approval",
            prompt: "Raw prompt",
            action: {
              kind: "tool-call",
              toolName: "accept_app_spec",
              input: {
                approvalReceipt: { format: "unsupported" },
                token: "secret",
                path: "/private/workspace",
              },
            },
          },
        ],
      },
    });
    const projected = projectInstalledEveEvent(requested, 4);
    expect(projected).toEqual([
      {
        type: "error.public",
        index: 4,
        code: "approval_receipt_invalid",
        message:
          "A required approval receipt was missing or invalid; the request was not exposed.",
      },
      { type: "status", index: 4, status: "failed" },
    ]);
    expect(projectInstalledEveEvents([requested])).toEqual([
      {
        type: "error",
        index: 0,
        code: "approval_receipt_invalid",
        message:
          "A required approval receipt was missing or invalid; the request was not exposed.",
      },
      { type: "status", index: 1, status: "failed" },
    ]);
    expect(deriveInstalledEveStatus([requested])).toBe("failed");
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("/private/workspace");
  });

  it("fails closed for the whole batch when one receipt-bound sibling is malformed", () => {
    const receipt = {
      format: "autograph-eve-approval-receipt-v2",
      phase: "appspec",
      outcome: "accept-appspec",
      repositoryId: "1234",
      repository: "withAutograph/arrusted-development",
      baseRef: "refs/heads/main",
      baseSha: "a".repeat(40),
      subjectDigest: "b".repeat(64),
    };
    const projected = projectInstalledEveEvent(
      installedEvent({
        type: "input.requested",
        data: {
          requests: [
            {
              requestId: "req_appspec",
              kind: "tool-approval",
              prompt: "Raw prompt",
              action: {
                kind: "tool-call",
                toolName: "accept_app_spec",
                input: {
                  approvalReceipt: { format: "unsupported" },
                  token: "secret",
                  path: "/private/workspace",
                },
              },
            },
            {
              requestId: "req_valid",
              kind: "tool-approval",
              prompt: "Raw prompt",
              action: {
                kind: "tool-call",
                toolName: "accept_app_spec",
                input: { approvalReceipt: receipt },
              },
            },
          ],
        },
      }),
      4,
    );
    expect(projected).toEqual([
      {
        type: "error.public",
        index: 4,
        code: "approval_receipt_invalid",
        message:
          "A required approval receipt was missing or invalid; the request was not exposed.",
      },
      { type: "status", index: 4, status: "failed" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("/private/workspace");
  });

  it("rejects a valid receipt for the wrong approval tool phase", () => {
    const wrongPhaseReceipt = {
      format: "autograph-eve-approval-receipt-v2",
      phase: "change_set",
      outcome: "accept-change-set",
      repositoryId: "1234",
      repository: "withAutograph/arrusted-development",
      baseRef: "refs/heads/main",
      baseSha: "a".repeat(40),
      subjectDigest: "b".repeat(64),
    };
    const event = installedEvent({
      type: "input.requested",
      data: {
        requests: [
          {
            requestId: "req_wrong_phase",
            kind: "tool-approval",
            prompt: "Raw prompt",
            action: {
              kind: "tool-call",
              toolName: "accept_app_spec",
              input: { approvalReceipt: wrongPhaseReceipt },
            },
          },
        ],
      },
    });
    expect(projectInstalledEveEvent(event, 8)).toMatchObject([
      { type: "error.public", code: "approval_receipt_invalid" },
      { type: "status", status: "failed" },
    ]);
    expect(deriveInstalledEveStatus([event])).toBe("failed");
  });

  it("projects only allowlisted message and input fields", () => {
    expect(
      projectInstalledEveEvent(
        installedEvent({
          type: "message.completed",
          data: { message: "Done.", turnId: "turn_1" },
        }),
        2,
      ),
    ).toEqual([
      {
        type: "assistant.message",
        index: 2,
        turnId: "turn_1",
        text: "Done.",
      },
    ]);
    expect(
      projectInstalledEveEvent(
        installedEvent({
          type: "input.requested",
          data: {
            requests: [
              {
                requestId: "req_1",
                kind: "tool-approval",
                prompt: "Apply change?",
              },
            ],
          },
        }),
        3,
      ),
    ).toEqual([
      {
        type: "input.requested",
        index: 3,
        request: {
          requestId: "req_1",
          kind: "approval",
          title: "Apply change?",
          allowFreeform: false,
        },
      },
    ]);
    expect(
      projectInstalledEveEvent(
        installedEvent({
          type: "action.result",
          data: { output: "private" },
        }),
        4,
      ),
    ).toEqual([]);
  });

  it("keeps a multi-request batch input-required until every id resolves", () => {
    const requested = installedEvent({
      type: "input.requested",
      data: {
        requests: ["one", "two", "three"].map((requestId) => ({
          requestId,
          kind: "tool-approval",
          prompt: requestId,
        })),
      },
    });
    expect(deriveInstalledEveStatus([requested])).toBe("input_required");
    for (const count of [1, 2]) {
      expect(
        deriveInstalledEveStatus([
          requested,
          installedEvent({
            type: "input.resolved",
            data: {
              resolutions: ["one", "two", "three"]
                .slice(0, count)
                .map((requestId) => ({ requestId })),
            },
          }),
          installedEvent({ type: "session.waiting", data: {} }),
        ]),
      ).toBe("input_required");
    }
    expect(
      deriveInstalledEveStatus([
        requested,
        installedEvent({
          type: "input.resolved",
          data: {
            resolutions: ["one", "two", "three"].map((requestId) => ({
              requestId,
            })),
          },
        }),
        installedEvent({ type: "session.waiting", data: {} }),
      ]),
    ).toBe("waiting");
  });

  it("assigns dense unique public indices to sibling requests and errors", () => {
    const projected = projectInstalledEveEvents([
      installedEvent({
        type: "input.requested",
        data: {
          requests: ["one", "two", "three"].map((requestId) => ({
            requestId,
            kind: "tool-approval",
            prompt: requestId,
          })),
        },
      }),
      installedEvent({
        type: "session.failed",
        data: { code: "failed", message: "Stopped" },
      }),
    ]);
    expect(projected.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4]);
    expect(projected.map(({ type }) => type)).toEqual([
      "input_required",
      "input_required",
      "input_required",
      "error",
      "status",
    ]);
  });
});
