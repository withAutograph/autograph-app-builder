// @vitest-environment jsdom
import { AuthProvider } from "@better-auth-ui/react";
import { QueryClient } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SignIn } from "./sign-in";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  sessionStorage.clear();
});

const setup = (response: Response) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const authClient = createAuthClient({
    baseURL: "http://localhost:3000/api/auth",
    fetchOptions: { customFetchImpl: fetch },
  });
  const navigate = vi.fn<(options: { to: string; replace?: boolean }) => void>();
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AuthProvider
        authClient={authClient}
        navigate={navigate}
        queryClient={queryClient}
        Link={({ href, children }) => <a href={href}>{children}</a>}
        emailAndPassword={{ enabled: true, rememberMe: true }}
      >
        <SignIn />
      </AuthProvider>,
    );
  });
  return { view: container, fetch, navigate };
};

it("shows required errors and submits the selected email", async () => {
  const { view, fetch } = setup(
    Response.json({ user: { id: "user-1" }, session: { token: "fixture" } }),
  );
  const email = view.querySelector<HTMLInputElement>("#email");
  const password = view.querySelector<HTMLInputElement>("#password");
  const form = view.querySelector("form");
  if (email === null || password === null || form === null) {
    throw new Error("Expected sign-in fields");
  }
  act(() => {
    email.dispatchEvent(new Event("invalid", { bubbles: false, cancelable: true }));
    password.dispatchEvent(new Event("invalid", { bubbles: false, cancelable: true }));
  });
  expect(email.getAttribute("aria-invalid")).toBe("true");
  expect(password.getAttribute("aria-invalid")).toBe("true");
  email.value = "person@example.com";
  const passwordValue = crypto.randomUUID();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      password,
      passwordValue,
    );
    password.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
  });
  const call = fetch.mock.calls.find(([input]) => new Request(input).url.includes("sign-in/email"));
  const body = z.string().parse(call?.[1]?.body);
  expect(JSON.parse(body)).toMatchObject({
    email: "person@example.com",
    password: passwordValue,
  });
});

it("routes unverified email to verification", async () => {
  const { view, navigate } = setup(
    Response.json({ code: "EMAIL_NOT_VERIFIED", message: "Verify email" }, { status: 403 }),
  );
  const email = view.querySelector<HTMLInputElement>("#email");
  const form = view.querySelector("form");
  if (email === null || form === null) {
    throw new Error("Expected sign-in fields");
  }
  email.value = "person@example.com";
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
  });
  expect(sessionStorage.getItem("better-auth-ui.verify-email")).toBe("person@example.com");
  expect(navigate).toHaveBeenCalledWith({ to: "/auth/verify-email" });
});
