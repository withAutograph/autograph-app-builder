import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import {
  deriveInstalledEveStatus,
  projectInstalledEveEvents,
  projectInstalledEveEvent,
  toPublicEvent,
} from "./public-events";

const installedEvent = (event: unknown) => event as MessageStreamEvent;

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
