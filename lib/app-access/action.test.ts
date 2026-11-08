import { describe, expect, it, vi } from "vitest";
import { createAppAccessAction } from "./action";
import type { AppAccessSnapshot } from "./contracts";

const snapshot: AppAccessSnapshot = {
  sessionId: "saved-session",
  appId: "app-one",
  appName: "App one",
  organizationName: "Team",
  canManage: true,
  roles: [],
  members: [],
  invitations: [],
  creator: { status: "ready" },
};
const input = {
  sessionId: snapshot.sessionId,
  command: {
    action: "invite" as const,
    clientRequestId: "ed9928f1-bf1f-4d96-8280-d58c471d12ba",
    email: "guest@example.com",
    roles: [],
  },
};
const incoming = () =>
  new Headers({ origin: "https://builder.example", cookie: "session=owner-cookie" });

describe("app access Server Action boundary", () => {
  it("passes the authenticated request to the existing owner-resolving service and retains request identity", async () => {
    const requests: Request[] = [];
    const handle = vi.fn((request: Request) => {
      requests.push(request);
      return Promise.resolve(Response.json(snapshot));
    });
    const action = createAppAccessAction({ origin: "https://builder.example", handle });
    expect(await action(input, incoming())).toEqual({ snapshot, status: "ready" });
    expect(await action(input, incoming())).toEqual({ snapshot, status: "ready" });
    expect(handle).toHaveBeenCalledWith(expect.any(Request), snapshot.sessionId);
    expect(requests[0]?.headers.get("cookie")).toBe("session=owner-cookie");
    expect(await requests[0]?.json()).toEqual(input.command);
    expect(await requests[1]?.json()).toEqual(input.command);
  });

  it("rejects injected authority and foreign origins before dispatch", async () => {
    const handle = vi.fn(() => Promise.resolve(Response.json(snapshot)));
    const action = createAppAccessAction({ origin: "https://builder.example", handle });
    const forged = { ...input, ownerUserId: "other-owner" };
    expect(await action(forged, incoming())).toMatchObject({ status: "error", uncertain: false });
    expect(await action(input, new Headers({ origin: "https://other.example" }))).toMatchObject({
      status: "error",
      uncertain: false,
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("returns safe uncertainty without retrying an unacknowledged write", async () => {
    const handle = vi.fn(() => Promise.reject(new Error("secret provider detail")));
    const action = createAppAccessAction({ origin: "https://builder.example", handle });
    const result = await action(input, incoming());
    expect(result).toMatchObject({ status: "error", code: "app_access_unknown", uncertain: true });
    expect(JSON.stringify(result)).not.toContain("secret provider detail");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("preserves denied and unresolved outcomes distinctly", async () => {
    const handle = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: "app_access_denied", message: "Access denied." }, { status: 403 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { code: "app_access_unknown", message: "Checking the previous request." },
          { status: 409 },
        ),
      );
    const action = createAppAccessAction({ origin: "https://builder.example", handle });
    expect(await action(input, incoming())).toMatchObject({ status: "error", uncertain: false });
    expect(await action(input, incoming())).toMatchObject({ status: "error", uncertain: true });
  });

  it("does not present a different saved session as successful", async () => {
    const action = createAppAccessAction({
      origin: "https://builder.example",
      handle: () => Promise.resolve(Response.json({ ...snapshot, sessionId: "other-session" })),
    });
    expect(await action(input, incoming())).toMatchObject({ status: "error", uncertain: true });
  });
});
