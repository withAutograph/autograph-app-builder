import { createHash } from "node:crypto";

import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";

import {
  deriveInstalledEveStatus,
  latestInstalledImplementationPlan,
  latestInstalledPrototype,
  latestInstalledUiPreview,
  projectInstalledEveEvents,
  projectInstalledEveEvent,
  toPublicEvent,
} from "./public-events";

const installedEvent = (event: unknown) => event as MessageStreamEvent;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
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
    JSON.stringify({ digest: artifactDigest, mediaType, path })
  );
  return [
    installedEvent({
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
      type: "actions.requested",
    }),
    installedEvent({
      data: {
        result: {
          callId,
          kind: "tool-result",
          output: {
            appId: "vendor-onboarding",
            digest: input?.outputDigest ?? artifactDigest,
            mediaType,
            path,
            recordedByCallId: callId,
            reused: false,
            revision,
            sessionId: "wrun_1",
            size: Buffer.byteLength(content),
            ...(input?.invalidated === undefined
              ? {}
              : { invalidated: input.invalidated }),
          },
          toolName: input?.resultToolName ?? "record_prototype_artifact",
        },
        status: input?.resultStatus ?? "completed",
      },
      type: "action.result",
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
  existingAppChanges?: { path: string; content: string }[];
}): MessageStreamEvent[] {
  const callId = input?.callId ?? "call_plan";
  const plannedByCallId = input?.plannedByCallId ?? callId;
  const expectedAppSpecDigest = input?.expectedAppSpecDigest ?? "a".repeat(64);
  const outputAppSpecDigest =
    input?.outputAppSpecDigest ?? expectedAppSpecDigest;
  const targetBase = {
    blockers: input?.blockers ?? [],
    contract: {
      appId: "vendor-onboarding",
      appSpec: {
        path: "prototype/vendor-onboarding/app-spec.md",
        sha256: outputAppSpecDigest,
      },
      version: 1 as const,
    },
    futurePath: "apps/vendor-onboarding/app.contract.json",
    mutations: [] as [],
    plan: {
      product: {
        appSpec: {
          path: "prototype/vendor-onboarding/app-spec.md",
          sha256: outputAppSpecDigest,
        },
        optionalCapabilities: { hostedResources: [], integrations: [] },
        owner: "operations",
      },
      source: {
        packageName: "@autograph/vendor-onboarding",
        runtime: "nextjs" as const,
        schema: { kind: "none" as const },
        workspacePath: "apps/vendor-onboarding",
      },
      topology: {
        configPath: "microfrontends.json" as const,
        packageName: "@autograph/vendor-onboarding",
        projectName: "apps-vendor-onboarding",
        routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
      },
    },
  };
  const iterationChanges = input?.existingAppChanges?.map(
    ({ path, content }) => ({
      after: { content, digest: digest(content), mode: "644" },
      before: { digest: digest(`before:${path}`), mode: "644" },
      path,
    })
  );
  const target = iterationChanges
    ? {
        ...targetBase,
        iteration: {
          changes: iterationChanges,
          digest: digest(JSON.stringify(iterationChanges)),
        },
        operation: "iterate-existing-app" as const,
      }
    : targetBase;
  const unsigned = {
    appSpecDigest: outputAppSpecDigest,
    artifactRevision: "7".repeat(64),
    contractDigest: digest(JSON.stringify(target.contract)),
    dependencyCacheDigest: `sha256:${"6".repeat(64)}`,
    eligibilityDigest: "3".repeat(64),
    identityDigest: "8".repeat(64),
    imageDigest:
      input?.imageDigest ?? `vercel-sandbox-seed@sha256:${"5".repeat(64)}`,
    plannedByCallId,
    sourceReceiptDigest: "0".repeat(64),
    sourceSha: "1".repeat(40),
    sourceTree: "2".repeat(40),
    target,
    version: 1 as const,
    workspaceDigest: "4".repeat(64),
  };
  return [
    installedEvent({
      data: {
        actions: [
          {
            kind: "tool-call",
            callId,
            toolName: "plan_app_creation",
            input: {
              expectedAppSpecDigest,
              ...(input?.existingAppChanges === undefined
                ? {}
                : { existingAppChanges: input.existingAppChanges }),
            },
          },
        ],
      },
      type: "actions.requested",
    }),
    installedEvent({
      data: {
        result: {
          callId,
          kind: "tool-result",
          output: {
            ...unsigned,
            digest: input?.outputDigest ?? digest(JSON.stringify(unsigned)),
            reused: input?.reused ?? false,
          },
          toolName: input?.resultToolName ?? "plan_app_creation",
        },
        status: input?.resultStatus ?? "completed",
      },
      type: "action.result",
    }),
  ];
}

describe("toPublicEvent", () => {
  it("publishes an allowlisted assistant message", () => {
    expect(
      toPublicEvent({
        index: 4,
        text: "Done.",
        turnId: "turn_1",
        type: "assistant.message",
      })
    ).toEqual({
      index: 4,
      text: "Done.",
      turnId: "turn_1",
      type: "assistant_message",
    });
  });

  it.each(["reasoning.delta", "tool.result", "system.instructions"])(
    "drops %s",
    (type) => {
      expect(
        toPublicEvent({ index: 1, message: "secret", text: "secret", type })
      ).toBeNull();
    }
  );
});

describe("installed Eve 0.43 projection", () => {
  it("keeps source and workspace bindings out of the public plan", () => {
    const plan = latestInstalledImplementationPlan(recordedPlanEvents());
    expect(plan).toBeDefined();
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("sourceSha");
    expect(serialized).not.toContain("sourceTree");
    expect(serialized).not.toContain("proposalDigest");
    expect(serialized).not.toContain("workspacePath");
  });

  it("projects only a receipt-bound read-only target implementation plan", () => {
    expect(latestInstalledImplementationPlan(recordedPlanEvents())).toEqual({
      appId: "vendor-onboarding",
      packageName: "@autograph/vendor-onboarding",
      projectName: "apps-vendor-onboarding",
      readOnly: true,
      routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
      runtime: "nextjs",
    });
  });

  it("projects an exact digest-bound idempotent planning retry", () => {
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({
          callId: "call_plan_retry",
          plannedByCallId: "call_plan_original",
          reused: true,
        })
      )
    ).toMatchObject({
      appId: "vendor-onboarding",
      readOnly: true,
    });
  });

  it("projects an existing-app plan without dropping its typed replacements", () => {
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({
          existingAppChanges: [
            {
              content: "export default function Page() { return 'Ready'; }\n",
              path: "apps/vendor-onboarding/app/page.tsx",
            },
          ],
        })
      )
    ).toMatchObject({
      appId: "vendor-onboarding",
      readOnly: true,
    });
  });

  it("rejects an existing-app plan that is not bound to the requested replacements", () => {
    const events = recordedPlanEvents({
      existingAppChanges: [
        {
          content: "export default function Page() { return 'Ready'; }\n",
          path: "apps/vendor-onboarding/app/page.tsx",
        },
      ],
    });
    const request = events.find((event) => event.type === "actions.requested");
    if (
      request?.type !== "actions.requested" ||
      request.data.actions[0]?.kind !== "tool-call" ||
      typeof request.data.actions[0].input !== "object" ||
      request.data.actions[0].input === null
    ) {
      throw new Error("expected a plan request fixture");
    }
    const input = request.data.actions[0].input as {
      existingAppChanges: { content: string }[];
    };
    input.existingAppChanges[0]!.content = "different\n";

    expect(latestInstalledImplementationPlan(events)).toBeUndefined();
  });

  it("rejects a fresh plan bound to another call", () => {
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ plannedByCallId: "call_plan_other" })
      )
    ).toBeUndefined();
  });

  it("rejects unbound, failed, stale, blocked, fixture, and invalidated plans", () => {
    const valid = recordedPlanEvents();
    expect(latestInstalledImplementationPlan([valid[1]!])).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ resultStatus: "failed" })
      )
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ resultToolName: "another_tool" })
      )
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ outputAppSpecDigest: "b".repeat(64) })
      )
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ outputDigest: "c".repeat(64) })
      )
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({ blockers: ["missing product owner"] })
      )
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan(
        recordedPlanEvents({
          imageDigest: `fixture@sha256:${"d".repeat(64)}`,
        })
      )
    ).toBeUndefined();
    expect(
      latestInstalledImplementationPlan([
        ...valid,
        ...recordedPrototypeEvents({
          callId: "call_revised_artifact",
          content: "<!doctype html><html><body>Revised</body></html>",
          invalidated: true,
        }),
      ])
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
      content: expected.data.actions[0].input.content,
      mediaType: "text/html",
      path: "prototype/vendor-onboarding/index.html",
    });
    expect(
      latestInstalledPrototype([
        ...first,
        ...recordedPrototypeEvents({
          callId: "call_failed",
          content: "<html>failed replacement</html>",
          resultStatus: "failed",
        }),
      ])
    ).toEqual(latestInstalledPrototype(first));
  });

  it("rejects unmatched, failed, wrong-tool, and digest-mismatched prototypes", () => {
    const valid = recordedPrototypeEvents();
    expect(latestInstalledPrototype([valid[1]!])).toBeUndefined();
    expect(
      latestInstalledPrototype(
        recordedPrototypeEvents({ resultStatus: "rejected" })
      )
    ).toBeUndefined();
    expect(
      latestInstalledPrototype(
        recordedPrototypeEvents({ resultToolName: "another_tool" })
      )
    ).toBeUndefined();
    expect(
      latestInstalledPrototype(
        recordedPrototypeEvents({ outputDigest: "f".repeat(64) })
      )
    ).toBeUndefined();

    const malformedRequest = structuredClone(valid);
    const requested = malformedRequest[0] as MessageStreamEvent & {
      data: { actions: [{ input: { path: string } }] };
    };
    requested.data.actions[0].input.path =
      "prototype/vendor-onboarding/app-spec.md";
    expect(latestInstalledPrototype(malformedRequest)).toBeUndefined();
  });

  it("projects a receipt-bound component-backed UI preview and its Browser transport", () => {
    const content =
      "<!doctype html><html><body>Component preview</body></html>";
    const revision = "a".repeat(64);
    const events = [
      installedEvent({
        data: {
          result: {
            callId: "ui-preview",
            kind: "tool-result",
            output: {
              appId: "vendor-onboarding",
              content,
              digest: digest(content),
              fidelity: "arrusted-component-catalog",
              functionality: "fixtures-only",
              revision,
              routes: ["/", "/vendors"],
            },
            toolName: "record_ui_preview",
          },
          status: "completed",
        },
        type: "action.result",
      }),
    ];
    expect(latestInstalledUiPreview(events)).toMatchObject({
      revision,
      routes: ["/", "/vendors"],
    });
    expect(latestInstalledPrototype(events)).toMatchObject({
      content,
      digest: digest(content),
    });
  });

  it("fails closed if internal specification recording requests approval", () => {
    const receipt = {
      baseRef: "refs/heads/main",
      baseSha: "a".repeat(40),
      format: "autograph-eve-approval-receipt-v2",
      outcome: "accept-appspec",
      phase: "appspec",
      repository: "withAutograph/arrusted-development",
      repositoryId: "1234",
      subjectDigest: "b".repeat(64),
    };
    expect(
      projectInstalledEveEvent(
        installedEvent({
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
          type: "input.requested",
        }),
        3
      )
    ).toEqual([
      {
        code: "confirmation_unavailable",
        index: 3,
        message: "I couldn't verify this action, so it was not run.",
        type: "error.public",
      },
      { index: 3, status: "failed", type: "status" },
    ]);
  });

  it("does not expose an internal local specification approval", () => {
    const projected = projectInstalledEveEvent(
      installedEvent({
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
        type: "input.requested",
      }),
      3
    );
    expect(projected).toEqual([
      {
        code: "confirmation_unavailable",
        index: 3,
        message: "I couldn't verify this action, so it was not run.",
        type: "error.public",
      },
      { index: 3, status: "failed", type: "status" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("not projected");
    expect(
      deriveInstalledEveStatus([
        installedEvent({
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
          type: "input.requested",
        }),
      ])
    ).toBe("failed");
  });

  it.each(["validate_app_creation", "accept_change_set"])(
    "does not expose an unexpected internal %s approval",
    (toolName) => {
      const projected = projectInstalledEveEvent(
        installedEvent({
          data: {
            requests: [
              {
                requestId: `req_${toolName}`,
                kind: "tool-approval",
                prompt: "Raw internal prompt with private mechanics",
                action: {
                  kind: "tool-call",
                  toolName,
                  input: { privateValue: "not projected" },
                },
              },
            ],
          },
          type: "input.requested",
        }),
        4
      );
      expect(projected).toEqual([
        {
          code: "confirmation_unavailable",
          index: 4,
          message: "I couldn't verify this action, so it was not run.",
          type: "error.public",
        },
        { index: 4, status: "failed", type: "status" },
      ]);
      expect(JSON.stringify(projected)).not.toContain("private mechanics");
      expect(JSON.stringify(projected)).not.toContain("not projected");
    }
  );

  it("presents sandbox build approval in product language", () => {
    const projected = projectInstalledEveEvent(
      installedEvent({
        data: {
          requests: [
            {
              requestId: "req_build",
              kind: "tool-approval",
              prompt: "Approve internal apply_app_creation call",
              action: {
                kind: "tool-call",
                toolName: "apply_app_creation",
                input: {
                  productSummary:
                    "Build the stock exception queue, detail panel, and resolution workflow shown in the preview.",
                },
              },
            },
          ],
        },
        type: "input.requested",
      }),
      4
    );

    expect(projected).toEqual([
      {
        index: 4,
        request: {
          allowFreeform: false,
          description:
            "Build the stock exception queue, detail panel, and resolution workflow shown in the preview.",
          kind: "approval",
          requestId: "req_build",
          title: "Build this app?",
        },
        type: "input.requested",
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("apply_app_creation");
  });

  it("fails closed without exposing a malformed receipt or raw arguments", () => {
    const requested = installedEvent({
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
      type: "input.requested",
    });
    const projected = projectInstalledEveEvent(requested, 4);
    expect(projected).toEqual([
      {
        code: "confirmation_unavailable",
        index: 4,
        message: "I couldn't verify this action, so it was not run.",
        type: "error.public",
      },
      { index: 4, status: "failed", type: "status" },
    ]);
    expect(projectInstalledEveEvents([requested])).toEqual([
      {
        code: "confirmation_unavailable",
        index: 0,
        message: "I couldn't verify this action, so it was not run.",
        type: "error",
      },
      { index: 1, status: "failed", type: "status" },
    ]);
    expect(deriveInstalledEveStatus([requested])).toBe("failed");
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("/private/workspace");
  });

  it("fails closed for the whole batch when one receipt-bound sibling is malformed", () => {
    const receipt = {
      baseRef: "refs/heads/main",
      baseSha: "a".repeat(40),
      format: "autograph-eve-approval-receipt-v2",
      outcome: "accept-appspec",
      phase: "appspec",
      repository: "withAutograph/arrusted-development",
      repositoryId: "1234",
      subjectDigest: "b".repeat(64),
    };
    const projected = projectInstalledEveEvent(
      installedEvent({
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
        type: "input.requested",
      }),
      4
    );
    expect(projected).toEqual([
      {
        code: "confirmation_unavailable",
        index: 4,
        message: "I couldn't verify this action, so it was not run.",
        type: "error.public",
      },
      { index: 4, status: "failed", type: "status" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("/private/workspace");
  });

  it("rejects a valid receipt for the wrong approval tool phase", () => {
    const wrongPhaseReceipt = {
      baseRef: "refs/heads/main",
      baseSha: "a".repeat(40),
      format: "autograph-eve-approval-receipt-v2",
      outcome: "accept-change-set",
      phase: "change_set",
      repository: "withAutograph/arrusted-development",
      repositoryId: "1234",
      subjectDigest: "b".repeat(64),
    };
    const event = installedEvent({
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
      type: "input.requested",
    });
    expect(projectInstalledEveEvent(event, 8)).toMatchObject([
      { code: "confirmation_unavailable", type: "error.public" },
      { status: "failed", type: "status" },
    ]);
    expect(deriveInstalledEveStatus([event])).toBe("failed");
  });

  it("projects only allowlisted message and input fields", () => {
    expect(
      projectInstalledEveEvent(
        installedEvent({
          data: { message: "Done.", turnId: "turn_1" },
          type: "message.completed",
        }),
        2
      )
    ).toEqual([
      {
        index: 2,
        text: "Done.",
        turnId: "turn_1",
        type: "assistant.message",
      },
    ]);
    expect(
      projectInstalledEveEvent(
        installedEvent({
          data: {
            requests: [
              {
                requestId: "req_1",
                kind: "tool-approval",
                prompt: "Apply change?",
              },
            ],
          },
          type: "input.requested",
        }),
        3
      )
    ).toEqual([
      {
        index: 3,
        request: {
          allowFreeform: false,
          kind: "approval",
          requestId: "req_1",
          title: "Apply change?",
        },
        type: "input.requested",
      },
    ]);
    expect(
      projectInstalledEveEvent(
        installedEvent({
          data: { output: "private" },
          type: "action.result",
        }),
        4
      )
    ).toEqual([]);
  });

  it("projects a GitHub repository authorization as a Store In request", () => {
    expect(
      projectInstalledEveEvent(
        installedEvent({
          data: {
            attemptId: "attempt_1",
            authorization: {
              displayName: "GitHub",
              repositoryAccess: {
                action: "update",
                provider: "github",
                repository: {
                  fullName: "withAutograph/app-builder-dogfood",
                  name: "app-builder-dogfood",
                  owner: "withAutograph",
                },
                scopes: [
                  {
                    installationId: "123",
                    accountLogin: "withAutograph",
                    accountType: "Organization",
                  },
                ],
              },
              url: "https://builder.example.test/github/installations?continuation=opaque",
            },
            description: "Internal connection description.",
            name: "github-repository-access",
            turnId: "turn_1",
          },
          type: "authorization.required",
        }),
        5
      )
    ).toEqual([
      {
        index: 5,
        request: {
          allowFreeform: false,
          authorization: {
            displayName: "GitHub",
            repositoryAccess: {
              action: "update",
              provider: "github",
              repository: {
                fullName: "withAutograph/app-builder-dogfood",
                name: "app-builder-dogfood",
                owner: "withAutograph",
              },
              scopes: [
                {
                  installationId: "123",
                  accountLogin: "withAutograph",
                  accountType: "Organization",
                },
              ],
            },
            url: "https://builder.example.test/github/installations?continuation=opaque",
          },
          description:
            "Update GitHub access to include withAutograph/app-builder-dogfood.",
          kind: "authorization",
          presentation: { control: "provider", section: "store-in" },
          requestId: "attempt_1",
          title: "Update GitHub access",
        },
        type: "input.requested",
      },
    ]);
  });

  it("keeps a multi-request batch input-required until every id resolves", () => {
    const requested = installedEvent({
      data: {
        requests: ["one", "two", "three"].map((requestId) => ({
          requestId,
          kind: "tool-approval",
          prompt: requestId,
        })),
      },
      type: "input.requested",
    });
    expect(deriveInstalledEveStatus([requested])).toBe("input_required");
    for (const count of [1, 2]) {
      expect(
        deriveInstalledEveStatus([
          requested,
          installedEvent({
            data: {
              resolutions: ["one", "two", "three"]
                .slice(0, count)
                .map((requestId) => ({ requestId })),
            },
            type: "input.resolved",
          }),
          installedEvent({ data: {}, type: "session.waiting" }),
        ])
      ).toBe("input_required");
    }
    expect(
      deriveInstalledEveStatus([
        requested,
        installedEvent({
          data: {
            resolutions: ["one", "two", "three"].map((requestId) => ({
              requestId,
            })),
          },
          type: "input.resolved",
        }),
        installedEvent({ data: {}, type: "session.waiting" }),
      ])
    ).toBe("waiting");
  });

  it("assigns dense unique public indices to sibling requests and errors", () => {
    const projected = projectInstalledEveEvents([
      installedEvent({
        data: {
          requests: ["one", "two", "three"].map((requestId) => ({
            requestId,
            kind: "tool-approval",
            prompt: requestId,
          })),
        },
        type: "input.requested",
      }),
      installedEvent({
        data: { code: "failed", message: "Stopped" },
        type: "session.failed",
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
    expect(JSON.stringify(projected)).not.toContain("Stopped");
  });

  it("keeps source and planning diagnostics out of public failures", () => {
    const projected = projectInstalledEveEvents([
      installedEvent({
        data: {
          code: "source_workspace_invalid",
          message:
            "The GitHub source workspace could not be verified after dependency cache validation of the AppSpec receipt digest.",
        },
        type: "session.failed",
      }),
    ]);
    expect(projected).toEqual([
      {
        code: "unable_to_continue",
        index: 0,
        message:
          "I couldn't finish preparing your app. Your progress is saved, so you can try again.",
        type: "error",
      },
      { index: 1, status: "failed", type: "status" },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(
      /AppSpec|cache|dependency|digest|receipt|source workspace|validation/iu
    );
  });
});
