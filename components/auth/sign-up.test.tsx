// @vitest-environment jsdom
import { AuthProvider } from "@better-auth-ui/react";
import { QueryClient } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { z } from "zod";
import { SignUp } from "./sign-up";

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
  vi.restoreAllMocks();
});
const setup = (verify: boolean) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ user: { id: "user-1" }, session: { token: "fixture" } }));
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
        emailAndPassword={{
          enabled: true,
          name: false,
          confirmPassword: true,
          requireEmailVerification: verify,
        }}
      >
        <SignUp />
      </AuthProvider>,
    );
  });
  return { view: container, fetch, navigate };
};
const fill = (input: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
it("shows required feedback, rejects mismatched passwords and submits matching credentials", async () => {
  const { view, fetch } = setup(false);
  const email = view.querySelector<HTMLInputElement>("#email");
  const password = view.querySelector<HTMLInputElement>("#password");
  const confirm = view.querySelector<HTMLInputElement>("#confirmPassword");
  const form = view.querySelector("form");
  if (email === null || password === null || confirm === null || form === null) {
    throw new Error("Missing sign-up controls");
  }
  act(() => {
    email.dispatchEvent(new Event("invalid", { cancelable: true }));
    password.dispatchEvent(new Event("invalid", { cancelable: true }));
    confirm.dispatchEvent(new Event("invalid", { cancelable: true }));
  });
  expect(email.getAttribute("aria-invalid")).toBe("true");
  expect(password.getAttribute("aria-invalid")).toBe("true");
  expect(confirm.getAttribute("aria-invalid")).toBe("true");
  email.value = "person@example.com";
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const showError = vi.spyOn(toast, "error");
  fill(password, first);
  fill(confirm, second);
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(showError).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  fill(password, first);
  fill(confirm, first);
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
  });
  const call = fetch.mock.calls.find(([input]) => new Request(input).url.includes("sign-up/email"));
  const body = z.string().parse(call?.[1]?.body);
  expect(JSON.parse(body)).toMatchObject({
    email: "person@example.com",
    name: "",
    password: first,
  });
});
it("sends verification-required sign-ups to email verification", async () => {
  const { view, fetch, navigate } = setup(true);
  const email = view.querySelector<HTMLInputElement>("#email");
  const password = view.querySelector<HTMLInputElement>("#password");
  const confirm = view.querySelector<HTMLInputElement>("#confirmPassword");
  const form = view.querySelector("form");
  if (email === null || password === null || confirm === null || form === null) {
    throw new Error("Missing sign-up controls");
  }
  email.value = "verify@example.com";
  const value = crypto.randomUUID();
  fill(password, value);
  fill(confirm, value);
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalled();
    });
  });
  expect(fetch).toHaveBeenCalled();
  expect(sessionStorage.getItem("better-auth-ui.verify-email")).toBe("verify@example.com");
  expect(navigate.mock.calls[0]?.[0].to).toContain("verify-email");
});
