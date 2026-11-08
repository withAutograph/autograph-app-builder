// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appAccessCommandSchema } from "@/lib/app-access/contracts";
import type { AppAccessSnapshot } from "@/lib/app-access/contracts";
import type { AppAccessActionInput, AppAccessActionState } from "@/lib/app-access/action";
import { AppAccessPage, AppAccessView } from "./app-access";

const continuation =
  vi.fn<
    (
      previous: AppAccessActionState | undefined,
      input: AppAccessActionInput,
    ) => Promise<AppAccessActionState>
  >();

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const snapshot: AppAccessSnapshot = {
  appId: "request-log",
  appName: "Request log",
  appUrl: "https://apps.example.com/request-log",
  canManage: true,
  creator: { status: "ready" },
  invitations: [
    {
      email: "guest@example.com",
      expiresAt: "2099-01-01T00:00:00Z",
      id: "invite-one",
      roles: ["reader"],
      status: "pending",
    },
  ],
  members: [{ email: "creator@example.com", id: "creator", name: "Creator", roles: ["editor"] }],
  organizationName: "Team",
  roles: [
    { id: "reader", label: "Reader" },
    { id: "editor", label: "Editor" },
  ],
  sessionId: "saved-app-session",
};
const missingInvitation: AppAccessSnapshot = {
  ...snapshot,
  creator: {
    status: "failed",
    email: "original@example.com",
    canChooseAccount: true,
    retryable: true,
    message: "Your app invitation is not ready yet. Retry setup to continue.",
  },
  invitations: [],
  members: [],
};
const roots: ReturnType<typeof createRoot>[] = [];
const render = async (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  return container;
};
const click = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};
const chooseCreatorEmail = async (container: HTMLElement, value: string) => {
  const form = container.querySelector<HTMLFormElement>(
    'form[aria-label="Choose your app account"]',
  );
  const email = form?.querySelector<HTMLInputElement>('input[type="email"]');
  if (!form || !email) {
    throw new Error("Expected the app account choice form");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(email, value);
    email.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
};
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
    await Promise.resolve();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  continuation.mockReset();
});

