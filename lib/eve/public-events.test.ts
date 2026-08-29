import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import {
  deriveInstalledEveStatus,
  latestInstalledImplementationPlan,
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
  invalidated?: boolean;
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
            ...(input?.invalidated === undefined
              ? {}
              : { invalidated: input.invalidated }),
          },
        },
      },
    }),
  ];
}

function recordedPlanEvents(input?: {
  callId?: string;
  expectedAppSpecDigest?: string;
  outputAppSpecDigest?: string;
  outputDigest?: string;
  resultStatus?: "completed" | "failed" | "rejected";
  resultToolName?: string;
  imageDigest?: string;
  blockers?: string[];
  plannedByCallId?: string;
  reused?: boolean;
}): MessageStreamEvent[] {
  const callId = input?.callId ?? "call_plan";
  const plannedByCallId = input?.plannedByCallId ?? callId;
  const expectedAppSpecDigest = input?.expectedAppSpecDigest ?? "a".repeat(64);
  const outputAppSpecDigest =
    input?.outputAppSpecDigest ?? expectedAppSpecDigest;
  const target = {
    contract: {
      version: 1 as const,
      appId: "vendor-onboarding",
      appSpec: {
        path: "prototype/vendor-onboarding/app-spec.md",
        sha256: outputAppSpecDigest,
      },
    },
    futurePath: "apps/vendor-onboarding/app.contract.json",
    plan: {
      source: {
        workspacePath: "apps/vendor-onboarding",
        runtime: "nextjs" as const,
        packageName: "@autograph/vendor-onboarding",
        schema: { kind: "none" as const },
      },
      product: {
        owner: "operations",
        appSpec: {
          path: "prototype/vendor-onboarding/app-spec.md",
          sha256: outputAppSpecDigest,
        },
        optionalCapabilities: { integrations: [], hostedResources: [] },
      },
      topology: {
        configPath: "microfrontends.json" as const,
        projectName: "apps-vendor-onboarding",
        packageName: "@autograph/vendor-onboarding",
        routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
      },
    },
    blockers: input?.blockers ?? [],
    mutations: [] as [],
  };
  const unsigned = {
    version: 1 as const,
    sourceSha: "1".repeat(40),
    sourceTree: "2".repeat(40),
    eligibilityDigest: "3".repeat(64),
    workspaceDigest: "4".repeat(64),
    imageDigest:
      input?.imageDigest ?? `vercel-sandbox-seed@sha256:${"5".repeat(64)}`,
    dependencyCacheDigest: `sha256:${"6".repeat(64)}`,
    appSpecDigest: outputAppSpecDigest,
    artifactRevision: "7".repeat(64),
    identityDigest: "8".repeat(64),
    contractDigest: digest(JSON.stringify(target.contract)),
    target,
    plannedByCallId,
  };
  return [
    installedEvent({
      type: "actions.requested",
      data: {
        actions: [
          {
            kind: "tool-call",
            callId,
            toolName: "plan_app_creation",
            input: { expectedAppSpecDigest },
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
          toolName: input?.resultToolName ?? "plan_app_creation",
          output: {
            ...unsigned,
            digest: input?.outputDigest ?? digest(JSON.stringify(unsigned)),
            reused: input?.reused ?? false,
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
  it("projects only a receipt-bound read-only target implementation plan", () => {
    expect(latestInstalledImplementationPlan(recordedPlanEvents())).toEqual({
      appId: "vendor-onboarding",
      runtime: "nextjs",
      workspacePath: "apps/vendor-onboarding",
      packageName: "@autograph/vendor-onboarding",
      projectName: "apps-vendor-onboarding",
      routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
      sourceSha: "1".repeat(40),
      sourceTree: "2".repeat(40),
      proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      readOnly: true,
    });
  });

  it("projects an exact digest-bound idempotent planning retry", () => {
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({
          callId: "call_plan_retry",
          plannedByCallId: "call_plan_original",
          reused: true,
        }),
      ),
    ).toMatchObject({
      appId: "vendor-onboarding",
      proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      readOnly: true,
    });
  });

  it("rejects a fresh plan bound to another call", () => {
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ plannedByCallId: "call_plan_other" }),
      ),
    ).toBeUndefined();
  });

  it("rejects unbound, failed, stale, blocked, fixture, and invalidated plans", () => {
    const valid = recordedPlanEvents();
    expect(latestInstalledImplementationPlan([valid[1]!])).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ resultStatus: "failed" }),
      ),
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ resultToolName: "another_tool" }),
      ),
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ outputAppSpecDigest: "b".repeat(64) }),
      ),
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ outputDigest: "c".repeat(64) }),
      ),
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ blockers: ["missing product owner"] }),
      ),
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({
          imageDigest: `fixture@sha256:${"d".repeat(64)}`,
        }),
      ),
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan([
        ...valid,
        ...recordedPrototypeEvents({
          callId: "call_revised_artifact",
          content: "<!doctype html><html><body>Revised</body></html>",
          invalidated: true,
        }),
      ]),
    ).toBeUndefined();
  });

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

  it("fails closed if internal specification recording requests approval", () => {
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
        type: "error.public",
        index: 3,
        code: "confirmation_unavailable",
        message: "I couldn't verify this action, so it was not run.",
      },
      { type: "status", index: 3, status: "failed" },
    ]);
  });

  it("does not expose an internal local specification approval", () => {
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
    expect(projected).toEqual([
      {
        type: "error.public",
        index: 3,
        code: "confirmation_unavailable",
        message: "I couldn't verify this action, so it was not run.",
      },
      { type: "status", index: 3, status: "failed" },
    ]);
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
    ).toBe("failed");
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
        code: "confirmation_unavailable",
        message: "I couldn't verify this action, so it was not run.",
      },
      { type: "status", index: 4, status: "failed" },
    ]);
    expect(projectInstalledEveEvents([requested])).toEqual([
      {
        type: "error",
        index: 0,
        code: "confirmation_unavailable",
        message: "I couldn't verify this action, so it was not run.",
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
        code: "confirmation_unavailable",
        message: "I couldn't verify this action, so it was not run.",
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
      { type: "error.public", code: "confirmation_unavailable" },
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
