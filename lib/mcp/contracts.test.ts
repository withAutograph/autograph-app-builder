import { describe, expect, it } from "vitest";

import { eveRespondInputSchema } from "./contracts";

const response = (requestId: string) => ({
  requestId,
  response: { kind: "approve" as const },
});

describe("eveRespondInputSchema", () => {
  it("accepts only one non-empty unique response batch", () => {
    expect(
      eveRespondInputSchema
        .parse({
          sessionId: "session_1",
          clientRequestId: "client_1",
          responses: [response("one"), response("two"), response("three")],
        })
        .responses.map(({ requestId }) => requestId),
    ).toEqual(["one", "two", "three"]);
    expect(() =>
      eveRespondInputSchema.parse({
        sessionId: "session_1",
        clientRequestId: "client_1",
        requestId: "legacy",
        response: { kind: "approve" },
      }),
    ).toThrow();
    expect(() =>
      eveRespondInputSchema.parse({
        sessionId: "session_1",
        clientRequestId: "client_1",
        responses: [],
      }),
    ).toThrow();
    expect(() =>
      eveRespondInputSchema.parse({
        sessionId: "session_1",
        clientRequestId: "client_1",
        responses: [response("same"), response("same")],
      }),
    ).toThrow();
  });
});
