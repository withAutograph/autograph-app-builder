import { describe, expect, it } from "vitest";

import { toEveInputResponse } from "./service";

describe("Eve input response mapping", () => {
  it("maps the public denial to Eve's cancel approval option", () => {
    expect(toEveInputResponse("request-1", { kind: "deny" })).toEqual({
      requestId: "request-1",
      optionId: "cancel",
    });
  });

  it("preserves approval and question answer shapes", () => {
    expect(toEveInputResponse("request-2", { kind: "approve" })).toEqual({
      requestId: "request-2",
      optionId: "approve",
    });
    expect(
      toEveInputResponse("request-3", {
        kind: "answer",
        value: "Freeform",
      }),
    ).toEqual({ requestId: "request-3", text: "Freeform" });
    expect(
      toEveInputResponse("request-4", {
        kind: "answer",
        value: "ignored label",
        optionId: "choice-1",
      }),
    ).toEqual({ requestId: "request-4", optionId: "choice-1" });
  });
});
