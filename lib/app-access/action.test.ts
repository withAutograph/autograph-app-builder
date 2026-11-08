import { describe, expect, it, vi } from "vitest";
import { createAppAccessAction } from "./action";
import type { AppAccessSnapshot } from "./contracts";

const snapshot: AppAccessSnapshot = {
  appId: "app-one",
  appName: "App one",
  canManage: true,
  creator: { status: "ready" },
  invitations: [],
  members: [],
  organizationName: "Team",
  roles: [],
  sessionId: "saved-session",
};
const input = {
  command: {
    action: "invite" as const,
    clientRequestId: "ed9928f1-bf1f-4d96-8280-d58c471d12ba",
    email: "guest@example.com",
    roles: [],
  },
  sessionId: snapshot.sessionId,
};
const incoming = () =>
  new Headers({ cookie: "session=owner-cookie", origin: "https://builder.example" });

describe("app access Server Action boundary", () => {
  it("passes the authenticated request to the existing owner-resolving service and retains request identity", async () => {
    const requests: Request[] = [];
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const handle = vi.fn((request: Request) => {
      requests.push(request);
      return Promise.resolve(Response.json(snapshot));
    });
    const action = createAppAccessAction({ handle, origin: "https://builder.example" });
    expect(await action(input, incoming())).toEqual({ snapshot, status: "ready" });
    expect(await action(input, incoming())).toEqual({ snapshot, status: "ready" });
    expect(handle).toHaveBeenCalledWith(expect.any(Request), snapshot.sessionId);
    expect(requests[0]?.headers.get("cookie")).toBe("session=owner-cookie");
    expect(await requests[0]?.json()).toEqual(input.command);
    expect(await requests[1]?.json()).toEqual(input.command);
  });

  it("rejects injected authority and foreign origins before dispatch", async () => {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const handle = vi.fn(() => Promise.resolve(Response.json(snapshot)));
    const action = createAppAccessAction({ handle, origin: "https://builder.example" });
    const forged = { ...input, ownerUserId: "other-owner" };
    expect(await action(forged, incoming())).toMatchObject({ status: "error", uncertain: false });
    expect(await action(input, new Headers({ origin: "https://other.example" }))).toMatchObject({
      status: "error",
      uncertain: false,
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("returns safe uncertainty without retrying an unacknowledged write", async () => {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const handle = vi.fn(() => Promise.reject(new Error("secret provider detail")));
    const action = createAppAccessAction({ handle, origin: "https://builder.example" });
    const result = await action(input, incoming());
    expect(result).toMatchObject({ code: "app_access_unknown", status: "error", uncertain: true });
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
    const action = createAppAccessAction({ handle, origin: "https://builder.example" });
    expect(await action(input, incoming())).toMatchObject({ status: "error", uncertain: false });
    expect(await action(input, incoming())).toMatchObject({ status: "error", uncertain: true });
  });

  it("does not present a different saved session as successful", async () => {
    const action = createAppAccessAction({
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      handle: () => Promise.resolve(Response.json({ ...snapshot, sessionId: "other-session" })),
      origin: "https://builder.example",
    });
    expect(await action(input, incoming())).toMatchObject({ status: "error", uncertain: true });
  });
});