describe("Builder app access", () => {
  it("offers one ordinary app sign-in and account recovery without a completion checkbox", async () => {
    const onAction = vi.fn<() => void>();
    const container = await render(
      <AppAccessView
        data={{
          ...snapshot,
          canManage: false,
          creator: {
            expiresAt: "2099-01-01T00:00:00Z",
            recoveryUrl: "https://apps.example.com/auth/forgot-password",
            signInUrl: "https://apps.example.com/connect",
            status: "sign_in_required",
          },
        }}
        disabled={false}
        onAction={onAction}
      />,
    );
    expect(
      container.querySelector('a[href="https://apps.example.com/connect"]')?.textContent,
    ).toContain("Sign in or create account");
    expect(
      container.querySelector('a[href="https://apps.example.com/auth/forgot-password"]'),
    ).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows the saved creator account and submits an explicit email choice without granting access", async () => {
    const onAction = vi.fn<() => void>();
    const container = await render(
      <AppAccessView data={missingInvitation} disabled={false} onAction={onAction} />,
    );
    expect(container.textContent).toContain("original@example.com");
    expect(onAction).not.toHaveBeenCalled();
    await chooseCreatorEmail(container, "chosen@example.com");
    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      action: "choose-creator-account",
      email: "chosen@example.com",
    });
    expect(container.textContent).not.toContain("Your access is ready.");
  });

  it("retries a missing invitation inside Builder without offering its unusable sign-in link", async () => {
    const onAction = vi.fn<() => void>();
    const container = await render(
      <AppAccessView
        data={{
          ...missingInvitation,
          creator: {
            ...missingInvitation.creator,
            signInUrl: "https://apps.example.com/not-created",
          },
        }}
        disabled={false}
        onAction={onAction}
      />,
    );
    expect(container.querySelector('a[href="https://apps.example.com/not-created"]')).toBeNull();
    expect(container.textContent).toContain("original@example.com");
    await click(container, "Retry setup");
    expect(onAction).toHaveBeenCalledWith({ action: "retry-setup" });
  });

  it.each([
    { canManage: true, canChooseAccount: false },
    { canManage: false, canChooseAccount: true },
  ])(
    "keeps a locked creator email visible without offering unauthorized account changes (%j)",
    async ({ canManage, canChooseAccount }) => {
      const container = await render(
        <AppAccessView
          data={{
            ...snapshot,
            canManage,
            creator: {
              status: "sign_in_required",
              email: "chosen@example.com",
              canChooseAccount,
              signInUrl: "https://apps.example.com/connect",
              expiresAt: "2099-01-01T00:00:00Z",
            },
          }}
          disabled={false}
          onAction={vi.fn<() => void>()}
        />,
      );
      expect(container.textContent).toContain("chosen@example.com");
      expect(container.querySelector('form[aria-label="Choose your app account"]')).toBeNull();
      expect(container.querySelector('a[href="https://apps.example.com/connect"]')).not.toBeNull();
    },
  );

  it("prevents a creator account choice while another access update is pending", async () => {
    const onAction = vi.fn<() => void>();
    const container = await render(
      <AppAccessView data={missingInvitation} disabled={true} onAction={onAction} />,
    );
    const form = container.querySelector<HTMLFormElement>(
      'form[aria-label="Choose your app account"]',
    );
    expect(form?.querySelector<HTMLInputElement>('input[type="email"]')?.disabled).toBe(true);
    await chooseCreatorEmail(container, "chosen@example.com");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("reuses the same creator account choice after a lost reply and shows the confirmed address", async () => {
    const requests: object[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(missingInvitation))),
    );
    continuation.mockImplementation(async (_previous, input) => {
      requests.push(z.object({ command: appAccessCommandSchema }).parse(input).command);
      if (requests.length === 1) {
        throw new TypeError("Connection interrupted");
      }
      return {
        status: "ready",
        snapshot: {
          ...missingInvitation,
          creator: {
            status: "sign_in_required",
            email: "chosen@example.com",
            canChooseAccount: false,
            signInUrl: "https://apps.example.com/connect",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        },
      };
    });
    const container = await render(
      <AppAccessPage sessionId={snapshot.sessionId} continueAction={continuation} />,
    );
    await chooseCreatorEmail(container, "chosen@example.com");
    const form = container.querySelector<HTMLFormElement>(
      'form[aria-label="Choose your app account"]',
    );
    expect(form?.querySelector<HTMLInputElement>('input[type="email"]')?.disabled).toBe(true);
    await click(container, "Retry the same update");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({
      action: "choose-creator-account",
      email: "chosen@example.com",
    });
    expect(container.textContent).toContain("chosen@example.com");
    expect(container.querySelector('form[aria-label="Choose your app account"]')).toBeNull();
    expect(container.querySelector('a[href="https://apps.example.com/connect"]')).not.toBeNull();
  });

  it("renews an expired sign-in through Builder without opening the stale link", async () => {
    const onAction = vi.fn<() => void>();
    const container = await render(
      <AppAccessView
        data={{
          ...snapshot,
          creator: {
            expiresAt: "2000-01-01T00:00:00Z",
            signInUrl: "https://apps.example.com/stale",
            status: "sign_in_required",
          },
        }}
        disabled={false}
        onAction={onAction}
      />,
    );
    expect(container.querySelector('a[href="https://apps.example.com/stale"]')).toBeNull();
    await click(container, "Get a new sign-in link");
    expect(onAction).toHaveBeenCalledWith({ action: "renew-sign-in" });
  });

  it("manages invitation and member actions by their app-scoped identifiers", async () => {
    const onAction = vi.fn<() => void>();
    const container = await render(
      <AppAccessView data={snapshot} disabled={false} onAction={onAction} />,
    );
    await click(container, "Resend invitation");
    await click(container, "Cancel invitation");
    await click(container, "Remove app access");
    expect(onAction.mock.calls).toEqual([
      [{ action: "resend", invitationId: "invite-one" }],
      [{ action: "cancel", invitationId: "invite-one" }],
      [{ action: "remove", memberId: "creator" }],
    ]);
  });

  it("shows uncertain email delivery without automatically resending", async () => {
    const onAction = vi.fn<() => void>();
    const data = {
      ...snapshot,
      invitations: snapshot.invitations.map((invitation) => ({
        ...invitation,
        deliveryStatus: "unknown" as const,
      })),
    };
    const container = await render(
      <AppAccessView data={data} disabled={false} onAction={onAction} />,
    );
    expect(container.textContent).toContain("Delivery unconfirmed");
    expect(onAction).not.toHaveBeenCalled();
    await click(container, "Resend invitation");
    expect(onAction).toHaveBeenCalledWith({ action: "resend", invitationId: "invite-one" });
  });

  it("submits the entered email and selected app role without browser-supplied organization authority", async () => {
    const onAction = vi.fn<() => void>();
    const container = await render(
      <AppAccessView data={snapshot} disabled={false} onAction={onAction} />,
    );
    const email = container.querySelector<HTMLInputElement>('input[type="email"]');
    const role = container.querySelector<HTMLInputElement>('form input[type="checkbox"]');
    const form = container.querySelector("form");
    if (email === null || role === null || form === null) {
      throw new Error("Expected invitation form");
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        email,
        "new-person@example.com",
      );
      email.dispatchEvent(new Event("input", { bubbles: true }));
      role.click();
      await Promise.resolve();
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onAction).toHaveBeenCalledWith({
      action: "invite",
      email: "new-person@example.com",
      roles: ["reader"],
    });
  });

  it("recovers the original pending command after reopening the saved app", async () => {
    const pendingCommand = {
      action: "resend" as const,
      invitationId: "invite-one",
      clientRequestId: "8bd98bc3-969d-486e-9cc3-60a23424250c",
    };
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ ...snapshot, pendingCommand }))),
    );
    continuation.mockImplementation(async (_previous, input) => {
      await Promise.resolve();
      requests.push(z.object({ command: appAccessCommandSchema }).parse(input).command);
      return { snapshot, status: "ready" };
    });
    const container = await render(
      <AppAccessPage sessionId={snapshot.sessionId} continueAction={continuation} />,
    );
    expect(container.textContent).toContain("Checking the previous request");
    await click(container, "Retry the same update");
    expect(requests).toEqual([pendingCommand]);
  });

  it("keeps the exact operation on a lost invitation reply and disables competing mutations", async () => {
    const requests: object[] = [];
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(snapshot))),
    );
    continuation.mockImplementation(async (_previous, input) => {
      await Promise.resolve();
      requests.push(z.object({ command: appAccessCommandSchema }).parse(input).command);
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("Connection interrupted");
      }
      return { snapshot, status: "ready" };
    });
    const container = await render(
      <AppAccessPage sessionId={snapshot.sessionId} continueAction={continuation} />,
    );
    await click(container, "Resend invitation");
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel invitation",
    );
    expect(cancel?.disabled).toBe(true);
    await click(container, "Retry the same update");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({ action: "resend", invitationId: "invite-one" });
    expect(container.textContent).toContain("App access updated.");
    expect(cancel?.disabled).toBe(false);
  });

  it("continues listing people across pages without dropping the first page", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        await Promise.resolve();
        calls.push(url);
        return Response.json(
          url.includes("cursor=")
            ? {
                ...snapshot,
                members: [
                  { email: "guest@example.com", id: "guest", name: "Guest", roles: ["reader"] },
                ],
              }
            : { ...snapshot, nextCursor: "page-two" },
        );
      }),
    );
    const container = await render(
      <AppAccessPage sessionId={snapshot.sessionId} continueAction={continuation} />,
    );
    await click(container, "Show more people");
    expect(calls[1]).toContain("cursor=page-two");
    expect(container.textContent).toContain("Creator");
    expect(container.textContent).toContain("Guest");
    expect(container.textContent).not.toContain("Show more people");
  });

  it("disables duplicate controls while the Server Action is pending and renders its completed state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(snapshot))),
    );
    const completion = Promise.withResolvers<AppAccessActionState>();
    continuation.mockReturnValue(completion.promise);
    const container = await render(
      <AppAccessPage sessionId={snapshot.sessionId} continueAction={continuation} />,
    );
    await click(container, "Resend invitation");
    expect(container.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel invitation",
    );
    expect(cancel?.disabled).toBe(true);
    await act(async () => {
      completion.resolve({ snapshot, status: "ready" });
      await completion.promise;
    });
    expect(container.querySelector("main")?.getAttribute("aria-busy")).toBe("false");
    expect(container.textContent).toContain("App access updated.");
    expect(continuation).toHaveBeenCalledTimes(1);
  });

  it("does not prompt a linked creator to sign in again or require business roles for role-less apps", async () => {
    const container = await render(
      <AppAccessView
        data={{
          ...snapshot,
          members: [{ email: "creator@example.com", id: "creator", name: "Creator", roles: [] }],
          roles: [],
        }}
        disabled={false}
        onAction={vi.fn<() => void>()}
      />,
    );
    expect(container.textContent).toContain("Your access is ready.");
    expect(container.querySelector(`a[href="${snapshot.appUrl}"]`)).not.toBeNull();
    expect(container.textContent).not.toContain("Sign in or create account");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
});
