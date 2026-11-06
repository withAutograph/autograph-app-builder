import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EveSessionResult, PublicEveEvent } from "../contracts";
import { projectInstalledEveEvent, toPublicEvent } from "../../eve/public-events";
import type { MessageStreamEvent } from "eve/client";
import { reduceIdentityInvitations } from "./identity-invitation";
import { SessionAppView } from "./view";

const invitation = {
  callId: "call",
  expiresAt: "2099-01-01T00:00:00Z",
  url: "https://auth.example.com/link?nonce=ordinary",
};
const result = (
  events: PublicEveEvent[],
  sessionId = "session",
  status: EveSessionResult["status"] = "working",
): EveSessionResult => ({
  cursor: events.at(-1)?.index ?? 0,
  events,
  sessionId,
  status,
});
const pending = (
  index: number,
  url = invitation.url,
): Extract<PublicEveEvent, { type: "auth_identity_invitation" }> => ({
  ...invitation,
  index,
  type: "auth_identity_invitation",
  url,
});

describe("pending identity invitation delta state", () => {
  it("accepts all public siblings projected from a single native partial", () => {
    const native: MessageStreamEvent = {
      data: {
        result: {
          callId: invitation.callId,
          kind: "tool-result",
          output: {
            authIdentityLink: invitation.url,
            authIdentityLinkExpiresAt: invitation.expiresAt,
          },
          toolName: "prepare-app-hosted-runtime",
        },
        sequence: 3,
        stepIndex: 1,
        turnId: "turn",
      },
      meta: { at: "2026-10-15T14:00:00Z", id: "identity-invitation-event" },
      type: "action.partial",
    };
    const events = projectInstalledEveEvent(native, 7).flatMap((event) => {
      const projected = toPublicEvent(event);
      return projected ? [projected] : [];
    });
    expect(events.map(({ type }) => type)).toEqual([
      "assistant_message",
      "auth_identity_invitation",
    ]);
    const reduced = reduceIdentityInvitations(undefined, result(events));
    expect(reduced.invitations).toEqual([invitation]);
    expect(reduceIdentityInvitations(reduced, result(events))).toEqual(reduced);
  });

  it("retains an invitation on empty gets and replaces the same call with its newer link", () => {
    const initial = reduceIdentityInvitations(undefined, result([pending(1)]));
    const empty = reduceIdentityInvitations(initial, result([]));
    expect(empty.invitations).toEqual([invitation]);
    const updated = reduceIdentityInvitations(
      empty,
      result([pending(2, "https://auth.example.com/new")]),
    );
    expect(updated.invitations).toMatchObject([{ url: "https://auth.example.com/new" }]);
    expect(reduceIdentityInvitations(updated, result([pending(1)])).invitations).toEqual(
      updated.invitations,
    );
  });
  it("does not resurrect a resolved call from replay and preserves another pending call", () => {
    const initial = reduceIdentityInvitations(
      undefined,
      result([pending(1), { ...pending(2), callId: "other" }]),
    );
    const resolved = reduceIdentityInvitations(
      initial,
      result([{ callId: "call", index: 3, type: "auth_identity_invitation_resolved" }]),
    );
    expect(resolved.invitations.map(({ callId }) => callId)).toEqual(["other"]);
    expect(reduceIdentityInvitations(resolved, result([pending(1)])).invitations).toEqual(
      resolved.invitations,
    );
  });
  it("clears invitations for a different session and terminal status", () => {
    const initial = reduceIdentityInvitations(undefined, result([pending(1)]));
    expect(reduceIdentityInvitations(initial, result([], "other-session")).invitations).toEqual([]);
    expect(
      reduceIdentityInvitations(initial, result([], "session", "completed")).invitations,
    ).toEqual([]);
  });
});

describe("passive sign-in invitation", () => {
  const render = (expiresAt: string) =>
    renderToStaticMarkup(
      createElement(SessionAppView, {
        canCallTools: true,
        canOpenLinks: true,
        identityInvitations: [{ ...invitation, expiresAt }],
        onOpenLink: async () => {},
        onRespond: async () => {},
        result: result([]),
      }),
    );
  it("renders an ordinary sign-in hyperlink while working without an answer control", () => {
    const html = render(invitation.expiresAt);
    expect(html).toContain(invitation.url);
    expect(html).toContain("Sign in or create your app account");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Continue");
    expect(html).not.toContain("Response received");
  });
  it("does not render an expired link", () => {
    const html = render("2000-01-01T00:00:00Z");
    expect(html).not.toContain(invitation.url);
    expect(html).toContain("sign-in link has expired");
    expect(html).not.toContain("Response received");
  });
  it("keeps renewal inside Builder for an expired identity invitation", () => {
    const html = renderToStaticMarkup(
      createElement(SessionAppView, {
        result: {
          ...result([]),
          appAccessUrl: "https://builder.example.com/builds/session/access",
        },
        identityInvitations: [{ ...invitation, expiresAt: "2000-01-01T00:00:00Z" }],
        canCallTools: true,
        canOpenLinks: true,
        onOpenLink: async () => {},
        onRespond: async () => {},
      }),
    );
    expect(html).toContain("https://builder.example.com/builds/session/access");
    expect(html).toContain("Get a new sign-in link in Builder");
    expect(html).not.toContain(invitation.url);
  });
});
