import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import {
  deriveInstalledEveStatus,
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

  it("derives waiting and outstanding-input status from installed events", () => {
    expect(
      deriveInstalledEveStatus([
        installedEvent({ type: "input.requested", data: { requests: [] } }),
      ]),
    ).toBe("input_required");
    expect(
      deriveInstalledEveStatus([
        installedEvent({ type: "session.waiting", data: {} }),
      ]),
    ).toBe("waiting");
  });
});
