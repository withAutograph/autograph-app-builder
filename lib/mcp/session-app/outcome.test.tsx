import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionAppView } from "./view";
import type { EveSessionResult } from "../contracts";

const render = (result: EveSessionResult) =>
  renderToStaticMarkup(
    createElement(SessionAppView, {
      result,
      canCallTools: true,
      canOpenLinks: true,
      onOpenLink: async () => {},
      onRespond: async () => {},
    }),
  );
const session: EveSessionResult = {
  cursor: 0,
  events: [],
  sessionId: "example",
  status: "working",
};

describe("session outcomes", () => {
  it("does not report a response received when the session is simply working or cancelled", () => {
    expect(render(session)).toContain("Working on your app");
    expect(render(session)).not.toContain("Response received");
    const cancelled = render({ ...session, status: "cancelled" });
    expect(cancelled).toContain("This request was cancelled");
    expect(cancelled).not.toContain("Response received");
  });
  it("keeps failure details available without displaying them in the primary message", () => {
    const html = render({
      ...session,
      status: "failed",
      error: {
        code: "repository_access_missing",
        message: "Access unavailable",
        diagnostic: "Detailed provider response",
      },
    });
    expect(html).toContain("GitHub didn’t grant access");
    expect(html).toContain("<details>");
    expect(html).toContain("Detailed provider response");
    expect(html).not.toContain("<details open");
  });
});

it("leaves questions to chat when the host cannot submit answers, while retaining connection actions", () => {
  const question = {
    requestId: "q",
    title: "Who will use it?",
    kind: "question" as const,
    allowFreeform: true,
  };
  const authorization = {
    requestId: "a",
    title: "Connect GitHub",
    kind: "authorization" as const,
    allowFreeform: false,
    authorization: { displayName: "GitHub", url: "https://example.test/connect" },
  };
  const renderUnavailable = (
    requests: (typeof question)[] | (typeof question | typeof authorization)[],
  ) =>
    renderToStaticMarkup(
      createElement(SessionAppView, {
        result: { ...session, status: "input_required", inputRequests: requests },
        canCallTools: false,
        canOpenLinks: true,
        onOpenLink: async () => {},
        onRespond: async () => {},
      }),
    );
  expect(renderUnavailable([question])).toBe("");
  const mixed = renderUnavailable([question, authorization]);
  expect(mixed).toContain("GitHub");
  expect(mixed).toContain(">Continue</button>");
  expect(mixed).not.toContain("textarea");
  expect(mixed).not.toContain("Who will use it?");
});
