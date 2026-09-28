import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import {
  deriveInstalledEveStatus,
  latestInstalledPrototype,
  latestInstalledUiPreview,
  projectInstalledEveEvents,
  projectInstalledEveEvent,
  toPublicEvent,
} from "./public-events";
import {
  prototypeArtifactReadChunk,
  recordPrototypeArtifactChunk,
  recordPrototypeArtifactRevision,
} from "../agent/prototype-artifacts";

const installedEvent = (event: unknown) => event as MessageStreamEvent;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function digest(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
    input?.content ?? "<!doctype html><html><body><button>Review vendor</button></body></html>";
  const path = "prototype/vendor-onboarding/index.html";
  const mediaType = "text/html";
  const artifactDigest = digest(content);
  const revision = digest(JSON.stringify({ digest: artifactDigest, mediaType, path }));
  return [
    installedEvent({
      data: {
        actions: [
          {
            callId,
            input: { content, mediaType, path },
            kind: "tool-call",
            toolName: "record_prototype_artifact",
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
            ...(input?.invalidated === undefined ? {} : { invalidated: input.invalidated }),
          },
          toolName: input?.resultToolName ?? "record_prototype_artifact",
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
      }),
    ).toEqual({
      index: 4,
      text: "Done.",
      turnId: "turn_1",
      type: "assistant_message",
    });
  });

  it.each(["reasoning.delta", "tool.result", "system.instructions"])("drops %s", (type) => {
    expect(toPublicEvent({ index: 1, message: "secret", text: "secret", type })).toBeNull();
  });
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
      ]),
    ).toEqual(latestInstalledPrototype(first));
  });

  it("reconstructs chunked prototype writes only after exact revision and digest verification", () => {
    const contents = ["first 🧾\n", "second part\n", "finished"];
    const fullContent = contents.join("");
    const expectedDigest = digest(fullContent);
    const path = "prototype/vendor-onboarding/index.html";
    let artifacts: Parameters<typeof recordPrototypeArtifactChunk>[0]["artifacts"] = [];
    let baseRevision: string | undefined;
    const events: MessageStreamEvent[] = [];
    for (const [chunkIndex, content] of contents.entries()) {
      const callId = `chunk-${chunkIndex}`;
      const input = {
        baseRevision,
        chunkIndex,
        content,
        expectedDigest,
        finalChunk: chunkIndex === contents.length - 1,
        mediaType: "text/html" as const,
        path,
      };
      const recorded = recordPrototypeArtifactChunk({
        ...input,
        artifacts,
        callId,
        sessionId: "wrun_1",
      });
      const { artifacts: nextArtifacts, artifact } = recorded;
      artifacts = nextArtifacts;
      baseRevision = artifact.revision;
      events.push(
        installedEvent({
          data: {
            actions: [{ callId, input, kind: "tool-call", toolName: "record_prototype_artifact" }],
          },
          type: "actions.requested",
        }),
        installedEvent({
          data: {
            result: {
              callId,
              kind: "tool-result",
              output: {
                appId: recorded.artifact.appId,
                complete: recorded.complete,
                digest: recorded.artifact.digest,
                mediaType: recorded.artifact.mediaType,
                nextChunkIndex: recorded.nextChunkIndex,
                path: recorded.artifact.path,
                recordedByCallId: recorded.artifact.recordedByCallId,
                reused: recorded.reused,
                revision: recorded.artifact.revision,
                sessionId: recorded.artifact.sessionId,
                size:
                  recorded.artifact.transfer?.receivedBytes ??
                  Buffer.byteLength(recorded.artifact.content),
              },
              toolName: "record_prototype_artifact",
            },
            status: "completed",
          },
          type: "action.result",
        }),
      );
    }
    expect(latestInstalledPrototype(events)).toMatchObject({
      content: fullContent,
      digest: expectedDigest,
      path,
    });

    const tampered = structuredClone(events);
    const last = tampered.at(-1) as MessageStreamEvent & {
      data: { result: { output: { digest: string } } };
    };
    last.data.result.output.digest = "0".repeat(64);
    expect(latestInstalledPrototype(tampered)).toBeUndefined();
  });

  it("reconstructs chunked artifact readback over multiple Eve result envelopes", () => {
    const { artifact } = recordPrototypeArtifactRevision({
      artifacts: [],
      callId: "record-large-preview",
      content: `<html>${"x".repeat(10 * 1024 * 1024)}</html>`,
      mediaType: "text/html",
      path: "prototype/vendor-onboarding/index.html",
      sessionId: "wrun_1",
    });
    const events: MessageStreamEvent[] = [];
    events.push(
      installedEvent({
        data: {
          result: {
            callId: "preview-large",
            kind: "tool-result",
            output: {
              appId: "vendor-onboarding",
              artifactDigest: artifact.digest,
              artifactRevision: artifact.revision,
              digest: artifact.digest,
              fidelity: "arrusted-component-catalog",
              functionality: "fixtures-only",
              requiresChunkedRead: true,
              revision: "a".repeat(64),
              routes: ["/"],
              totalBytes: Buffer.byteLength(artifact.content),
            },
            toolName: "record_ui_preview",
          },
          status: "completed",
        },
        type: "action.result",
      }),
    );
    let offsetBytes = 0;
    let index = 0;
    while (offsetBytes < Buffer.byteLength(artifact.content)) {
      const callId = `read-${index}`;
      const input = {
        digest: artifact.digest,
        offsetBytes,
        path: artifact.path,
        revision: artifact.revision,
      };
      const output = prototypeArtifactReadChunk(artifact, { offsetBytes });
      events.push(
        installedEvent({
          data: {
            actions: [{ callId, input, kind: "tool-call", toolName: "get_prototype_artifact" }],
          },
          type: "actions.requested",
        }),
        installedEvent({
          data: {
            result: {
              callId,
              kind: "tool-result",
              output,
              toolName: "get_prototype_artifact",
            },
            status: "completed",
          },
          type: "action.result",
        }),
      );
      offsetBytes = output.nextOffsetBytes;
      index += 1;
    }
    expect(index).toBeGreaterThan(1);
    expect(latestInstalledPrototype(events)).toMatchObject({
      content: artifact.content,
      digest: artifact.digest,
      path: artifact.path,
      revision: artifact.revision,
    });
    expect(latestInstalledUiPreview(events)).toMatchObject({
      appId: "vendor-onboarding",
      revision: "a".repeat(64),
    });
  });

  it("rejects unmatched, failed, wrong-tool, and digest-mismatched prototypes", () => {
    const valid = recordedPrototypeEvents();
    const [, result] = valid;
    if (!result) {
      throw new Error("expected a prototype result fixture");
    }
    expect(latestInstalledPrototype([result])).toBeUndefined();
    expect(
      latestInstalledPrototype(recordedPrototypeEvents({ resultStatus: "rejected" })),
    ).toBeUndefined();
    expect(
      latestInstalledPrototype(recordedPrototypeEvents({ resultToolName: "another_tool" })),
    ).toBeUndefined();
    expect(
      latestInstalledPrototype(recordedPrototypeEvents({ outputDigest: "f".repeat(64) })),
    ).toBeUndefined();

    const malformedRequest = structuredClone(valid);
    const requested = malformedRequest[0] as MessageStreamEvent & {
      data: { actions: [{ input: { path: string } }] };
    };
    requested.data.actions[0].input.path = "prototype/vendor-onboarding/app-spec.md";
    expect(latestInstalledPrototype(malformedRequest)).toBeUndefined();
  });

  it("projects a receipt-bound component-backed UI preview and its Browser transport", () => {
    const content = "<!doctype html><html><body>Component preview</body></html>";
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
                action: {
                  input: {
                    approvalReceipt: receipt,
                    content: "private AppSpec",
                    path: "/private/workspace",
                  },
                  kind: "tool-call",
                  toolName: "accept_app_spec",
                },
                kind: "tool-approval",
                prompt: "Raw provider prompt",
                requestId: "req_appspec",
              },
            ],
          },
          type: "input.requested",
        }),
        3,
      ),
    ).toEqual([
      {
        code: "confirmation_unavailable",
        index: 3,
        message:
          "Builder could not read the requested confirmation, so no action was run. Refresh this saved session and retry the confirmation; if it repeats, report the session ID and request title.",
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
              action: {
                input: {
                  appId: "billing-console",
                  expectedArtifactDigest: "1".repeat(64),
                  expectedArtifactRevision: "2".repeat(64),
                  expectedEligibilityDigest: "3".repeat(64),
                  expectedSourceSha: "a".repeat(40),
                  expectedSourceTree: "b".repeat(40),
                  expectedWorkspaceDigest: "4".repeat(64),
                  privateContent: "not projected",
                },
                kind: "tool-call",
                toolName: "accept_app_spec",
              },
              kind: "tool-approval",
              prompt: "Raw provider prompt",
              requestId: "req_local_appspec",
            },
          ],
        },
        type: "input.requested",
      }),
      3,
    );
    expect(projected).toEqual([
      {
        code: "confirmation_unavailable",
        index: 3,
        message:
          "Builder could not read the requested confirmation, so no action was run. Refresh this saved session and retry the confirmation; if it repeats, report the session ID and request title.",
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
                action: {
                  input: {
                    appId: "billing-console",
                    expectedArtifactDigest: "1".repeat(64),
                    expectedArtifactRevision: "2".repeat(64),
                    expectedEligibilityDigest: "3".repeat(64),
                    expectedSourceSha: "a".repeat(40),
                    expectedSourceTree: "b".repeat(40),
                    expectedWorkspaceDigest: "4".repeat(64),
                  },
                  kind: "tool-call",
                  toolName: "accept_app_spec",
                },
                kind: "tool-approval",
                prompt: "Raw provider prompt",
                requestId: "req_local_appspec",
              },
            ],
          },
          type: "input.requested",
        }),
      ]),
    ).toBe("failed");
  });

  it.each(["validate-app-creation", "accept_change_set"])(
    "does not expose an unexpected internal %s approval",
    (toolName) => {
      const projected = projectInstalledEveEvent(
        installedEvent({
          data: {
            requests: [
              {
                action: {
                  input: { privateValue: "not projected" },
                  kind: "tool-call",
                  toolName,
                },
                kind: "tool-approval",
                prompt: "Raw internal prompt with private mechanics",
                requestId: `req_${toolName}`,
              },
            ],
          },
          type: "input.requested",
        }),
        4,
      );
      expect(projected).toEqual([
        {
          code: "confirmation_unavailable",
          index: 4,
          message:
            "Builder could not read the requested confirmation, so no action was run. Refresh this saved session and retry the confirmation; if it repeats, report the session ID and request title.",
          type: "error.public",
        },
        { index: 4, status: "failed", type: "status" },
      ]);
      expect(JSON.stringify(projected)).not.toContain("private mechanics");
      expect(JSON.stringify(projected)).not.toContain("not projected");
    },
  );

  it("presents sandbox build approval in product language", () => {
    const projected = projectInstalledEveEvent(
      installedEvent({
        data: {
          requests: [
            {
              action: {
                input: {
                  productSummary:
                    "Build the stock exception queue, detail panel, and resolution workflow shown in the preview.",
                },
                kind: "tool-call",
                toolName: "apply_app_creation",
              },
              kind: "tool-approval",
              prompt: "Approve internal apply_app_creation call",
              requestId: "req_build",
            },
          ],
        },
        type: "input.requested",
      }),
      4,
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
            action: {
              input: {
                approvalReceipt: { format: "unsupported" },
                path: "/private/workspace",
                token: "secret",
              },
              kind: "tool-call",
              toolName: "accept_app_spec",
            },
            kind: "tool-approval",
            prompt: "Raw prompt",
            requestId: "req_appspec",
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
        message:
          "Builder could not read the requested confirmation, so no action was run. Refresh this saved session and retry the confirmation; if it repeats, report the session ID and request title.",
        type: "error.public",
      },
      { index: 4, status: "failed", type: "status" },
    ]);
    expect(projectInstalledEveEvents([requested])).toEqual([
      {
        code: "confirmation_unavailable",
        index: 0,
        message:
          "Builder could not read the requested confirmation, so no action was run. Refresh this saved session and retry the confirmation; if it repeats, report the session ID and request title.",
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
              action: {
                input: {
                  approvalReceipt: { format: "unsupported" },
                  path: "/private/workspace",
                  token: "secret",
                },
                kind: "tool-call",
                toolName: "accept_app_spec",
              },
              kind: "tool-approval",
              prompt: "Raw prompt",
              requestId: "req_appspec",
            },
            {
              action: {
                input: { approvalReceipt: receipt },
                kind: "tool-call",
                toolName: "accept_app_spec",
              },
              kind: "tool-approval",
              prompt: "Raw prompt",
              requestId: "req_valid",
            },
          ],
        },
        type: "input.requested",
      }),
      4,
    );
    expect(projected).toEqual([
      {
        code: "confirmation_unavailable",
        index: 4,
        message:
          "Builder could not read the requested confirmation, so no action was run. Refresh this saved session and retry the confirmation; if it repeats, report the session ID and request title.",
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
      outcome: "accept_change_set",
      phase: "change_set",
      repository: "withAutograph/arrusted-development",
      repositoryId: "1234",
      subjectDigest: "b".repeat(64),
    };
    const event = installedEvent({
      data: {
        requests: [
          {
            action: {
              input: { approvalReceipt: wrongPhaseReceipt },
              kind: "tool-call",
              toolName: "accept_app_spec",
            },
            kind: "tool-approval",
            prompt: "Raw prompt",
            requestId: "req_wrong_phase",
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
        2,
      ),
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
                kind: "tool-approval",
                prompt: "Apply change?",
                requestId: "req_1",
              },
            ],
          },
          type: "input.requested",
        }),
        3,
      ),
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
        4,
      ),
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
                    accountLogin: "withAutograph",
                    accountType: "Organization",
                    installationId: "123",
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
        5,
      ),
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
                  accountLogin: "withAutograph",
                  accountType: "Organization",
                  installationId: "123",
                },
              ],
            },
            url: "https://builder.example.test/github/installations?continuation=opaque",
          },
          description: "Update GitHub access to include withAutograph/app-builder-dogfood.",
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
          kind: "tool-approval",
          prompt: requestId,
          requestId,
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
        ]),
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
      ]),
    ).toBe("waiting");
  });

  it("assigns dense unique public indices to sibling requests and errors", () => {
    const projected = projectInstalledEveEvents([
      installedEvent({
        data: {
          requests: ["one", "two", "three"].map((requestId) => ({
            kind: "tool-approval",
            prompt: requestId,
            requestId,
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
    expect(projected[3]).toMatchObject({ code: "failed" });
    expect(projected[3]?.type === "error" ? projected[3].message : "").toContain("Cause: Stopped");
  });

  it("explains a source failure with its safe cause", () => {
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
        code: "source_workspace_invalid",
        index: 0,
        message:
          "Builder could not complete the current Builder operation (source_workspace_invalid). Cause: The GitHub source workspace could not be verified after dependency cache validation of the AppSpec receipt digest. Your progress is saved; correct the cause and resume this session.",
        type: "error",
      },
      { index: 1, status: "failed", type: "status" },
    ]);
  });

  it("identifies missing provider diagnostics instead of telling the user to fix an unknown cause", () => {
    const projected = projectInstalledEveEvents([
      installedEvent({
        data: { code: "execution_error", message: "" },
        type: "session.failed",
      }),
    ]);
    const message = projected[0]?.type === "error" ? projected[0].message : "";
    expect(message).toContain("provider returned no diagnostic cause");
    expect(message).toContain("operation, error code, and session ID");
    expect(message).not.toContain("correct the cause");
  });

  it("names the failed operation and Eve event envelope without exposing URLs or tokens", () => {
    const projected = projectInstalledEveEvents([
      installedEvent({
        data: {
          actions: [
            {
              callId: "call_review",
              input: { includeContent: true, token: "private" },
              kind: "tool-call",
              toolName: "change_set_status",
            },
          ],
        },
        type: "actions.requested",
      }),
      installedEvent({
        data: {
          code: "FatalError",
          message:
            "Stream write failed: HTTP 400 (PUT https://provider.example/secret?token=private): Chunk size 89847765 exceeds maximum allowed size of 10485760 bytes",
        },
        type: "session.failed",
      }),
    ]);
    expect(projected[0]).toEqual({
      code: "result_too_large",
      index: 0,
      message:
        "Builder could not complete `change_set_status`: the serialized Eve event was 89847765 bytes, above Eve's 10485760-byte event envelope. For prototype or UI-preview content, retry with smaller UTF-8-safe chunks using the chunked read/write path, then resume this saved session.",
      type: "error",
    });
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(JSON.stringify(projected)).not.toContain("provider.example");
  });

  it("redacts credentials in an otherwise useful provider cause", () => {
    const projected = projectInstalledEveEvents([
      installedEvent({
        data: {
          code: "ProviderError",
          message:
            "GitHub operation failed: token=github_pat_123456789 and https://private.example/a",
        },
        type: "session.failed",
      }),
    ]);
    expect(projected[0]).toMatchObject({ code: "ProviderError" });
    expect(projected[0]?.type === "error" ? projected[0].message : "").toContain(
      "GitHub operation failed",
    );
    expect(JSON.stringify(projected)).not.toContain("github_pat_123456789");
    expect(JSON.stringify(projected)).not.toContain("private.example");
  });

  it("keeps the source location and repair from a multiline compiler failure", () => {
    const projected = projectInstalledEveEvents([
      installedEvent({
        data: {
          code: "schema_compilation_failed",
          message:
            "Schema compilation failed for review-app (exit 1).\nschema-compiler: apps/review-app/schema/review-app.cue:12:4: conflicting values\nRetry: correct the named CUE field and rerun schema:release. token=private",
        },
        type: "session.failed",
      }),
    ]);
    const message = projected[0]?.type === "error" ? projected[0].message : "";
    expect(message).toContain("apps/review-app/schema/review-app.cue:12:4");
    expect(message).toContain("correct the named CUE field");
    expect(message).not.toContain("token=private");
  });
});
